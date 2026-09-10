/**
 * The model bridge — how the ASDD server borrows the editor's model with no API key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { requestCompletion, takeNext, complete, heartbeat, bridgeStatus, bridgeConnected, tokenMatches, bridgeToken, resetBridge } from '../src/lib/bridge.js';
import { resolveProvider, saveSettings } from '../src/lib/settings.js';
import { assist } from '../src/lib/llm.js';

// Deterministic regardless of the machine: no Anthropic key from the environment.
saveSettings({ model: 'auto', apiKey: '', useEnvKey: false, llmAssist: true });

test('with no editor connected, a request is refused instead of hanging', async () => {
  resetBridge();
  assert.equal(bridgeConnected(), false);
  await assert.rejects(requestCompletion({ system: 's', prompt: 'p' }), /No editor/);
});

test('a client without sampling is seen, but cannot lend a model', () => {
  resetBridge();
  heartbeat({ sampling: false, client: { name: 'Some Client' } });
  const status = bridgeStatus();
  assert.equal(status.connected, true);
  assert.equal(status.usable, false);
  assert.match(status.detail, /does not support MCP sampling/);
});

test("a request reaches a waiting poller, and the editor's answer comes back", async () => {
  resetBridge();
  heartbeat({ sampling: true, client: { name: 'Visual Studio Code' } });
  const poll = takeNext(5000);
  const answer = requestCompletion({ system: 'sys', prompt: 'hello', maxTokens: 50 });

  const request = await poll;
  assert.equal(request.prompt, 'hello');
  assert.equal(request.system, 'sys');
  complete(request.id, { text: 'hi', model: 'copilot-model' });
  assert.deepEqual(await answer, { text: 'hi', model: 'copilot-model' });
});

test('a request made before anyone polls is queued for the next poller', async () => {
  resetBridge();
  heartbeat({ sampling: true });
  const answer = requestCompletion({ system: 's', prompt: 'queued first' });
  const request = await takeNext(1000);
  assert.equal(request.prompt, 'queued first');
  complete(request.id, { text: 'ok' });
  assert.equal((await answer).text, 'ok');
});

test("an editor failure surfaces as an error, never as an empty answer", async () => {
  resetBridge();
  heartbeat({ sampling: true });
  const answer = requestCompletion({ system: 's', prompt: 'p' });
  const request = await takeNext(1000);
  complete(request.id, { error: 'User declined the sampling request' });
  await assert.rejects(answer, /declined/);
});

test('a withdrawn poller does not swallow the next request', async () => {
  resetBridge();
  heartbeat({ sampling: true });
  const controller = new AbortController();
  const withdrawn = takeNext(10_000, controller.signal);
  controller.abort();
  assert.equal(await withdrawn, null);

  const answer = requestCompletion({ system: 's', prompt: 'after the abort' });
  const request = await takeNext(1000);
  assert.equal(request.prompt, 'after the abort', 'it went to a live poller, not the dead one');
  complete(request.id, { text: 'delivered' });
  assert.equal((await answer).text, 'delivered');
});

test('only the bridge token is accepted', () => {
  assert.equal(tokenMatches(bridgeToken()), true);
  assert.equal(tokenMatches('not-the-token'), false);
  assert.equal(tokenMatches(''), false);
});

test('Auto borrows the editor when there is no key — and uses nothing when there is neither', () => {
  resetBridge();
  assert.equal(resolveProvider('generation'), null, 'no key, no editor: rule engine');
  heartbeat({ sampling: true });
  assert.equal(resolveProvider('generation').kind, 'bridge');
});

test('assist() routes through the bridge and parses the JSON the editor returns', async () => {
  resetBridge();
  heartbeat({ sampling: true, client: { name: 'Visual Studio Code' } });
  const pending = assist({ task: 'interview', system: 'probe', prompt: 'reply', maxTokens: 64 });
  const request = await takeNext(1000);
  assert.match(request.system, /single JSON object/, 'the JSON contract is part of the system prompt');
  complete(request.id, { text: 'Sure: {"ok":true}', model: 'copilot-model' });

  const result = await pending;
  assert.equal(result.ok, true);
  assert.match(result.__model, /copilot-model \(via your editor\)/);
});
