/**
 * ASDD Orchestrator — executes an approved graph and narrates every step.
 *
 * Emits an event for every state change so the UI can show the run as it happens (SSE), and
 * persists the same events so a refresh, or opening the run tomorrow, shows the identical timeline.
 *
 * A run also picks up from a human decision instead of starting over:
 *   - continue — a guardrail halted the run and a person overrode the stop. The SAME run carries on
 *                from the agent after the one that stopped it, keeping everything already produced.
 *   - re-run   — a person requested changes. A NEW run reuses every agent before the changed one,
 *                untouched, and runs that agent and everything after it again.
 */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { collection } from '../lib/store.js';
import { resolveImpl, makeArtifact, safeOutputPath } from './agents.js';
import { runGuardrails, verdictOf, shouldHalt } from './validator.js';
import { buildTrace, buildPlanTrace, buildMarkdown } from './reporter.js';
import { composeWorkflow } from './workflowComposer.js';
import { getSettings, resolveModel, assistantHandoff } from '../lib/settings.js';
import { llmAvailable } from '../lib/llm.js';
import { HttpError, id, now, sleep } from '../lib/util.js';
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

/** Everything an agent reads besides the graph. If this changes, earlier output is no longer valid. */
function inputsHash(project) {
  const inputs = { spec: project.spec || null, answers: project.interview?.answers || {}, discovery: project.discovery || null };
  return createHash('sha1').update(JSON.stringify(inputs)).digest('hex');
}

const nodeKey = (node) => node.proposalId || node.agentId;

/** What makes two nodes "the same agent doing the same job" — not its position or its node id. */
const fingerprint = (node) =>
  JSON.stringify({
    key: nodeKey(node),
    impl: node.impl,
    capability: node.capability,
    inputs: node.inputs || [],
    outputs: node.outputs || [],
    authored: node.authored || null,
  });

/** True when accepted agents were added, removed or edited since the workflow was last composed. */
export function workflowOutOfDate(project) {
  const accepted = (project.proposals?.agents || []).filter((agent) => agent.decision === 'accepted');
  const signature = (graph) => (graph?.order || []).map((nodeId) => fingerprint(graph.nodes.find((n) => n.nodeId === nodeId))).join('\n');
  return signature(composeWorkflow(accepted)) !== signature(project.graph);
}

export function createRun(project, { rerun = null } = {}) {
  const graph = project.graph;
  const acceptedGuardrails = (project.proposals?.guardrails || []).filter((g) => g.decision === 'accepted');

  const nodes = graph.order.map((nodeId) => {
    const node = graph.nodes.find((n) => n.nodeId === nodeId);
    return { ...node, status: 'pending', ms: null, metrics: null, notes: [], outputs: [] };
  });
  const carry = rerun ? seedFromPrevious(rerun, nodes, acceptedGuardrails) : null;

  const run = {
    id: id('run'),
    projectId: project.id,
    projectName: project.name,
    status: 'queued',
    startedAt: now(),
    finishedAt: null,
    // Only claim a model was used when one could actually be reached.
    modelUsed: llmAvailable() ? resolveModel('generation') : assistantHandoff() ? resolveModel('generation') : null,
    discovery: project.discovery,
    answers: project.interview?.answers || {},
    inputsHash: inputsHash(project),
    graphId: graph.id,
    // The graph as it was when this run started, so the run view never draws a later recomposition.
    graph: { id: graph.id, nodes: graph.nodes, edges: graph.edges, layers: graph.layers, order: graph.order, errors: graph.errors || [] },
    nodes,
    guardrails: acceptedGuardrails,
    events: [],
    ws: { generated: [], sourceModel: null },
    // Which agent last wrote each piece of shared state — what lets a re-run reuse it safely.
    wsWriters: {},
    // What a re-run carries over from the run it re-runs, applied as each reused agent is reached.
    carry,
    decisions: [],
    rerunOf: rerun
      ? {
          runId: rerun.previous.id,
          requestedFrom: rerun.requestedName,
          from: rerun.fromName,
          reused: rerun.pairs.map((pair) => pair.next.name),
          reasons: rerun.reasons,
        }
      : null,
    validation: null,
    trace: null,
    report: null,
  };
  runs.insert(run);
  return run;
}

