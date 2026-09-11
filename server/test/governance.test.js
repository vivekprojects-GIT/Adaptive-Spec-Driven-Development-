/**
 * Governance: who decided what, when, under which rules — read straight from the projects' decision
 * trails and the runs, so it cannot drift from what actually happened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { collection } from '../src/lib/store.js';
import { governanceReport } from '../src/routes/observability.js';
import { id, now } from '../src/lib/util.js';

test('decisions, overrides and the policies in force are all on the record', () => {
  const projectId = id('prj');
  const runId = id('run');
  const at = now();
  collection('projects').insert({
    id: projectId,
    name: 'Governed project',
    spec: { projectKind: 'build' },
    proposals: {
      agents: [],
      guardrails: [
        { guardrailId: 'g.stop', name: 'Plan complete', decision: 'accepted', onFailure: 'stop', check: 'planDocumentsPresent' },
        { guardrailId: 'g.rule', name: 'Architecture covers the PRD', decision: 'accepted', onFailure: 'flag', check: 'customRule' },
        { guardrailId: 'g.no', name: 'Rejected one', decision: 'rejected', onFailure: 'stop', check: 'noSecrets' },
      ],
    },
    trail: [
      { id: id('ev'), at, actor: 'human', action: 'plan.approved', detail: 'Vivek approved the plan.' },
      { id: id('ev'), at, actor: 'human', action: 'run.continued', detail: 'Vivek overrode "Plan complete".' },
      { id: id('ev'), at, actor: 'assistant', action: 'run.handoff-returned', detail: 'Copilot handed back 2 files.' },
      { id: id('ev'), at, actor: 'control-plane', action: 'discovery.completed', detail: 'Discovery ran.' },
      { id: id('ev'), at, actor: 'human', action: 'interview.clarified', detail: 'Asked about users.' },
    ],
  });
  collection('runs').insert({
    id: runId,
    projectId,
    projectName: 'Governed project',
    status: 'completed',
    startedAt: at,
    finishedAt: at,
    modelUsed: 'your coding assistant (Copilot in VS Code)',
    nodes: [],
    approval: { state: 'approved', by: 'Vivek', at },
    validation: {
      verdict: 'passed-with-warnings',
      results: [{ guardrailId: 'g.stop', name: 'Plan complete', severity: 'blocker', status: 'fail', evidence: 'docs/prd.md missing', overridden: { by: 'Vivek', note: 'Writing it by hand.', at } }],
    },
  });

  const report = governanceReport();
  const mine = report.decisions.filter((d) => d.projectId === projectId);
  const kinds = Object.fromEntries(mine.map((d) => [d.action, d.category]));
  assert.equal(kinds['plan.approved'], 'approval');
  assert.equal(kinds['run.continued'], 'override');
  assert.equal(kinds['run.handoff-returned'], 'assistant', 'the coding assistant is told apart from people');
  assert.equal(kinds['discovery.completed'], 'system');
  assert.equal(kinds['interview.clarified'], 'input');

  const override = report.overrides.find((o) => o.runId === runId);
  assert.equal(override.by, 'Vivek');
  assert.equal(override.note, 'Writing it by hand.');
  assert.match(override.evidence, /docs\/prd\.md missing/, 'with the evidence the check failed on');

  const policy = report.policies.find((p) => p.projectId === projectId);
  assert.equal(policy.guardrails, 2, 'only accepted guardrails are in force');
  assert.deepEqual(policy.stops, ['Plan complete']);
  assert.equal(policy.plainEnglish, 1);
  assert.equal(policy.lastRun.approval, 'approved');
  assert.ok(report.totals.overrides >= 1 && report.totals.runsApproved >= 1);
});
