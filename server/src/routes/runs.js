import { Router } from 'express';
import { getRun, busFor, listRuns, recordApproval, prepareContinue, prepareRerun, prepareSubmission, executeRun } from '../engine/orchestrator.js';
import { HttpError, id, now } from '../lib/util.js';
import { collection } from '../lib/store.js';
import { planExport, performExport, EXPORTABLE_KINDS, ExportError } from '../lib/exporter.js';
import { logger } from '../lib/logger.js';

const router = Router();
const projects = collection('projects');

/** Decisions on a run belong on the project's decision trail too — that is where people look. */
function onTrail(projectId, entry) {
  projects.update(projectId, (project) => ({
    ...project,
    trail: [{ id: id('ev'), at: now(), actor: 'human', ...entry }, ...(project.trail || [])].slice(0, 400),
  }));
}

/** Fire and forget, like starting a run: the client follows progress on the SSE stream. */
function runInBackground(runId, project, options) {
  executeRun(runId, project, options)
    .then((finished) =>
      onTrail(project.id, {
        stage: 'run',
        actor: 'control-plane',
        action: 'run.finished',
        detail: `Run ${finished.id} ${finished.status}; verdict ${finished.validation?.verdict}.`,
      }),
    )
    .catch((err) => logger.error('run', `Run ${runId} could not execute: ${err.message}`, { runId }));
}

function runAndProject(runId) {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, 'Run not found.');
  const project = projects.find(run.projectId);
  if (!project) throw new HttpError(404, 'The project this run belongs to no longer exists.');
  return { run, project };
}

router.get('/', (req, res) => {
  res.json(listRuns(req.query.projectId));
});

router.get('/:runId', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) throw new HttpError(404, 'Run not found.');
  res.json(run);
});

/** Live event stream. Replays everything that already happened, then follows. */
router.get('/:runId/stream', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) throw new HttpError(404, 'Run not found.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of run.events) send(event);
  if (run.status !== 'running' && run.status !== 'queued') {
    send({ type: 'stream:end', at: new Date().toISOString(), replay: true });
  }

  const bus = busFor(run.id);
  const onEvent = (event) => send(event);
  bus.on('event', onEvent);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    bus.off('event', onEvent);
    res.end();
  });
});

/** The last gate in the flow: a person accepts the run, or sends it back for changes. */
router.post('/:runId/approval', (req, res) => {
  const { state, note, by } = req.body || {};
  if (!['approved', 'changes-requested'].includes(state)) {
    throw new HttpError(400, 'state must be "approved" or "changes-requested".');
  }
  const approval = recordApproval(req.params.runId, { state, note, by });
  if (!approval) throw new HttpError(404, 'Run not found.');
  onTrail(getRun(req.params.runId).projectId, {
    stage: 'run',
    action: state === 'approved' ? 'run.approved' : 'run.changes-requested',
    detail: `${approval.by} ${state === 'approved' ? 'approved' : 'requested changes on'} run ${req.params.runId}${note ? `: ${note}` : '.'}`,
  });
  res.json(approval);
});

/**
 * Override a guardrail's stop and carry on. The same run continues from the agent after the one
 * that stopped it; everything already produced is kept.
 */
router.post('/:runId/continue', (req, res) => {
  const { note = '', by = 'human' } = req.body || {};
  const { project } = runAndProject(req.params.runId);
  const run = prepareContinue(req.params.runId, project, { note, by });
  const decision = run.decisions.at(-1);
  onTrail(project.id, {
    stage: 'run',
    action: 'run.continued',
    detail: `${by} overrode "${decision.guardrail}" and continued run ${run.id}${note ? `: ${note}` : '.'}`,
  });
  runInBackground(run.id, project, { resume: true });
  res.status(202).json({ runId: run.id, continuing: decision.agents, overrode: decision.guardrail });
});

/**
 * The coding assistant hands back the files for the agent step the run was waiting on. The run
 * carries on from there.
 */
