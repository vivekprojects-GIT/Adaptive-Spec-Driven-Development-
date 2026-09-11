/**
 * ASDD from VS Code, end to end — exactly the commands the ASDD skills have Copilot run, in a
 * project folder that has BMAD installed: install, start from the folder's own files, review, run,
 * do the step handed to the assistant, submit, approve, export into the project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exampleSpec } from '../src/templates.js';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../src/cli.js');
const FIXTURE = path.join(here, 'fixtures', 'bmad');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'asdd-ws-'));
const sample = exampleSpec('selenium-to-playwright');

async function command(file, args) {
  try {
    const { stdout } = await exec(process.execPath, [file, ...args], {
      cwd: WS,
      env: { ...process.env, ANTHROPIC_API_KEY: '', ASDD_DEFAULT_MODEL: '' },
      timeout: 180_000,
    });
    return stdout;
  } catch (err) {
    throw new Error(`asdd ${args.join(' ')} failed:\n${err.stdout || ''}\n${err.stderr || err.message}`);
  }
}
/** The shim, exactly as the skills call it. */
const asdd = (...args) => command(path.join(WS, '_asdd', 'asdd.mjs'), args);

test.before(() => {
  // A project with BMAD installed (the fixture install), its source suite, and a requirements doc.
  fs.cpSync(FIXTURE, WS, { recursive: true });
  for (const artifact of sample.artifacts) {
    fs.mkdirSync(path.dirname(path.join(WS, artifact.path)), { recursive: true });
    fs.writeFileSync(path.join(WS, artifact.path), artifact.content);
  }
  fs.writeFileSync(path.join(WS, 'requirements.md'), sample.requirements);
});

test.after(async () => {
  await asdd('stop').catch(() => {});
  try {
    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows can hold the log briefly; the OS cleans temp */
  }
});

test('the whole flow runs from the project folder, the way Copilot drives it', async () => {
  // install — next to BMAD's skills, since this project keeps them in .claude/skills
  const installed = await command(CLI, ['install', '--workspace', WS]);
  assert.match(installed, /\.claude\/skills\/asdd-start\/SKILL\.md/);
  assert.match(installed, /Personas: found/);
  const skill = fs.readFileSync(path.join(WS, '.claude', 'skills', 'asdd-run', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: asdd-run\n/, 'a skill Copilot can load');
  assert.match(await asdd('status'), /No ASDD project in this folder yet/);

  // start — from the folder's own files
  const started = await asdd(
    'start', '--name', 'Checkout suite', '--source', 'src', '--requirements', 'requirements.md',
    '--source-stack', sample.sourceStack, '--target-stack', sample.targetStack,
  );
  assert.match(started, new RegExp(`${sample.artifacts.length} source file\\(s\\) read from src`));
  assert.match(started, /requirement\(s\) recognised from requirements\.md/);
  assert.match(started, /Readiness \d+%/);

  // review — the user's decisions, recorded
  const discovered = await asdd('discover', '--force');
  assert.match(discovered, /AGENTS — \d+ awaiting a decision/);
  await asdd('accept', 'all');
  assert.match(await asdd('personas'), /Winston — System Architect/);
  const added = await asdd('add-agent', '--persona', 'testarchitect', '--instructions', 'Review the generated page objects.', '--after', 'Playwright TypeScript Generator');
  assert.match(added, /Added and accepted: .*Winston/);
  assert.match(added, /handed to you, the coding assistant/);

  // run — the BMAD step is handed to the assistant, with the user's real persona
  const ran = await asdd('run');
  assert.match(ran, /WAITING FOR YOU/);
  const taskFile = ran.match(/Task:\s+(\S+TASK\.md)/)[1];
  const outDir = ran.match(/Write files:\s+(\S+)\//)[1];
  const task = fs.readFileSync(path.join(WS, taskFile), 'utf8');
  assert.match(task, /You are Winston, System Architect/);
  assert.match(task, /Blunt and brief/, "the user's own customisation");
  assert.match(task, /Review the generated page objects\./);

  // the assistant does the step, and hands it back
  fs.mkdirSync(path.join(WS, outDir, 'personas', 'testarchitect'), { recursive: true });
  fs.writeFileSync(path.join(WS, outDir, 'personas', 'testarchitect', 'review.md'), '# Page object review\n\nLoginPage is fine.\n');
  fs.writeFileSync(path.join(WS, outDir, 'NOTES.md'), '- Only LoginPage exists in the sample.\n');
  const submitted = await asdd('submit');
  assert.match(submitted, /Handed back 1 file\(s\) for ".*Winston/);
  assert.match(submitted, /done by your coding assistant/);
  assert.match(submitted, /NEXT: The run is waiting for the user's decision/);
  const runId = submitted.match(/Run (run_\w+)/)[1];
  assert.ok(fs.existsSync(path.join(WS, '_asdd', 'reports', `${runId}.md`)), 'the report lands in the project');

  // decide, then export — previewed first, written only with --yes
  assert.match(await asdd('approve', '--note', 'Checked by hand.'), /Approved .* recorded as human \(via VS Code\): "Checked by hand\."/);
  const plan = await asdd('export');
  assert.match(plan, /nothing written yet/);
  assert.match(plan, /\+ create\s+personas\/testarchitect\/review\.md/);
  assert.ok(!fs.existsSync(path.join(WS, 'personas', 'testarchitect', 'review.md')), 'a preview writes nothing');

  const written = await asdd('export', '--yes');
  assert.match(written, /Wrote \d+ file\(s\)/);
  assert.ok(fs.existsSync(path.join(WS, 'personas', 'testarchitect', 'review.md')), "the assistant's review is now in the project");
  assert.ok(fs.readdirSync(path.join(WS, 'tests')).some((file) => file.endsWith('.spec.ts')), 'and so are the migrated Playwright specs');
  assert.ok(!fs.existsSync(path.join(WS, '_asdd', 'state', 'tests')), "nothing was written into ASDD's own state");

  // the same state, whichever way you look at it
  const status = await asdd('status');
  assert.match(status, /Checkout suite — stage: run/);
  assert.match(status, /Approved/);
});
