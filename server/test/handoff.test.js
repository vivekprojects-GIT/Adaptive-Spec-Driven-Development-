/**
 * Handing an agent step to the user's coding assistant — how ASDD uses Copilot as its model from
 * VS Code, with no API key. The run waits, the assistant does the step, the run carries on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runDiscovery } from '../src/engine/discovery.js';
import { proposeAgents, customAgentProposal } from '../src/engine/agentFactory.js';
import { customGuardrailProposal } from '../src/engine/guardrailDesigner.js';
import { composeWorkflow } from '../src/engine/workflowComposer.js';
import { createRun, executeRun, recordApproval, prepareSubmission } from '../src/engine/orchestrator.js';
import { getSettings, saveSettings } from '../src/lib/settings.js';
import { exampleSpec } from '../src/templates.js';
import { id } from '../src/lib/util.js';

// Other test files share this store; leave the settings exactly as they were found.
const original = getSettings();
test.after(() => saveSettings(original));

function projectWithReviewer() {
  const project = { id: id('prj'), name: 'handoff', spec: exampleSpec('selenium-to-playwright'), interview: { answers: {}, ready: true } };
  project.discovery = runDiscovery(project.spec);
  const agents = proposeAgents(project.discovery).proposals.map((p) => ({ ...p, decision: 'accepted' }));
  const reviewer = customAgentProposal(
    {
      name: 'Locator Reviewer',
      purpose: 'Review the locator strategy of the generated specs',
      instructions: 'List brittle locators, with a concrete fix for each.',
      inputSelections: ['generated'],
      outputDescription: 'A locator review',
      runAfter: 'agent.playwright-ts-generator',
    },
    agents,
  );
  agents.push({ ...reviewer, group: 'Custom' });
  const check = customGuardrailProposal({
    name: 'Parity holds after the review',
    severity: 'minor',
    appliesTo: reviewer.agentId,
    onFailure: 'flag',
    check: 'testCaseParity',
  });
  project.proposals = { agents, guardrails: [check] };
  project.graph = composeWorkflow(agents);
  return { project, reviewer, check };
}

const starts = (run, name) => run.events.filter((e) => e.type === 'node:start' && e.agent === name).length;

test('in assistant mode an agent step is handed to the coding assistant, and the run waits for it', async () => {
  saveSettings({ model: 'assistant', llmAssist: true });
  const { project, reviewer } = projectWithReviewer();
  const run = await executeRun(createRun(project).id, project);

  assert.equal(run.status, 'waiting');
  assert.equal(run.modelUsed, 'your coding assistant (Copilot in VS Code)');
  const node = run.nodes.find((n) => n.agentId === reviewer.agentId);
  assert.equal(node.status, 'waiting');
  assert.match(node.handoff.task, /List brittle locators, with a concrete fix for each/, 'the task is what the user wrote');
  assert.match(node.handoff.task, /tests\/\S+\.spec\.ts/, 'with the inputs the agent was given');
  assert.equal(node.handoff.outputDir, 'custom/locator-reviewer');

  const after = run.nodes.slice(run.nodes.indexOf(node) + 1);
  assert.ok(after.length > 0 && after.every((n) => n.status === 'pending'), 'later agents are pending, not skipped');
  assert.equal(run.approval, null, 'nothing is offered for approval while a step is out');
  assert.throws(() => recordApproval(run.id, { state: 'approved' }), (err) => err.status === 409 && /waiting on your coding assistant/.test(err.message));
});

test('the assistant hands its files back and the same run carries on to a decision', async () => {
  saveSettings({ model: 'assistant', llmAssist: true });
  const { project, reviewer, check } = projectWithReviewer();
  const waiting = await executeRun(createRun(project).id, project);
  const node = waiting.nodes.find((n) => n.agentId === reviewer.agentId);
  const generator = waiting.nodes.find((n) => n.capability.startsWith('target.generate'));

  assert.throws(() => prepareSubmission(waiting.id, node.nodeId, { files: [] }), (err) => err.status === 400, 'an empty hand-back is refused');

  prepareSubmission(waiting.id, node.nodeId, {
    files: [
      { path: 'custom/locator-reviewer/review.md', content: '# Locator review\n\n- `#username` is stable.\n' },
      { path: '../../outside.md', content: 'tried to climb out' },
    ],
    notes: ['Assumed data-test ids are not available.'],
    by: 'Copilot',
  });
  const run = await executeRun(waiting.id, project, { resume: true });

  assert.equal(run.id, waiting.id, 'the same run carries on');
  const done = run.nodes.find((n) => n.agentId === reviewer.agentId);
  assert.equal(done.status, 'done');
  assert.equal(done.metrics.handedOff, true);
  assert.ok(done.notes.includes('Assumed data-test ids are not available.'));
  assert.equal(starts(run, generator.name), 1, 'nothing that already ran is run again');

  const review = run.ws.generated.find((a) => a.path === 'custom/locator-reviewer/review.md');
  assert.equal(review?.producedBy, done.nodeId, "the assistant's file is the agent's output");
  assert.ok(run.ws.generated.some((a) => a.path === 'outside.md'), 'a path cannot climb out of the output tree');

  assert.ok(run.validation.results.some((r) => r.guardrailId === check.guardrailId), "the agent's own guardrail ran on what came back");
  assert.ok(!run.nodes.some((n) => ['pending', 'waiting', 'skipped'].includes(n.status)), 'every agent ran');
  assert.ok(run.events.some((e) => e.type === 'node:submitted'), 'the hand-back is on the timeline');
  assert.equal(run.approval.state, 'pending', 'and the run ends at the human, as always');
});
