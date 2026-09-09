/**
 * BMAD Orchestrator — executes an approved graph and narrates every step.
 *
 * Emits an event for every state change so the UI can show the run as it happens (SSE), and
 * persists the same events so a refresh, or opening the run tomorrow, shows the identical timeline.
 */
import { EventEmitter } from 'node:events';
import { collection } from '../lib/store.js';
import { resolveImpl } from './agents.js';
import { runGuardrails, verdictOf } from './validator.js';
import { buildTrace, buildMarkdown } from './reporter.js';
import { getSettings, resolveModel } from '../lib/settings.js';
import { llmAvailable } from '../lib/llm.js';
import { id, now, sleep } from '../lib/util.js';

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

function emit(run, event) {
  const payload = { seq: run.events.length + 1, at: now(), ...event };
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

  try {
    for (const node of run.nodes) {
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
    }

    emit(run, { type: 'validation:start', message: `Running ${run.guardrails.length} guardrail(s) against ${ws.generated.length} artifact(s).` });

    const results = runGuardrails(run.guardrails, { discovery: run.discovery, ws, run });
    for (const result of results) {
      emit(run, {
        type: 'guardrail',
        status: result.status,
        guardrailId: result.guardrailId,
        message: `${result.status === 'pass' ? '✔' : result.status === 'warn' ? '▲' : '✖'} ${result.name}: ${result.evidence}`,
      });
    }

    run.validation = { verdict: verdictOf(results), results, at: now() };
    run.ws = { ...ws, generated: ws.generated };
    run.trace = buildTrace(run);
    run.report = buildMarkdown(project, run);
    run.status = run.nodes.some((n) => n.status === 'failed') ? 'completed-with-errors' : 'completed';
    run.finishedAt = now();

    emit(run, {
      type: 'run:end',
      verdict: run.validation.verdict,
      message: `Run ${run.status}. Verdict: ${run.validation.verdict}. ${ws.generated.length} artifact(s), ${run.trace.counts.links} trace link(s).`,
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

export function deleteRunsForProject(projectId) {
  const keep = runs.all().filter((run) => run.projectId !== projectId);
  runs.replaceAll(keep);
}
