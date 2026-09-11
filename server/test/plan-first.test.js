/**
 * Plan-first: requirements in; brief → PRD → architecture → epics & stories → implementation out.
 * ASDD proposes the whole plan, a person approves it once, and every phase then runs in order —
 * each reading what the phases before it wrote, held to it by guardrails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDiscovery } from '../src/engine/discovery.js';
import { proposeAgents } from '../src/engine/agentFactory.js';
import { proposeGuardrails } from '../src/engine/guardrailDesigner.js';
import { composeWorkflow } from '../src/engine/workflowComposer.js';
import { createRun, executeRun, prepareSubmission, prepareJudgement } from '../src/engine/orchestrator.js';
import { getSettings, saveSettings } from '../src/lib/settings.js';
import { id } from '../src/lib/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'bmad');
const original = getSettings();
test.after(() => saveSettings(original));

const REQUIREMENTS = [
  'REQ-001 A visitor can sign up with an email and a password',
  'REQ-002 A signed-in user can create, edit and delete notes',
  'REQ-003 Notes are listed newest first on the dashboard page',
].join('\n');

const spec = (extra = {}) => ({ projectKind: 'build', requirements: REQUIREMENTS, sourceStack: '', targetStack: '', constraints: '', artifacts: [], ...extra });

/** Discovery, the proposals, and the one approval: everything proposed accepted as it is. */
function approvedPlan() {
  const project = { id: id('prj'), name: 'notes app', spec: spec(), interview: { answers: {}, ready: true } };
  project.discovery = runDiscovery(project.spec);
  project.proposals = {
    agents: proposeAgents(project.discovery).proposals.map((p) => ({ ...p, decision: 'accepted' })),
    guardrails: proposeGuardrails(project.discovery).map((g) => ({ ...g, decision: 'accepted' })),
  };
  project.graph = composeWorkflow(project.proposals.agents);
  return project;
}

/** What each phase hands back — standing in for the persona (Copilot in VS Code, or a model). */
const PHASE_OUTPUT = {
  'plan.brief': () => [{ path: 'docs/product-brief.md', content: '# Brief\n\nProblem: people lose notes.\nUsers: individuals.\nScope: accounts and notes.\n' }],
  'plan.prd': () => [
    { path: 'docs/prd.md', content: '# PRD\n\n- REQ-001 Sign up. AC: an account exists.\n- REQ-002 Manage notes. AC: changes persist.\n- REQ-003 Newest first. AC: sorted by date.\n' },
  ],
  'plan.ux': () => [{ path: 'docs/ux-design.md', content: '# UX\n\nJourneys: sign up; manage notes.\nScreens: sign-up, dashboard.\nStates: empty, error.\n' }],
  'plan.architecture': () => [{ path: 'docs/architecture.md', content: '# Architecture\n\n- auth → REQ-001\n- notes → REQ-002, REQ-003\nFolders: src/auth, src/notes.\n' }],
  'plan.stories': (complete) => [
    {
      path: 'docs/epics-and-stories.md',
      content: `# Epics & stories\n\n## E1 Accounts\n- S1.1 Sign up (REQ-001)\n\n## E2 Notes\n- S2.1 Manage notes (REQ-002)\n${complete ? '- S2.2 Newest first (REQ-003)\n' : ''}`,
    },
  ],
  'build.implement': () => [
    { path: 'src/auth/signup.ts', content: '// Story S1.1\nexport function signUp(email: string) {\n  return { email };\n}\n' },
    { path: 'src/notes/notes.ts', content: '// Story S2.1\n// Story S2.2\nexport const notes: string[] = [];\n' },
  ],
};

/** Plays the coding assistant: does every step handed over, judges every rule, until the run stops. */
async function runToTheEnd(project, { complete = true } = {}) {
  let run = await executeRun(createRun(project).id, project);
  const handedTo = [];
  for (let turn = 0; turn < 20 && run.status === 'waiting'; turn += 1) {
    if (run.waitingFor?.kind === 'judgement') {
      prepareJudgement(run.id, {
        verdicts: run.waitingFor.items.map((item) => ({ guardrailId: item.guardrailId, status: 'pass', evidence: 'Each requirement maps to a component.' })),
      });
    } else {
      const node = run.nodes.find((n) => n.status === 'waiting');
      handedTo.push(node.capability);
      prepareSubmission(run.id, node.nodeId, { files: PHASE_OUTPUT[node.capability](complete) });
    }
    run = await executeRun(run.id, project, { resume: true });
  }
  return { run, handedTo };
}

test('from requirements alone, discovery proposes the plan-first structure', () => {
  const discovery = runDiscovery(spec());
  const phases = discovery.capabilities.map((c) => c.id).filter((c) => c.startsWith('plan.') || c === 'build.implement');
  assert.deepEqual(phases, ['plan.brief', 'plan.prd', 'plan.ux', 'plan.architecture', 'plan.stories', 'build.implement']);
  const all = discovery.capabilities.map((c) => c.id);
  assert.ok(!all.includes('traceability.build') && !all.includes('docs.bmad.generate') && !all.includes('spec.bdd.generate'), 'none of the migration machinery');
  assert.equal(discovery.gaps.length, 0);
  assert.match(discovery.summary, /Plan-first build from 3 requirement\(s\)/);

  const noScreens = runDiscovery(spec({ requirements: 'REQ-001 The nightly job exports orders to CSV' }));
  assert.ok(!noScreens.capabilities.some((c) => c.id === 'plan.ux'), 'no UX phase when nothing has a user interface');
});

