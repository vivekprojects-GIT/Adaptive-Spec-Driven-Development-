/**
 * Every command the skills rely on beyond the happy path in workspace.e2e — clarifying and
 * answering, halting and continuing, requesting changes, editing, re-running, re-reading the folder,
 * rules judged by the assistant, the dashboard, ASDD's MCP tools on the folder's own server — and
 * that server stopping itself when idle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { exampleSpec } from '../src/templates.js';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../src/cli.js');
const SERVER = path.resolve(here, '../src/index.js');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'asdd-cli-'));
const SHIM = path.join(WS, '_asdd', 'asdd.mjs');
const sample = exampleSpec('selenium-to-playwright');
const env = { ...process.env, ANTHROPIC_API_KEY: '', ASDD_DEFAULT_MODEL: '' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function asdd(...args) {
  try {
    return (await exec(process.execPath, [SHIM, ...args], { cwd: WS, env, timeout: 180_000 })).stdout;
  } catch (err) {
    throw new Error(`asdd ${args.join(' ')} failed:\n${err.stdout || ''}\n${err.stderr || err.message}`);
  }
}

/** A command that must be refused; returns what it said. */
async function refused(...args) {
  try {
    await exec(process.execPath, [SHIM, ...args], { cwd: WS, env, timeout: 60_000 });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
  throw new Error(`asdd ${args.join(' ')} should have been refused`);
}

test.before(async () => {
  for (const artifact of sample.artifacts) {
    fs.mkdirSync(path.dirname(path.join(WS, artifact.path)), { recursive: true });
    fs.writeFileSync(path.join(WS, artifact.path), artifact.content);
  }
  fs.writeFileSync(path.join(WS, 'requirements.md'), sample.requirements);
  await exec(process.execPath, [CLI, 'install', '--workspace', WS], { cwd: WS, env });
});

test.after(async () => {
  await asdd('stop').catch(() => {});
  try {
    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows can hold the log briefly */
  }
});

test('install also registers the MCP tools for this folder, without touching the user\'s own', () => {
  const config = JSON.parse(fs.readFileSync(path.join(WS, '.vscode', 'mcp.json'), 'utf8'));
  assert.deepEqual(config.servers.asdd.args, ['${workspaceFolder}/_asdd/asdd.mjs', 'mcp']);
});

test('the user\'s decisions, from the command line: clarify, answer, stop, continue, change, re-run, re-read', async () => {
  await asdd('start', '--name', 'CLI checks', '--source', 'src', '--requirements', 'requirements.md', '--source-stack', sample.sourceStack, '--target-stack', sample.targetStack);

  const clarified = await asdd('clarify', 'Should the migrated suite keep the page object model?', 'Yes, keep LoginPage and CheckoutPage.', '--why', 'Decides the generated structure.');
  assert.match(clarified, /Recorded: "Should the migrated suite keep the page object model\?"/);
  const interview = await asdd('interview');
  const firstQuestion = interview.match(/\[(?:blocking|optional)\] (\S+)/)?.[1];
  if (firstQuestion) assert.match(await asdd('answer', firstQuestion, 'Yes, keep the page object model'), /Recorded the answer/);
  assert.match(await asdd('interview'), /Clarified in chat:\n\s+• Should the migrated suite keep the page object model\? → Yes, keep LoginPage/, 'a clarification survives later answers');

  await asdd('discover', '--force');
  await asdd('accept', 'all');
  assert.match(
    await asdd('add-guardrail', '--name', 'Nothing may pass the analyzer unmigrated', '--check', 'testCaseParity', '--severity', 'blocker', '--applies-to', 'Selenium Java Analyzer', '--on-failure', 'stop'),
    /applies to Selenium Java Analyzer/,
  );

  assert.match(await asdd('run'), /A guardrail stopped the run/);
  assert.match(await refused('approve'), /cannot be approved as it stands/);
  const continued = await asdd('continue', '--note', 'Parity cannot pass before generation.');
  assert.match(continued, /Continuing run_\w+ past "Nothing may pass the analyzer unmigrated"/);
  assert.match(continued, /waiting for the user's decision/);

  assert.match(await asdd('request-changes', '--note', 'Make the analyzer check a flag.'), /Changes requested on run_/);
  const guardId = (await asdd('proposals')).match(/(gp_\w+)\s+\[accepted\] Nothing may pass/)?.[1];
  assert.ok(guardId, 'the guardrail is listed with its id');
  const edited = await asdd('edit', guardId, '--set', 'on-failure=flag', '--set', 'name=Analyzer parity (flag only)');
  assert.match(edited, /Edited and accepted/);
  assert.match(edited, /Analyzer parity \(flag only\) — blocker, on failure: flag/, 'a value with spaces and parentheses arrives whole');

  const rerun = await asdd('rerun', '--from', 'Playwright TypeScript Generator', '--note', 'Stop changed to flag.');
  assert.match(rerun, /Re-running as run_\w+ from "Playwright TypeScript Generator" — reusing Selenium Java Analyzer/);
  assert.doesNotMatch(rerun, /A guardrail stopped the run/, 'the edited check is judged fresh and only flags');

  fs.appendFileSync(path.join(WS, sample.artifacts[0].path), '\n// edited after the run\n');
  const synced = await asdd('sync');
  assert.match(synced, /1 changed/);
  assert.match(synced, /changed since discovery ran/);
});

test('a rule written in plain English is judged by the assistant, with evidence, and the run carries on', async () => {
  await asdd('add-guardrail', '--name', 'Specs import Playwright test', '--rule', 'Every generated spec imports test and expect from @playwright/test.', '--applies-to', 'Playwright TypeScript Generator', '--on-failure', 'flag');
  const ran = await asdd('run');
  assert.match(ran, /WAITING FOR YOU — the coding assistant\. Judge 1 rule\(s\) the user wrote, on the work of "Playwright TypeScript Generator"/);
  const judgeFile = ran.match(/Evidence:\s+(\S+JUDGE\.md)/)[1];
  const brief = fs.readFileSync(path.join(WS, judgeFile), 'utf8');
  assert.match(brief, /Every generated spec imports test and expect from @playwright\/test\./);
  assert.match(brief, /from '@playwright\/test'/, 'the files it applies to are in front of the judge');

  const guardrailId = ran.match(/• Specs import Playwright test \((\S+)\)/)[1];
  assert.match(await refused('submit'), /waiting for verdicts on rules, not for files/);
  assert.match(await refused('judge', guardrailId, 'pass'), /judge <guardrailId> pass\|warn\|fail/, 'a verdict without evidence is refused');

  const judged = await asdd('judge', guardrailId, 'pass', 'Each spec starts with its import.');
  assert.match(judged, /Every rule is judged — the run carries on/);
  assert.match(judged, /PASS Specs import Playwright test: Each spec starts with its import\. \(judged by your coding assistant/);
  assert.match(judged, /waiting for the user's decision/);
});

test('the dashboard and the MCP tools run on this folder\'s own server', async () => {
  const ui = await asdd('ui');
  if (fs.existsSync(path.resolve(here, '../../web/dist/index.html'))) {
    const address = ui.match(/dashboard for this folder: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    assert.ok(address, ui);
    assert.match(await fetch(address).then((r) => r.text()), /<div id="root">|<!doctype html/i);
  } else {
    // A checkout whose UI was never built says exactly how to build it, rather than serving nothing.
    assert.match(ui, /The dashboard is not built yet\. Build it once: .*npm run build/);
  }

  const client = new Client({ name: 'cli-mcp-check', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SHIM, 'mcp'], cwd: WS, env, stderr: 'pipe' }));
  try {
    const { tools } = await client.listTools();
    for (const name of ['asdd_waiting_task', 'asdd_hand_back_files', 'asdd_judge_rules', 'asdd_add_clarification']) {
      assert.ok(tools.some((t) => t.name === name), `${name} is exposed`);
    }
    const projects = await client.callTool({ name: 'asdd_list_projects', arguments: {} });
    assert.match(projects.content[0].text, /CLI checks/, 'the same project the commands made');
  } finally {
    await client.close();
  }
});

test('the folder server stops itself when nothing uses it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asdd-idle-'));
  const portFile = path.join(dir, 'server.json');
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(path.dirname(SERVER)),
    env: { ...env, PORT: '0', HOST: '127.0.0.1', ASDD_DATA_DIR: dir, ASDD_PORT_FILE: portFile, ASDD_WORKSPACE: dir, ASDD_IDLE_EXIT_MINUTES: '0.03' },
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i += 1) await sleep(100);
    assert.ok(fs.existsSync(portFile), 'it started and said where');
    const code = await Promise.race([exited, sleep(15_000).then(() => 'still running')]);
    assert.equal(code, 0, 'it stopped by itself');
    assert.ok(!fs.existsSync(portFile), 'and cleared its port file, so the next command starts a fresh one');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
