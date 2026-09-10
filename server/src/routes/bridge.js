/**
 * HTTP side of the model bridge. The ASDD MCP process is the only intended caller.
 *
 * `status` is open so the Settings page can show whether an editor is connected; everything else
 * requires the bridge token, because answering a request here means speaking as the model.
 */
import { Router } from 'express';
import { bridgeStatus, heartbeat, takeNext, complete, requeue, tokenMatches } from '../lib/bridge.js';
import { asyncH } from '../lib/util.js';

const router = Router();

router.get('/status', (req, res) => res.json(bridgeStatus()));

router.use((req, res, next) => {
  if (!tokenMatches(req.get('x-asdd-bridge-token'))) {
    return res.status(401).json({ error: 'Bridge token missing or wrong. Only the ASDD MCP server may use this endpoint.' });
  }
  next();
});

router.post('/hello', (req, res) => {
  const { sampling = false, client = null } = req.body || {};
  heartbeat({ sampling: Boolean(sampling), client });
  res.json(bridgeStatus());
});

router.get(
  '/next',
  asyncH(async (req, res) => {
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const request = await takeNext(Number(req.query.wait) || 25_000, controller.signal);
    if (!request) return res.status(204).end();

    // The poller may have gone while we waited; hand the work back rather than lose it.
    if (req.destroyed || res.writableEnded) {
      requeue(request.id);
      return undefined;
    }
    return res.json(request);
  }),
);

router.post('/:id/result', (req, res) => {
  const delivered = complete(req.params.id, req.body || {});
  if (!delivered) return res.status(404).json({ error: 'No request with that id is waiting — it may have timed out.' });
  return res.json({ ok: true });
});

export default router;
