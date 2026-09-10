/**
 * End to end: a real ASDD server, the real MCP server over stdio, and an MCP client that — like
 * VS Code — supports sampling. The client's sampling handler stands in for Copilot's model.
 *
 * This is the proof of the claim that matters: with NO API key, a BMAD agent running inside an
 * ASDD workflow executes on the editor's model, carrying the user's real BMAD persona.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, '..');
const FIXTURE = path.join(here, 'fixtures', 'bmad');
const PORT = 5300 + Math.floor(Math.random() * 500);
const API = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'asdd-mcp-e2e-'));

const logs = { asdd: '', mcp: '' };
const samplingCalls = [];
let asdd;
let client;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}.\n--- asdd ---\n${logs.asdd}\n--- mcp ---\n${logs.mcp}`);
}

async function api(pathname, method = 'GET', body) {
  const response = await fetch(`${API}/api${pathname}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${pathname} → ${response.status} ${JSON.stringify(data)}`);
  return data;
}

test.before(async () => {
  asdd = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ASDD_DATA_DIR: DATA, ASDD_BMAD_ROOT: FIXTURE, ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  asdd.stdout.on('data', (chunk) => (logs.asdd += chunk));
  asdd.stderr.on('data', (chunk) => (logs.asdd += chunk));
  await waitFor(() => fetch(`${API}/api/health`).then((r) => r.ok), 20_000, 'the ASDD server');

  // No key from anywhere: the only model available will be the one the client lends.
  await api('/settings', 'PUT', { model: 'auto', apiKey: '', useEnvKey: false, llmAssist: true, bmadRoot: FIXTURE });

  client = new Client({ name: 'asdd-e2e-client', version: '1.0.0' }, { capabilities: { sampling: {} } });
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    samplingCalls.push(request.params);
    const prompt = request.params.messages.map((m) => m.content?.text || '').join('\n');
    return {
      model: 'fake-copilot-model',
      role: 'assistant',
      content: {
        type: 'text',
        text: JSON.stringify({
          files: [{ path: 'bmad/testarchitect/review.md', content: `# Review by the fixture persona\n\nRead ${prompt.length} characters of context.` }],
          notes: ['answered by the e2e sampling handler'],
        }),
      },
    };
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SERVER_DIR, 'src', 'mcp.js')],
    env: { ...process.env, ASDD_API: API, ASDD_DATA_DIR: DATA },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => (logs.mcp += chunk));
  await client.connect(transport);

  await waitFor(() => fetch(`${API}/api/llm-bridge/status`).then((r) => r.json()).then((s) => s.usable), 20_000, 'the editor bridge to connect');
});

test.after(async () => {
  await client?.close().catch(() => {});
  asdd?.kill();
  await sleep(200);
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('the MCP server exposes the ASDD tools, and the decision tools say whose decision it is', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of ['asdd_status', 'asdd_list_approvals', 'asdd_run_discovery', 'asdd_decide_run', 'asdd_continue_run', 'asdd_rerun_run', 'asdd_export_run', 'asdd_bmad_agents', 'asdd_bmad_persona']) {
    assert.ok(names.includes(name), `${name} is exposed`);
  }
  assert.match(tools.find((t) => t.name === 'asdd_decide_run').description, /never decide on the user's behalf/i);
  assert.match(tools.find((t) => t.name === 'asdd_continue_run').description, /ONLY call this after the user has explicitly told you/);
  assert.equal(tools.find((t) => t.name === 'asdd_export_run').annotations?.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === 'asdd_list_approvals').annotations?.readOnlyHint, true);
});

test('status reports the borrowed editor model and the BMAD install', async () => {
  const result = await client.callTool({ name: 'asdd_status', arguments: {} });
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.editorBridge.usable, true);
  assert.equal(status.model.provider, 'editor', 'no key, so the model is the editor’s');
  assert.equal(status.bmad.agents.length, 1);
});

test("a BMAD persona is served to the chat with the team's customisations applied", async () => {
  const result = await client.callTool({ name: 'asdd_bmad_persona', arguments: { agent: 'winston' } });
  const text = result.content[0].text;
  assert.match(text, /You are Winston, System Architect/);
  assert.match(text, /Blunt and brief/, 'the personal override');
  assert.match(text, /no automated decision path/i, 'the team standing fact, loaded from its file');
});

test('with no API key, a BMAD agent in a workflow executes on the editor model via sampling', async () => {
  const project = await api('/projects', 'POST', {
    name: 'e2e: BMAD on the editor model',
    spec: { projectKind: 'custom', requirements: 'Review the payments service architecture', targetStack: 'An architecture review document' },
  });
  await api(`/projects/${project.id}/interview`, 'POST', { withLlm: false });
  await api(`/projects/${project.id}/discover`, 'POST', {});

  const registry = await api('/registry');
  const winston = registry.agents.find((a) => a.source === 'bmad');
  assert.ok(winston, 'the BMAD agent is in the registry, read live from the install');

  await api(`/projects/${project.id}/proposals/agents`, 'POST', { agentId: winston.id, runAfter: 'end', saveToRegistry: false });
  await api(`/projects/${project.id}/proposals/agents/bulk`, 'POST', { action: 'accept' });
  await api(`/projects/${project.id}/compose`, 'POST');
  const { runId } = await api(`/projects/${project.id}/runs`, 'POST');

  let run;
  await waitFor(async () => {
    run = await api(`/runs/${runId}`);
    return !['running', 'queued'].includes(run.status);
  }, 60_000, 'the run to finish');

  const node = run.nodes.find((n) => n.impl === 'bmadPersonaAgent');
  assert.ok(node, 'the graph ran the BMAD agent');
  assert.equal(node.status, 'done');
  assert.notEqual(node.metrics.placeholder, true, 'it really executed — no placeholder brief');
  assert.match(node.metrics.model, /fake-copilot-model \(via your editor\)/);

  const review = run.ws.generated.find((a) => a.path === 'bmad/testarchitect/review.md');
  assert.ok(review, `the persona's file came back through sampling; got: ${run.ws.generated.map((a) => a.path).join(', ')}`);
  assert.match(review.content, /Review by the fixture persona/);

  const call = samplingCalls.find((c) => /You are Winston/.test(c.systemPrompt || ''));
  assert.ok(call, "the BMAD persona was the system prompt of the editor's model");
  assert.match(call.systemPrompt, /Blunt and brief/);
  assert.match(call.systemPrompt, /no automated decision path/i);
  assert.match(run.modelUsed || '', /editor/);
});

test('the bridge refuses any caller without the token', async () => {
  const response = await fetch(`${API}/api/llm-bridge/next?wait=1`);
  assert.equal(response.status, 401);
});
