/**
 * BMAD Orchestrator — executes an approved graph and narrates every step.
 *
 * Emits an event for every state change so the UI can show the run as it happens (SSE), and
 * persists the same events so a refresh, or opening the run tomorrow, shows the identical timeline.
 */
import { EventEmitter } from 'node:events';
import { collection } from '../lib/store.js';
import { resolveImpl } from './agents.js';
import { runGuardrails, verdictOf, shouldHalt } from './validator.js';
import { buildTrace, buildMarkdown } from './reporter.js';
import { getSettings, resolveModel } from '../lib/settings.js';
import { llmAvailable } from '../lib/llm.js';
import { id, now, sleep } from '../lib/util.js';
import { logger } from '../lib/logger.js';

const runs = collection('runs');
const buses = new Map();

export function busFor(runId) {
  if (!buses.has(runId)) buses.set(runId, new EventEmitter().setMaxListeners(50));
  return buses.get(runId);
}

export function getRun(runId) {
  return runs.find(runId);
}

export function listRuns(projectId) {
  return runs.all().filter((run) => !projectId || run.projectId === projectId);
}

export function createRun(project) {
  const graph = project.graph;
  const acceptedGuardrails = (project.proposals?.guardrails || []).filter((g) => g.decision === 'accepted');

  const run = {
    id: id('run'),
    projectId: project.id,
    projectName: project.name,
    status: 'queued',
    startedAt: now(),
    finishedAt: null,
    // Only claim a model was used when one could actually be reached.
    modelUsed: llmAvailable() ? resolveModel('generation') : null,
    discovery: project.discovery,
    answers: project.interview?.answers || {},
    graphId: graph.id,
    nodes: graph.order.map((nodeId) => {
      const node = graph.nodes.find((n) => n.nodeId === nodeId);
      return { ...node, status: 'pending', ms: null, metrics: null, notes: [], outputs: [] };
    }),
    guardrails: acceptedGuardrails,
    events: [],
    ws: { generated: [], sourceModel: null },
    validation: null,
    trace: null,
    report: null,
  };
  runs.insert(run);
  return run;
}

const LOG_LEVEL_FOR = {
  'node:failed': 'error',
  'run:halted': 'error',
  'node:skipped': 'warn',
};

function emit(run, event) {
  const payload = { seq: run.events.length + 1, at: now(), ...event };
  const level = LOG_LEVEL_FOR[event.type] || (event.type === 'guardrail' && event.status !== 'pass' ? (event.status === 'fail' ? 'error' : 'warn') : 'info');
  logger[level]('run', payload.message || event.type, {
    projectId: run.projectId,
    runId: run.id,
    nodeId: event.nodeId || null,
    event: event.type,
    agent: event.agent || null,
    guardrailId: event.guardrailId || null,
  });
  run.events.push(payload);
  runs.update(run.id, { events: run.events, status: run.status, nodes: run.nodes });
  busFor(run.id).emit('event', payload);
  return payload;
}