/**
 * Which agents a re-run can reuse. Only an unbroken prefix of the workflow qualifies: the same
 * agents, unchanged, in the same order, each finished in the previous run — so every reused output
 * was produced from exactly the upstream it would be produced from now. It stops at the requested
 * agent, or earlier if something before it changed, and says why.
 */
export function planRerun(previous, project, fromNodeId) {
  const graph = project.graph;
  const next = graph.order.map((nodeId) => graph.nodes.find((n) => n.nodeId === nodeId));
  const requested = previous.nodes.find((n) => n.nodeId === fromNodeId) || defaultRerunNode(previous);
  const reasons = [];
  const plan = (pairs, fromNode) => ({ previous, pairs, fromName: fromNode?.name || null, requestedName: requested?.name || null, reasons });
  // A run node's `outputs` is what it produced; the agent's definition is in the run's graph snapshot.
  const definition = (node) => previous.graph?.nodes?.find((n) => n.nodeId === node.nodeId) || node;

  if (!previous.wsWriters) {
    reasons.push('That run predates partial re-runs, so every agent runs again.');
    return plan([], next[0]);
  }
  if (previous.inputsHash !== inputsHash(project)) {
    reasons.push(
      'The spec, source files, interview answers or discovery changed since that run, so every agent runs again — reusing earlier output would mix two versions.',
    );
    return plan([], next[0]);
  }

  const pairs = [];
  for (let index = 0; index < next.length; index += 1) {
    const candidate = next[index];
    const before = previous.nodes[index];
    if (requested && nodeKey(candidate) === nodeKey(requested)) return plan(pairs, candidate);

    if (!before) {
      reasons.push(`"${candidate.name}" is new in the workflow, so the re-run starts there.`);
      return plan(pairs, candidate);
    }
    if (requested && nodeKey(before) === nodeKey(requested)) {
      reasons.push(`"${requested.name}" is no longer in the workflow, so the re-run starts at "${candidate.name}", the agent now in its place.`);
      return plan(pairs, candidate);
    }
    if (nodeKey(before) !== nodeKey(candidate)) {
      reasons.push(`The workflow changed at "${candidate.name}", so the re-run starts there.`);
      return plan(pairs, candidate);
    }
    if (fingerprint(definition(before)) !== fingerprint(candidate)) {
      reasons.push(`"${candidate.name}" changed since that run, so the re-run starts there${requested ? ` rather than at "${requested.name}"` : ''}.`);
      return plan(pairs, candidate);
    }
    if (before.status !== 'done') {
      reasons.push(`"${candidate.name}" did not finish in that run (${before.status}), so the re-run starts there.`);
      return plan(pairs, candidate);
    }
    pairs.push({ prev: before, next: candidate });
  }

  reasons.push(`"${requested?.name}" is no longer in the workflow and every agent is unchanged, so only the guardrails run again.`);
  return plan(pairs, null);
}

/** Where a re-run should start if nobody says: the agent whose check stopped it, or the first that failed. */
export function defaultRerunNode(run) {
  const stopper = (run.guardrails || []).find((g) => (g.guardrailId || g.id) === run.validation?.haltedBy);
  const haltedAt = stopper && run.nodes.find((n) => n.agentId === stopper.appliesTo || n.nodeId === stopper.appliesTo);
  return haltedAt || run.nodes.find((n) => n.status === 'failed') || run.nodes.find((n) => n.metrics?.placeholder) || run.nodes[0] || null;
}

/**
 * Marks the reused agents and gathers what they carry over — artifacts, shared state, and the
 * verdicts of their unchanged scoped checks, overrides included — re-keyed to the new node ids.
 * Nothing is applied yet: each piece lands when the run reaches its agent, so a check never sees
 * work from agents after it, and an agent the run never reaches carries nothing over.
 */