test('the plan names who does each step, and the guardrails between the steps', () => {
  saveSettings({ bmadRoot: FIXTURE });
  const discovery = runDiscovery(spec());
  const { proposals } = proposeAgents(discovery);

  const architecture = proposals.find((p) => p.capability === 'plan.architecture');
  assert.equal(architecture.source, 'bmad', 'the architect persona from the library does the architecture');
  assert.match(architecture.name, /^Winston — Architecture/);
  assert.equal(architecture.impl, 'bmadPersonaAgent');
  assert.equal(architecture.agentId, 'agent.plan.architecture', 'each phase has its own agent id');

  const brief = proposals.find((p) => p.capability === 'plan.brief');
  assert.equal(brief.source, 'asdd', "this library has no analyst, so ASDD's own agent writes the brief");
  assert.match(brief.authored.instructions, /docs\/product-brief\.md/);
  assert.ok(proposals.every((p) => p.decision === 'proposed'), 'proposed, for the person to approve');

  const guardrails = proposeGuardrails(discovery);
  const stops = guardrails.filter((g) => g.onFailure === 'stop');
  assert.deepEqual(stops.map((g) => g.guardrailId).sort(), ['guard.plan.complete', 'guard.plan.requirements-in-stories']);
  assert.ok(stops.every((g) => g.appliesTo === 'agent.plan.stories'), 'both stop before any code is written');
  assert.ok(guardrails.every((g) => g.decision === 'proposed'));
  saveSettings({ bmadRoot: original.bmadRoot || '' });
});

test('approved once, every phase runs in order — each reading the documents before it — to one final decision', async () => {
  saveSettings({ model: 'assistant', llmAssist: true });
  const { run, handedTo } = await runToTheEnd(approvedPlan());

  assert.deepEqual(handedTo, ['plan.brief', 'plan.prd', 'plan.ux', 'plan.architecture', 'plan.stories', 'build.implement'], 'each phase in turn, with nobody starting it');
  assert.equal(run.status, 'completed');
  assert.equal(run.approval.state, 'pending', 'and it ends at the one human decision');

  const verdict = (guardrailId) => run.validation.results.find((r) => r.guardrailId === guardrailId)?.status;
  for (const guardrailId of ['guard.plan.requirements-in-prd', 'guard.plan.complete', 'guard.plan.requirements-in-stories', 'guard.plan.stories-built', 'guard.plan.every-step-ran']) {
    assert.equal(verdict(guardrailId), 'pass', guardrailId);
  }

  const architect = run.nodes.find((n) => n.capability === 'plan.architecture');
  assert.match(architect.handoff.task, /docs\/prd\.md[\s\S]*REQ-003/, 'the architect read the PRD written before it');
  const developer = run.nodes.find((n) => n.capability === 'build.implement');
  assert.match(developer.handoff.task, /S2\.2/, 'the developer read the stories');
  assert.ok(run.ws.generated.some((a) => a.path === 'src/notes/notes.ts' && a.kind === 'code'), 'the code is in the run, ready to export');
});

test('a requirement with no story stops the run before any code is written', async () => {
  saveSettings({ model: 'assistant', llmAssist: true });
  const { run, handedTo } = await runToTheEnd(approvedPlan(), { complete: false });

  assert.equal(run.status, 'halted');
  assert.equal(run.validation.haltedBy, 'guard.plan.requirements-in-stories');
  assert.match(run.validation.results.find((r) => r.guardrailId === 'guard.plan.requirements-in-stories').evidence, /REQ-003/);
  assert.ok(!handedTo.includes('build.implement'), 'implementation never started');
  assert.equal(run.nodes.find((n) => n.capability === 'build.implement').status, 'skipped');
});

test('from the command line: start a build project, see the plan, approve it once', async () => {
  const exec = promisify(execFile);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'asdd-plan-'));
  const env = { ...process.env, ANTHROPIC_API_KEY: '', ASDD_DEFAULT_MODEL: '' };
  const asdd = async (...args) => (await exec(process.execPath, [path.join(ws, '_asdd', 'asdd.mjs'), ...args], { cwd: ws, env, timeout: 120_000 })).stdout;
  try {
    await exec(process.execPath, [path.resolve(here, '../src/cli.js'), 'install', '--workspace', ws], { env });
    await asdd('start', '--name', 'Notes app', '--kind', 'build', '--requirements-text', REQUIREMENTS);
    const plan = await asdd('discover');
    assert.match(plan, /This is the proposed plan/);
    assert.match(plan, /approve-plan/);

    const approved = await asdd('approve-plan');
    assert.match(approved, /Plan approved — \d+ agent\(s\), \d+ guardrail\(s\)/);
    assert.match(approved, /WAITING FOR YOU/, 'it runs until the first phase that needs the assistant');
    const taskFile = approved.match(/Task:\s+(\S+TASK\.md)/)[1];
    assert.match(fs.readFileSync(path.join(ws, taskFile), 'utf8'), /docs\/product-brief\.md/, 'the first phase is the brief');
  } finally {
    await asdd('stop').catch(() => {});
    try {
      fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold the log briefly */
    }
  }
});
