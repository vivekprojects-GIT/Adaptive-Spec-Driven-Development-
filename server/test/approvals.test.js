/**
 * The approvals inbox.
 *
 * The platform stops and waits for people on purpose. That is only defensible if a person can see
 * what it is waiting for without opening every project, so anything that blocks must appear here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { pendingApprovals } from '../src/routes/approvals.js';
import { collection } from '../src/lib/store.js';
import { runDiscovery } from '../src/engine/discovery.js';
import { proposeAgents } from '../src/engine/agentFactory.js';
import { proposeGuardrails } from '../src/engine/guardrailDesigner.js';
import { composeWorkflow } from '../src/engine/workflowComposer.js';
import { createRun, executeRun, recordApproval } from '../src/engine/orchestrator.js';
import { assessSpec } from '../src/engine/interview.js';
import { exampleSpec } from '../src/templates.js';
import { id, now } from '../src/lib/util.js';

const projects = collection('projects');

function store(project) {
  projects.insert({ createdAt: now(), updatedAt: now(), proposals: { agents: [], guardrails: [] }, ...project });
  return project;
}

test('an unanswered blocking question shows up as waiting on a human', async () => {
  const spec = { projectKind: 'migration', sourceStack: '', targetStack: '', requirements: '', constraints: '', artifacts: [] };
  const interview = await assessSpec(spec, {}, { withLlm: false });
  const project = store({ id: id('prj'), name: 'Unanswered', spec, interview, stage: 'interview' });

  const item = pendingApprovals().find((i) => i.projectId === project.id);
  assert.ok(item, 'the project appears in the inbox');
  assert.equal(item.kind, 'interview');
  assert.equal(item.severity, 'blocker', 'a blocking question blocks');
  assert.equal(item.stage, 'interview', 'and points at the screen that resolves it');
  assert.ok(item.count >= 3, `counts the open questions, got ${item.count}`);
});

test('undecided proposals are waiting on a human, decided ones are not', () => {
  const spec = exampleSpec('selenium-to-playwright');
  const discovery = runDiscovery(spec);
  const { proposals } = proposeAgents(discovery);

  const undecided = store({
    id: id('prj'),
    name: 'Undecided',
    spec,
    interview: { ready: true, blockingCount: 0 },
    discovery,
    proposals: { agents: proposals, guardrails: proposeGuardrails(discovery) },
  });
  const items = pendingApprovals().filter((i) => i.projectId === undecided.id);
  assert.ok(items.some((i) => i.kind === 'agent-proposals'), 'agent proposals surface');
  assert.ok(items.some((i) => i.kind === 'guardrail-proposals'), 'guardrail proposals surface');
  assert.ok(items.every((i) => i.stage === 'agents' || i.stage === 'guardrails'));

  const decided = store({
    id: id('prj'),
    name: 'Decided',
    spec,
    interview: { ready: true, blockingCount: 0 },
    discovery,
    proposals: {
      agents: proposals.map((p) => ({ ...p, decision: 'accepted' })),
      guardrails: proposeGuardrails(discovery).map((g) => ({ ...g, decision: 'rejected' })),
    },
  });
  assert.equal(pendingApprovals().filter((i) => i.projectId === decided.id).length, 0, 'nothing waits once every proposal is decided');
});

test('a finished run waits for approval, and stops waiting once someone decides', async () => {
  const spec = exampleSpec('junit-to-pytest');
  const project = { id: id('prj'), name: 'Awaiting sign-off', spec, interview: { answers: {}, ready: true, blockingCount: 0 } };
  project.discovery = runDiscovery(spec);
  const { proposals } = proposeAgents(project.discovery);
  project.proposals = {
    agents: proposals.map((p) => ({ ...p, decision: 'accepted' })),
    guardrails: proposeGuardrails(project.discovery).map((g) => ({ ...g, decision: 'accepted' })),
  };
  project.graph = composeWorkflow(project.proposals.agents);
  store(project);

  const run = await executeRun(createRun(project).id, project);
  assert.equal(run.approval.state, 'pending');

  const waiting = pendingApprovals().filter((i) => i.projectId === project.id);
  const approval = waiting.find((i) => i.kind === 'run-approval');
  assert.ok(approval, 'the finished run is in the inbox');
  assert.equal(approval.runId, run.id);
  assert.equal(approval.stage, 'run');
  assert.match(approval.detail, /guardrail\(s\)/, 'it says what the verdict rests on');

  recordApproval(run.id, { state: 'approved', note: 'checked' });
  assert.ok(
    !pendingApprovals().some((i) => i.kind === 'run-approval' && i.runId === run.id),
    'it leaves the inbox once a human has decided',
  );
});

test('the inbox ranks blockers first and counts per project', async () => {
  const items = pendingApprovals();
  const severities = items.map((i) => i.severity);
  const firstMajor = severities.indexOf('major');
  const lastBlocker = severities.lastIndexOf('blocker');
  if (firstMajor !== -1 && lastBlocker !== -1) {
    assert.ok(lastBlocker < firstMajor, 'every blocker sorts above every major');
  }
  const byProject = items.reduce((map, item) => ({ ...map, [item.projectId]: (map[item.projectId] || 0) + item.count }), {});
  for (const [projectId, count] of Object.entries(byProject)) {
    assert.ok(count > 0, `${projectId} has a positive count`);
  }
});