function seedFromPrevious({ previous, pairs }, nodes, guardrails) {
  const idMap = new Map(pairs.map(({ prev, next }) => [prev.nodeId, next.nodeId]));
  for (const { prev, next } of pairs) {
    const node = nodes.find((n) => n.nodeId === next.nodeId);
    Object.assign(node, {
      status: 'reused',
      reusedFrom: previous.id,
      ms: prev.ms,
      metrics: prev.metrics,
      notes: prev.notes || [],
      outputs: prev.outputs || [],
    });
  }

  const state = {};
  const writers = {};
  for (const [key, writer] of Object.entries(previous.wsWriters || {})) {
    if (!idMap.has(writer)) continue;
    state[key] = previous.ws?.[key];
    writers[key] = idMap.get(writer);
  }

  // An unchanged check on an unchanged agent reaches the same verdict on the same output. Carrying
  // it over keeps the decision a person already made on it, instead of stopping them again.
  const guardrailOf = (list, guardrailId) => (list || []).find((g) => (g.guardrailId || g.id) === guardrailId);
  const unchanged = (guardrailId) => {
    const before = guardrailOf(previous.guardrails, guardrailId);
    const current = guardrailOf(guardrails, guardrailId);
    return Boolean(before && current) && JSON.stringify(before) === JSON.stringify(current);
  };
  const reusedTargets = new Set(pairs.flatMap(({ prev }) => [prev.agentId, prev.nodeId]));
  const results = (previous.validation?.results || [])
    .filter((result) => {
      const guardrail = guardrailOf(previous.guardrails, result.guardrailId);
      return guardrail?.appliesTo && guardrail.appliesTo !== 'workflow' && reusedTargets.has(guardrail.appliesTo) && unchanged(result.guardrailId);
    })
    .map((result) => ({ ...result, carriedFrom: result.carriedFrom || previous.id }));

  return {
    artifacts: (previous.ws?.generated || []).filter((a) => idMap.has(a.producedBy)).map((a) => ({ ...a, producedBy: idMap.get(a.producedBy) })),
    state,
    writers,
    results,
  };
}