router.post('/:runId/nodes/:nodeId/submit', (req, res) => {
  const { files, notes = [], by = 'your coding assistant' } = req.body || {};
  const { project } = runAndProject(req.params.runId);
  const run = prepareSubmission(req.params.runId, req.params.nodeId, { files, notes, by });
  const node = run.nodes.find((n) => n.nodeId === req.params.nodeId);
  onTrail(project.id, {
    stage: 'run',
    actor: 'assistant',
    action: 'run.handoff-returned',
    detail: `${by} handed back ${node.outputs.length} file(s) for "${node.name}" in run ${run.id}.`,
  });
  runInBackground(run.id, project, { resume: true });
  res.status(202).json({ runId: run.id, nodeId: node.nodeId, files: node.outputs.map((o) => o.path) });
});

/**
 * Redo the work from one agent after changes. A new run reuses every unchanged agent before it and
 * runs that agent and everything after it again.
 */
router.post('/:runId/rerun', (req, res) => {
  const { fromNodeId, note = '', by = 'human' } = req.body || {};
  const { run: previous, project } = runAndProject(req.params.runId);
  const wasUndecided = !previous.approval || previous.approval.state === 'pending';
  const { run, plan } = prepareRerun(previous.id, project, { fromNodeId, note, by });
  // Asking for a re-run of an undecided run is also a request for changes; the trail shows both.
  if (wasUndecided) {
    onTrail(project.id, {
      stage: 'run',
      action: 'run.changes-requested',
      detail: `${by} requested changes on run ${previous.id}${note ? `: ${note}` : '.'}`,
    });
  }
  onTrail(project.id, {
    stage: 'run',
    action: 'run.rerun',
    detail: `${by} re-ran ${previous.id} as ${run.id}${plan.fromName ? ` from "${plan.fromName}"` : ''}; ${plan.pairs.length} agent(s) reused unchanged.${note ? ` Note: ${note}` : ''}`,
  });
  runInBackground(run.id, project);
  res.status(202).json({ runId: run.id, from: plan.fromName, reused: plan.pairs.map((pair) => pair.next.name), reasons: plan.reasons });
});

/**
 * Write the run's artifacts into a folder on disk — normally the target repository.
 *
 * `dryRun` is the default path the UI uses first: it returns the exact file plan so a person can
 * see what would be created, what already exists, and what was blocked, before anything is written.
 */
router.post('/:runId/export', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) throw new HttpError(404, 'Run not found.');
  if (!(run.ws?.generated || []).length) throw new HttpError(409, 'This run produced no artifacts to export.');

  const { targetDir, include, overwrite = false, dryRun = true } = req.body || {};
  const options = { targetDir, include, overwrite };

  const result = dryRun ? planExport(run, options) : performExport(run, options);
  if (!dryRun) {
    logger.info('run', `Exported ${result.written.length} file(s) to ${result.root}`, {
      runId: run.id,
      projectId: run.projectId,
      written: result.written.length,
      skipped: result.skipped.length,
      failed: result.errors.length,
    });
  }
  res.json({ dryRun, kinds: EXPORTABLE_KINDS, ...result });
});

router.get('/:runId/report.md', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) throw new HttpError(404, 'Run not found.');
  res.type('text/markdown').send(run.report || '# Report not available yet');
});

router.get('/:runId/artifacts/:artifactId', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) throw new HttpError(404, 'Run not found.');
  const artifact = (run.ws?.generated || []).find((a) => a.id === req.params.artifactId || a.path === req.params.artifactId);
  if (!artifact) throw new HttpError(404, 'Artifact not found.');
  res.json(artifact);
});

/** Everything the run produced, as one JSON bundle the user can save. */
router.get('/:runId/bundle.json', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) throw new HttpError(404, 'Run not found.');
  res.json({
    run: { id: run.id, project: run.projectName, status: run.status, verdict: run.validation?.verdict, startedAt: run.startedAt, finishedAt: run.finishedAt },
    discovery: run.discovery,
    answers: run.answers,
    nodes: run.nodes,
    guardrails: run.validation?.results,
    trace: run.trace,
    artifacts: run.ws?.generated || [],
    report: run.report,
  });
});

export default router;
