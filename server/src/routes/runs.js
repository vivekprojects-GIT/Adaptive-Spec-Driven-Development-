import { Router } from 'express';
import { getRun, busFor, listRuns, recordApproval } from '../engine/orchestrator.js';
import { HttpError } from '../lib/util.js';

const router = Router();

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
  res.json(approval);
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