const LOG_LEVEL_FOR = {
  'node:failed': 'error',
  'run:halted': 'error',
  'node:skipped': 'warn',
  'run:continued': 'warn',
  'node:waiting': 'warn',
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

/**
 * Runs every pending agent in order. With `resume`, it is carrying on a halted run: agents that
 * already finished keep their output and their checks, and only the skipped ones run.
 */
export async function executeRun(runId, project, { resume = false } = {}) {
  const run = runs.find(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const toRun = run.nodes.filter((n) => n.status === 'pending').length;
  const toReuse = run.nodes.filter((n) => n.status === 'reused').length;
  run.status = 'running';
  run.wsWriters = run.wsWriters || {};
  emit(
    run,
    resume
      ? { type: 'run:resumed', message: `▶ Continuing: ${toRun} agent(s) left to run; ${run.nodes.length - toRun} already finished and kept.` }
      : {
          type: 'run:start',
          message: `Executing ${toRun} agent(s)${toReuse ? `, reusing ${toReuse} unchanged from ${run.rerunOf?.runId}` : ''} for ${run.discovery.source.label} → ${run.discovery.target.label}.`,
        },
  );

  // A fresh run starts empty; a continue or a re-run starts from what was already produced.
  const ws = {
    sourceModel: null,
    placeholders: 0,
    ...(run.ws || {}),
    generated: [...(run.ws?.generated || [])],
  };

  // Guardrails scoped to a single agent run the moment that agent finishes, so "stop the workflow
  // and request review" can actually stop it instead of reporting a failure after the fact.
  const scopedFor = (node) =>
    run.guardrails.filter(
      (guardrail) => guardrail.appliesTo && guardrail.appliesTo !== 'workflow' && (guardrail.appliesTo === node.agentId || guardrail.appliesTo === node.nodeId),
    );

  // On a continue, the checks already made on finished agents stand — including the overridden one.
  const finishedScoped = new Set(
    run.nodes
      .filter((n) => (n.status === 'done' || n.status === 'failed') && !n.checksPending)
      .flatMap((n) => scopedFor(n).map((g) => g.guardrailId || g.id)),
  );
  const earlyResults = resume ? (run.validation?.results || []).filter((r) => finishedScoped.has(r.guardrailId)) : [];
  let halted = null;
  let waitingOn = null;
  let judging = null;

  // An agent step, or a verdict on a plain-English rule, is with the user's coding assistant. The
  // run is neither finished nor failed: nothing more is checked or offered for approval until the
  // answer is back. Checks already made stand.
  const pause = (waitingFor, message) => {
    run.status = 'waiting';
    run.waitingFor = waitingFor;
    run.ws = { ...ws, generated: ws.generated };
    run.validation = { verdict: null, results: earlyResults, haltedBy: null, overrides: [], partial: true, at: now() };
    run.approval = null;
    emit(run, { type: 'run:waiting', nodeId: waitingFor.nodeId || null, message });
    runs.update(run.id, run);
    busFor(run.id).emit('event', { type: 'stream:end', at: now() });
    return runs.find(run.id);
  };

  try {
    for (const node of run.nodes) {
      if (resume && (node.status === 'done' || node.status === 'failed') && !node.checksPending) continue;
      if (halted) {
        if (node.status === 'reused') {
          // Never reached, so nothing of it carries over: it is simply an agent that did not run.
          delete node.reusedFrom;
          Object.assign(node, { ms: null, metrics: null, notes: [], outputs: [] });
        }
        node.status = 'skipped';
        emit(run, { type: 'node:skipped', nodeId: node.nodeId, agent: node.name, message: `⊘ ${node.name} skipped — the run was halted.` });
        continue;
      }

      const reusedHere = node.status === 'reused';
      const submittedHere = node.status === 'submitted';
      const recheckHere = Boolean(node.checksPending) && (node.status === 'done' || node.status === 'failed');
      if (reusedHere) {
        node.status = 'done';
        const carry = run.carry || {};
        ws.generated.push(...(carry.artifacts || []).filter((a) => a.producedBy === node.nodeId));
        for (const [key, writer] of Object.entries(carry.writers || {})) {
          if (writer !== node.nodeId) continue;
          ws[key] = carry.state[key];
          run.wsWriters[key] = node.nodeId;
        }
        if (node.metrics?.placeholder) ws.placeholders = (ws.placeholders || 0) + 1;
        emit(run, {
          type: 'node:reused',
          nodeId: node.nodeId,
          agent: node.name,
          outputs: node.outputs,
          message: `↺ ${node.name} reused from ${node.reusedFrom} — unchanged since that run; ${node.outputs.length} artifact(s) carried over.`,
        });
      } else if (recheckHere) {
        // It already ran. Only its checks were waiting on the assistant's verdict; they run below.
      } else if (submittedHere) {
        // The coding assistant did this step and handed its files back; its checks run below.
        node.status = 'done';
        emit(run, {
          type: 'node:done',
          nodeId: node.nodeId,
          agent: node.name,
          ms: node.ms,
          metrics: node.metrics,
          outputs: node.outputs,
          message: `✔ ${node.name} finished by your coding assistant — ${node.outputs.length} artifact(s).`,
        });
      } else {
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
          run,
          notes,
          log: (message) => emit(run, { type: 'node:log', nodeId: node.nodeId, agent: node.name, message }),
        };
        const before = { ...ws };

        try {
          const impl = resolveImpl(node.impl);
          const result = await impl(ctx);
          if (result.handoff) {
            // This step is for the user's coding assistant. The run stops here, unfinished and
            // unfailed, and carries on when the assistant hands its files back.
            node.status = 'waiting';
            node.ms = Date.now() - started;
            node.notes = notes;
            node.handoff = { ...result.handoff, at: now() };
            waitingOn = node;
            emit(run, {
              type: 'node:waiting',
              nodeId: node.nodeId,
              agent: node.name,
              message: `⧗ ${node.name} handed to your coding assistant — the run waits for its work.`,
            });
          } else {
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
          }
        } catch (err) {
          node.status = 'failed';
          node.ms = Date.now() - started;
          node.error = err.message;
          emit(run, { type: 'node:failed', nodeId: node.nodeId, agent: node.name, message: `✖ ${node.name} failed: ${err.message}` });
        }

        for (const key of Object.keys(ws)) {
          if (key !== 'generated' && key !== 'placeholders' && ws[key] !== before[key]) run.wsWriters[key] = node.nodeId;
        }
      }

      if (waitingOn) break;
      delete node.checksPending;

      const scoped = scopedFor(node);
      if (scoped.length) {
        const carried = reusedHere ? (run.carry?.results || []).filter((r) => scoped.some((g) => (g.guardrailId || g.id) === r.guardrailId)) : [];
        const fresh = scoped.filter((g) => !carried.some((r) => r.guardrailId === (g.guardrailId || g.id)));
        emit(run, {
          type: 'validation:start',
          nodeId: node.nodeId,
          message: `Checking ${fresh.length} guardrail(s) scoped to ${node.name}${carried.length ? `; ${carried.length} carried over unchanged from ${node.reusedFrom}` : ''}.`,
        });
        const scopedResults = [...carried, ...(fresh.length ? await runGuardrails(fresh, { discovery: run.discovery, ws, run }) : [])];
        const pending = scopedResults.filter((r) => r.status === 'pending');
        if (pending.length) {
          // A rule on this agent needs the assistant's verdict before the run can know whether to
          // stop here. The agent's work stands; its checks run again, with the verdict, on resume.
          node.checksPending = true;
          judging = { nodeId: node.nodeId, agent: node.name, items: pending };
          break;
        }
        earlyResults.push(...scopedResults);
        for (const result of scopedResults) emitGuardrail(run, result);

        // A stop a person already overrode was decided; it does not stop them again.
        halted = shouldHalt(scopedResults.filter((r) => !r.overridden));
        if (halted) {
          emit(run, {
            type: 'run:halted',
            message: `■ Run halted by "${halted.name}" — its author asked for the workflow to stop and request review.`,
          });
        }
      }
    }

    if (waitingOn) {
      return pause(
        { kind: 'agent', nodeId: waitingOn.nodeId, agent: waitingOn.name },
        `⧗ Waiting on your coding assistant for "${waitingOn.name}". In VS Code it does this step and hands the files back; the run then carries on.`,
      );
    }
    if (judging) {
      return pause(
        { kind: 'judgement', nodeId: judging.nodeId, agent: judging.agent, items: judging.items.map(judgementItem) },
        `⚖ Waiting on your coding assistant to judge ${judging.items.length} rule(s) on "${judging.agent}": ${judging.items.map((r) => r.name).join(', ')}.`,
      );
    }

    const remaining = run.guardrails.filter((guardrail) => !earlyResults.some((r) => (guardrail.guardrailId || guardrail.id) === r.guardrailId));
    emit(run, { type: 'validation:start', message: `Running ${remaining.length} workflow-level guardrail(s) against ${ws.generated.length} artifact(s).` });

    let lateResults = await runGuardrails(remaining, { discovery: run.discovery, ws, run });
    const latePending = lateResults.filter((r) => r.status === 'pending');
    if (latePending.length && !halted) {
      return pause(
        { kind: 'judgement', nodeId: null, agent: null, items: latePending.map(judgementItem) },
        `⚖ Waiting on your coding assistant to judge ${latePending.length} workflow rule(s): ${latePending.map((r) => r.name).join(', ')}.`,
      );
    }
    // A halted run reports what it can; a rule nobody got to judge says so, and never reads as passing.
    lateResults = lateResults.map((r) =>
      r.status === 'pending' ? { ...r, status: 'warn', evidence: 'Not judged: the run halted before it reached the end.', judgement: undefined } : r,
    );
    for (const result of lateResults) emitGuardrail(run, result);

    const results = [...earlyResults, ...lateResults];
    // An overridden check still failed; the person decided the run may go on anyway. It no longer
    // blocks, but the run can never read as clean.
    const overrides = results.filter((r) => r.overridden);
    let verdict = halted ? 'blocked' : verdictOf(results.filter((r) => !r.overridden));
    if (!halted && overrides.length && verdict === 'passed') verdict = 'passed-with-warnings';

    run.validation = {
      verdict,
      results,
      haltedBy: halted?.guardrailId || null,
      overrides: overrides.map((r) => ({ guardrailId: r.guardrailId, name: r.name, ...r.overridden })),
      at: now(),
    };
    run.ws = { ...ws, generated: ws.generated };
    run.trace = buildTrace(run);
    if (run.discovery?.projectKind === 'build') run.planTrace = buildPlanTrace(run);
    run.report = buildMarkdown(project, run);
    run.status = halted ? 'halted' : run.nodes.some((n) => n.status === 'failed') ? 'completed-with-errors' : 'completed';
    run.finishedAt = now();
    run.rerunSuggestion = defaultRerunNode(run)?.nodeId || null;
    run.waitingFor = null;

    const skipped = run.nodes.filter((n) => n.status === 'skipped').length;
    run.approval = {
      state: 'pending',
      required: true,
      reason: halted
        ? `Halted by "${halted.name}" after ${skipped} agent(s) were left unrun. Continue past the stop, or request changes — it cannot be approved as it stands.`
        : overrides.length
          ? `Continued past ${overrides.map((o) => `"${o.name}" by ${o.overridden.by}${o.carriedFrom ? ` (in ${o.carriedFrom})` : ''}`).join(', ')}. ${overrides.length === 1 ? 'That check' : 'Those checks'} still failed — the evidence is in the verdicts. Approve only if you accept that.`
          : 'Every run ends with a human decision. Nothing is accepted until someone approves it.',
    };

    emit(run, {
      type: 'run:end',
      verdict: run.validation.verdict,
      message: `Run ${run.status}. Verdict: ${run.validation.verdict}. ${ws.generated.length} artifact(s), ${run.trace.counts.links} trace link(s). ${
        halted ? 'Waiting for a human: continue past the stop, or request changes.' : 'Awaiting human approval.'
      }`,
    });
  } catch (err) {
    run.status = 'failed';
    run.finishedAt = now();
    emit(run, { type: 'run:end', message: `Run failed: ${err.message}` });
  }

  // Everything carried over has landed (or was never reached); the copy is not needed any more.
  run.carry = null;
  runs.update(run.id, run);
  busFor(run.id).emit('event', { type: 'stream:end', at: now() });
  return runs.find(run.id);
}

function emitGuardrail(run, result) {
  emit(run, {
    type: 'guardrail',
    status: result.status,
    guardrailId: result.guardrailId,
    message: `${result.status === 'pass' ? '✔' : result.status === 'warn' ? '▲' : '✖'} ${result.name}: ${result.evidence}${
      result.carriedFrom ? ` — carried over from ${result.carriedFrom}${result.overridden ? `, stop overridden by ${result.overridden.by}` : ''}` : ''
    }`,
  });
}

function assertDecidable(run) {
  if (run.status === 'waiting') {
    throw new HttpError(409, 'The run is waiting on your coding assistant for an agent step. Hand its work back first (asdd submit), then decide.');
  }
  if (run.status === 'running' || run.status === 'queued') throw new HttpError(409, 'The run is still going — decide once it has finished.');
  if (run.approval?.state && run.approval.state !== 'pending') {
    throw new HttpError(409, `This run was already decided: ${run.approval.state} by ${run.approval.by}.`);
  }
}

/** The final gate in the flow: a person accepts the run, or sends it back. */
export function recordApproval(runId, { state, note, by = 'human' }) {
  const run = runs.find(runId);
  if (!run) return null;
  assertDecidable(run);
  if (state === 'approved' && run.status === 'halted') {
    const skipped = run.nodes.filter((n) => n.status === 'skipped').length;
    throw new HttpError(
      409,
      `This run was halted and ${skipped} agent(s) never ran, so it cannot be approved as it stands. Continue it past the stop, or request changes.`,
    );
  }

  const at = now();
  const approval = { ...(run.approval || {}), state, note: note || '', by, at, required: true };
  run.approval = approval;
  run.decisions = [...(run.decisions || []), { type: state, by, note: note || '', at }];
  runs.update(runId, { approval, decisions: run.decisions });
  emit(run, {
    type: 'approval',
    message: `${state === 'approved' ? '✔ Approved' : '↩ Changes requested'} by ${by}${note ? `: ${note}` : '.'}`,
  });
  return approval;
}

/**
 * A person overrides a guardrail's stop. The SAME run carries on from where it halted: what already
 * ran is kept, the skipped agents run, and the override is recorded against that person. Call
 * executeRun(runId, project, { resume: true }) next.
 */
export function prepareContinue(runId, project, { note = '', by = 'human' } = {}) {
  const run = runs.find(runId);
  if (!run) throw new HttpError(404, 'Run not found.');
  if (run.status !== 'halted') throw new HttpError(409, `Only a halted run can be continued — this one is ${run.status}.`);
  assertDecidable(run);
  if (!project) throw new HttpError(409, 'The project this run belongs to no longer exists.');
  if (run.inputsHash && run.inputsHash !== inputsHash(project)) {
    throw new HttpError(
      409,
      'The spec, source files, interview answers or discovery changed since this run halted, so continuing it would mix two versions. Request changes and re-run instead.',
    );
  }

  const at = now();
  const stopped = (run.validation?.results || []).find((r) => r.guardrailId === run.validation?.haltedBy);
  if (stopped) stopped.overridden = { by, note, at };
  const skipped = run.nodes.filter((n) => n.status === 'skipped');
  for (const node of skipped) node.status = 'pending';

  run.decisions = [
    ...(run.decisions || []),
    { type: 'continued', by, note, at, guardrailId: stopped?.guardrailId || null, guardrail: stopped?.name || null, agents: skipped.map((n) => n.name) },
  ];
  run.approval = null;
  run.status = 'queued';
  run.resumedAt = at;
  runs.update(run.id, run);
  emit(run, {
    type: 'run:continued',
    message: `▶ ${by} overrode "${stopped?.name || 'the stop'}" and continued the run${note ? `: ${note}` : '.'} ${skipped.length} agent(s) will now run.`,
  });
  return run;
}

/**
 * A person has made their changes and wants the work redone from a given agent. Creates a NEW run
 * that reuses the unchanged agents before it (see planRerun). Asking for a re-run is itself a
 * request for changes, so an undecided run is marked that way first.
 */
export function prepareRerun(previousId, project, { fromNodeId, note = '', by = 'human' } = {}) {
  let previous = runs.find(previousId);
  if (!previous) throw new HttpError(404, 'Run not found.');
  if (previous.status === 'running' || previous.status === 'queued') throw new HttpError(409, 'The run is still going — wait for it to finish.');
  if (previous.status === 'waiting') throw new HttpError(409, 'The run is waiting on your coding assistant. Hand its work back first (asdd submit).');
  if (previous.supersededBy) throw new HttpError(409, `This run was already re-run as ${previous.supersededBy}.`);
  if (previous.approval?.state === 'approved') throw new HttpError(409, 'This run was approved. Start a new run instead.');
  if (!project) throw new HttpError(409, 'The project this run belongs to no longer exists.');
  if (!project.graph?.order?.length) throw new HttpError(409, 'Compose a workflow before re-running.');
  if ((project.graph.errors || []).some((e) => e.startsWith('Cycle detected'))) throw new HttpError(409, 'The composed graph has a cycle and cannot be executed.');
  if (workflowOutOfDate(project)) {
    throw new HttpError(409, 'Your agent changes are not in the workflow yet. Recompose it on the Workflow step, then re-run.');
  }

  if (previous.approval?.state !== 'changes-requested') recordApproval(previousId, { state: 'changes-requested', note, by });
  previous = runs.find(previousId);

  const plan = planRerun(previous, project, fromNodeId);
  const run = createRun(project, { rerun: plan });

  const decisions = [...(previous.decisions || []), { type: 'rerun', by, note, at: now(), runId: run.id, from: plan.fromName, reused: plan.pairs.length }];
  runs.update(previous.id, { supersededBy: run.id, decisions });
  previous = runs.find(previousId);
  emit(previous, {
    type: 'run:rerun',
    message: `↻ Re-run as ${run.id}${plan.fromName ? ` from "${plan.fromName}"` : ''} by ${by} — ${plan.pairs.length} agent(s) reused unchanged.`,
  });
  return { run, plan };
}

/**
 * The coding assistant hands back the work for the step the run was waiting on. Its files become
 * that agent's output, the agent's scoped checks run on them, and the rest of the graph carries on.
 * Call executeRun(runId, project, { resume: true }) next.
 */
export function prepareSubmission(runId, nodeId, { files = [], notes = [], by = 'your coding assistant' } = {}) {
  const run = runs.find(runId);
  if (!run) throw new HttpError(404, 'Run not found.');
  const node = run.nodes.find((n) => n.nodeId === nodeId);
  if (run.status !== 'waiting' || node?.status !== 'waiting') {
    throw new HttpError(409, `Run ${runId} is not waiting on ${node ? `"${node.name}"` : `node ${nodeId}`} — it is ${run.status}.`);
  }
  const usable = (Array.isArray(files) ? files : []).filter((file) => file && typeof file.content === 'string' && file.content.trim());
  if (!usable.length) throw new HttpError(400, `Nothing to hand back for "${node.name}": no files with content. Write the files first, then submit.`);

  const outputDir = node.handoff?.outputDir || 'assistant';
  const outputs = usable.map((file) =>
    makeArtifact(safeOutputPath(file.path, outputDir), file.content, {
      kind: /\.(md|txt)$/i.test(file.path) ? 'spec' : 'code',
      producedBy: node.nodeId,
    }),
  );

  run.ws = { ...(run.ws || {}), generated: [...(run.ws?.generated || []), ...outputs] };
  Object.assign(node, {
    status: 'submitted',
    outputs: outputs.map((o) => ({ id: o.id, path: o.path, kind: o.kind, lines: o.lines, bytes: o.bytes })),
    metrics: { files: outputs.length, model: by, handedOff: true, bmad: node.handoff?.bmad?.id },
    notes: [...(node.notes || []), ...(Array.isArray(notes) ? notes : [notes]).filter(Boolean).map(String)],
  });
  node.handoff = { ...node.handoff, returnedAt: now(), by };
  run.waitingFor = null;
  run.status = 'queued';
  runs.update(run.id, run);
  emit(run, {
    type: 'node:submitted',
    nodeId,
    agent: node.name,
    message: `↩ ${by} handed back ${outputs.length} file(s) for "${node.name}": ${outputs.map((o) => o.path).join(', ')}.`,
  });
  return run;
}

/** What the assistant needs to judge one plain-English rule: the rule, its scope and the files. */
function judgementItem(result) {
  return {
    guardrailId: result.guardrailId,
    name: result.name,
    rule: result.rule || result.judgement?.rule,
    severity: result.severity,
    onFailure: result.onFailure,
    appliesTo: result.appliesTo,
    scope: result.judgement?.scope,
    artifacts: result.judgement?.artifacts || [],
    digest: result.judgement?.digest || '',
    facts: result.judgement?.facts || null,
  };
}

/**
 * The coding assistant's verdicts on the plain-English rules the run is waiting on. Each needs
 * evidence. Once every rule is judged the run resumes (call executeRun(…, { resume: true })): the
 * checks run again, find these verdicts, and a failed rule set to "stop" stops the run as it would
 * have with any other judge.
 * @returns {{ run, outstanding: Array }}
 */
export function prepareJudgement(runId, { verdicts = [], by = 'your coding assistant' } = {}) {
  const run = runs.find(runId);
  if (!run) throw new HttpError(404, 'Run not found.');
  if (run.status !== 'waiting' || run.waitingFor?.kind !== 'judgement') {
    throw new HttpError(409, `Run ${runId} is not waiting for a verdict on any rule — it is ${run.status}.`);
  }
  const items = run.waitingFor.items || [];
  const at = now();
  run.judgements = { ...(run.judgements || {}) };
  for (const verdict of Array.isArray(verdicts) ? verdicts : [verdicts]) {
    const item = items.find((i) => i.guardrailId === verdict?.guardrailId);
    if (!item) {
      throw new HttpError(400, `"${verdict?.guardrailId}" is not one of the rules waiting to be judged: ${items.map((i) => i.guardrailId).join(', ')}.`);
    }
    if (!['pass', 'warn', 'fail'].includes(verdict.status)) throw new HttpError(400, 'A verdict is pass, warn or fail.');
    if (!String(verdict.evidence || '').trim()) {
      throw new HttpError(400, `Say what the verdict on "${item.name}" rests on — quote the evidence you saw.`);
    }
    run.judgements[item.guardrailId] = { status: verdict.status, evidence: String(verdict.evidence).trim(), by, at };
  }

  const outstanding = items.filter((i) => !run.judgements[i.guardrailId]);
  const summary = (list) => list.map((i) => `"${i.name}" → ${run.judgements[i.guardrailId].status}`).join(', ');
  if (outstanding.length) {
    runs.update(run.id, { judgements: run.judgements });
    emit(run, { type: 'judgement', message: `⚖ ${by} judged ${summary(items.filter((i) => run.judgements[i.guardrailId]))}; ${outstanding.length} to go.` });
    return { run: runs.find(run.id), outstanding };
  }
  run.waitingFor = null;
  run.status = 'queued';
  runs.update(run.id, run);
  emit(run, { type: 'judgement', message: `⚖ ${by} judged ${summary(items)}. The run carries on.` });
  return { run, outstanding: [] };
}

export function deleteRunsForProject(projectId) {
  const keep = runs.all().filter((run) => run.projectId !== projectId);
  runs.replaceAll(keep);
}