export async function executeRun(runId, project) {
  const run = runs.find(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  run.status = 'running';
  emit(run, { type: 'run:start', message: `Executing ${run.nodes.length} agent(s) for ${run.discovery.source.label} → ${run.discovery.target.label}.` });

  const ws = {
    generated: [],
    sourceModel: null,
    placeholders: 0,
  };

  // Guardrails scoped to a single agent run the moment that agent finishes, so "stop the workflow
  // and request review" can actually stop it instead of reporting a failure after the fact.
  const scopedFor = (node) =>
    run.guardrails.filter(
      (guardrail) => guardrail.appliesTo && guardrail.appliesTo !== 'workflow' && (guardrail.appliesTo === node.agentId || guardrail.appliesTo === node.nodeId),
    );

  const earlyResults = [];
  let halted = null;

  try {
    for (const node of run.nodes) {
      if (halted) {
        node.status = 'skipped';
        emit(run, { type: 'node:skipped', nodeId: node.nodeId, agent: node.name, message: `⊘ ${node.name} skipped — the run was halted.` });
        continue;
      }
      const started = Date.now();
      node.status = 'running';
      emit(run, { type: 'node:start', nodeId: node.nodeId, agent: node.name, message: `▶ ${node.name} (${node.capability})` });
      await sleep(120); // keeps the live console readable rather than flashing past

      const notes = [];
      const ctx = {
        spec: project.spec,
        answers: run.answers,
        discovery: run.discovery,
        ws,
        node,
        notes,
        log: (message) => emit(run, { type: 'node:log', nodeId: node.nodeId, agent: node.name, message }),
      };

      try {
        const impl = resolveImpl(node.impl);
        const result = await impl(ctx);
        const outputs = (result.outputs || []).map((artifact) => ({ ...artifact, producedBy: node.nodeId }));
        ws.generated.push(...outputs);

        node.status = 'done';
        node.ms = Date.now() - started;
        node.metrics = result.metrics || {};
        node.notes = [...notes, ...(result.notes || [])];
        node.outputs = outputs.map((o) => ({ id: o.id, path: o.path, kind: o.kind, lines: o.lines, bytes: o.bytes }));

        emit(run, {
          type: 'node:done',
          nodeId: node.nodeId,
          agent: node.name,
          ms: node.ms,
          metrics: node.metrics,
          outputs: node.outputs,
          message: `✔ ${node.name} finished in ${node.ms}ms — ${outputs.length} artifact(s).`,
        });
      } catch (err) {
        node.status = 'failed';
        node.ms = Date.now() - started;
        node.error = err.message;
        emit(run, { type: 'node:failed', nodeId: node.nodeId, agent: node.name, message: `✖ ${node.name} failed: ${err.message}` });
      }

      const scoped = scopedFor(node);
      if (scoped.length) {
        emit(run, { type: 'validation:start', nodeId: node.nodeId, message: `Checking ${scoped.length} guardrail(s) scoped to ${node.name}.` });
        const scopedResults = await runGuardrails(scoped, { discovery: run.discovery, ws, run });
        earlyResults.push(...scopedResults);
        for (const result of scopedResults) emitGuardrail(run, result);

        halted = shouldHalt(scopedResults);
        if (halted) {
          emit(run, {
            type: 'run:halted',
            message: `■ Run halted by "${halted.name}" — its author asked for the workflow to stop and request review.`,
          });
        }
      }
    }

    const remaining = run.guardrails.filter((guardrail) => !earlyResults.some((r) => (guardrail.guardrailId || guardrail.id) === r.guardrailId));
    emit(run, { type: 'validation:start', message: `Running ${remaining.length} workflow-level guardrail(s) against ${ws.generated.length} artifact(s).` });

    const lateResults = await runGuardrails(remaining, { discovery: run.discovery, ws, run });
    for (const result of lateResults) emitGuardrail(run, result);

    const results = [...earlyResults, ...lateResults];
    run.validation = { verdict: halted ? 'blocked' : verdictOf(results), results, haltedBy: halted?.guardrailId || null, at: now() };
    run.ws = { ...ws, generated: ws.generated };
    run.trace = buildTrace(run);
    run.report = buildMarkdown(project, run);
    run.status = halted ? 'halted' : run.nodes.some((n) => n.status === 'failed') ? 'completed-with-errors' : 'completed';
    run.finishedAt = now();
    run.approval = {
      state: 'pending',
      required: true,
      reason: halted
        ? `Halted by "${halted.name}" — a human must review before anything is accepted.`
        : 'Every run ends with a human decision. Nothing is accepted until someone approves it.',
    };

    emit(run, {
      type: 'run:end',
      verdict: run.validation.verdict,
      message: `Run ${run.status}. Verdict: ${run.validation.verdict}. ${ws.generated.length} artifact(s), ${run.trace.counts.links} trace link(s). Awaiting human approval.`,
    });
  } catch (err) {
    run.status = 'failed';
    run.finishedAt = now();
    emit(run, { type: 'run:end', message: `Run failed: ${err.message}` });
  }

  runs.update(run.id, run);
  busFor(run.id).emit('event', { type: 'stream:end', at: now() });
  return runs.find(run.id);
}

function emitGuardrail(run, result) {
  emit(run, {
    type: 'guardrail',
    status: result.status,
    guardrailId: result.guardrailId,
    message: `${result.status === 'pass' ? '✔' : result.status === 'warn' ? '▲' : '✖'} ${result.name}: ${result.evidence}`,
  });
}

/** The final gate in the flow: a person accepts the run, or sends it back. */
export function recordApproval(runId, { state, note, by = 'human' }) {
  const run = runs.find(runId);
  if (!run) return null;
  const approval = {
    ...(run.approval || {}),
    state,
    note: note || '',
    by,
    at: now(),
    required: true,
  };
  runs.update(runId, { approval });
  busFor(runId).emit('event', {
    type: 'approval',
    at: now(),
    message: `${state === 'approved' ? '✔ Approved' : '↩ Changes requested'} by ${by}${note ? `: ${note}` : '.'}`,
  });
  return approval;
}

export function deleteRunsForProject(projectId) {
  const keep = runs.all().filter((run) => run.projectId !== projectId);
  runs.replaceAll(keep);
}
