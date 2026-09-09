/**
 * The human-owned half of the platform: custom projects, authored agents, authored guardrails,
 * stop-on-failure, and the final approval gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runDiscovery, parseRequirements } from '../src/engine/discovery.js';
import { detectTechnology } from '../src/registry/technologies.js';
import { proposeAgents, customAgentProposal, runAfterOptions } from '../src/engine/agentFactory.js';
import { customGuardrailProposal } from '../src/engine/guardrailDesigner.js';
import { composeWorkflow } from '../src/engine/workflowComposer.js';
import { createRun, executeRun, recordApproval, getRun } from '../src/engine/orchestrator.js';
import { assessSpec } from '../src/engine/interview.js';
import { SAMPLES } from '../src/samples.js';
import { id } from '../src/lib/util.js';

test('requirements parse from a document, a short list, or a single line', () => {
  const typed = parseRequirements('Convert our Selenium suite to Playwright\nKeep every assertion\nRun headless in CI');
  assert.equal(typed.length, 3, 'every typed line counts');
  assert.equal(typed[0].id, 'REQ-001');

  const single = parseRequirements('migrate the api tests');
  assert.equal(single.length, 1, 'one line is still a requirement');

  const document = `# Requirements

## 1. Introduction
This document describes the programme.

## 2. Functional requirements
- REQ-101: The system shall let a shopper log in
- REQ-102: The system shall reject a locked out user
* As a QA engineer, I want the suite to run headless

## 3. Appendix
Nothing further.`;
  const parsed = parseRequirements(document);
  assert.equal(parsed.length, 3, 'prose and headings are skipped');
  assert.deepEqual(parsed.slice(0, 2).map((r) => r.id), ['REQ-101', 'REQ-102'], 'document ids are kept');
  assert.ok(!parsed.some((r) => /Introduction|Appendix|describes the programme/.test(r.text)), 'no scaffolding leaks in');
});

test('a custom project assumes nothing: no stack questions, no capability gaps', async () => {
  const spec = {
    projectKind: 'custom',
    requirements: 'Produce an onboarding checklist for the payments service\nSummarise the runbook for on-call',
    sourceStack: '',
    targetStack: '',
    constraints: '',
    artifacts: [{ path: 'notes/runbook.md', content: '# Runbook\nRestart the worker with `svc restart`.\n' }],
  };

  const interview = await assessSpec(spec, {}, { withLlm: false });
  const asked = interview.questions.map((q) => q.id);
  assert.ok(!asked.includes('source-stack'), 'no source framework question on a custom project');
  assert.ok(!asked.includes('target-stack'), 'no target framework question on a custom project');
  assert.ok(!asked.includes('pom'), 'no page-object question on a custom project');

  const discovery = runDiscovery(spec);
  const { gaps, proposals } = proposeAgents(discovery);
  assert.equal(gaps.length, 0, `a custom project raises no gaps, got ${JSON.stringify(gaps)}`);
  assert.ok(discovery.capabilities.some((c) => c.id === 'custom.workflow'), 'the workflow is left to the human');
  assert.ok(proposals.every((p) => !p.capability.startsWith('target.generate')), 'no emitter is assumed');
});

test('an authored agent carries its instructions into the graph and executes them', async () => {
  const accepted = [
    { agentId: 'agent.selenium-java-analyzer', name: 'Selenium Java Analyzer', phase: 10 },
  ];

  const options = runAfterOptions(accepted).map((o) => o.value);
  assert.deepEqual(options, ['start', 'agent.selenium-java-analyzer', 'end'], '"when should it run" is built from the real graph');

  const proposal = customAgentProposal(
    {
      name: 'Database Validation Agent',
      purpose: 'Validate database checks carried over from Selenium',
      inputSelections: ['requirements', 'artifacts'],
      artifactFilter: 'java',
      outputDescription: 'DB validation Playwright steps',
      instructions: 'Preserve all source DB assertions. Emit one Playwright step per assertion.',
      runAfter: 'agent.selenium-java-analyzer',
      saveToRegistry: false,
    },
    accepted,
  );

  assert.equal(proposal.impl, 'instructionAgent', 'instructions mean it actually runs, not a placeholder note');
  assert.equal(proposal.decision, 'accepted', 'what a human authors is accepted by definition');
  assert.equal(proposal.phase, 11, 'it sits directly after the agent it was told to follow');
  assert.equal(proposal.authored.runAfterLabel, 'After Selenium Java Analyzer');
  assert.deepEqual(proposal.authored.inputSelections, ['requirements', 'artifacts']);

  const graph = composeWorkflow([
    { ...proposal, group: 'Custom', inputs: [], outputs: [] },
  ]);
  assert.equal(graph.nodes[0].authored.instructions, proposal.authored.instructions, 'instructions reach the executable node');

  // Offline (no API key in the test environment) it must refuse to fake work.
  const project = { id: id('prj'), name: 'authored', spec: SAMPLES[0].spec, interview: { answers: {}, ready: true } };
  project.discovery = runDiscovery(project.spec);
  project.graph = graph;
  project.proposals = { agents: [proposal], guardrails: [] };
  const run = await executeRun(createRun(project).id, project);

  const brief = run.ws.generated.find((a) => a.path.endsWith('BRIEF.md'));
  assert.ok(brief, 'it writes the resolved brief instead of inventing output');
  assert.match(brief.content, /Preserve all source DB assertions/, 'the brief contains what the human wrote');
  assert.match(brief.content, /not.*executed/i, 'and says plainly that it did not run');
  assert.equal(run.nodes[0].metrics.placeholder, true);
});

test('a guardrail set to "stop workflow" actually halts the run at that agent', async () => {
  const sample = SAMPLES.find((s) => s.id === 'selenium-to-playwright');
  const project = { id: id('prj'), name: 'halting', spec: sample.spec, interview: { answers: {}, ready: true } };
  project.discovery = runDiscovery(project.spec);

  const { proposals } = proposeAgents(project.discovery);
  const agents = proposals.map((p) => ({ ...p, decision: 'accepted' }));

  // Scoped to the analyzer, which runs before any code exists — so parity must fail there.
  const stopper = customGuardrailProposal({
    name: 'Nothing may pass the analyzer unmigrated',
    rule: 'Every source test must already have a generated counterpart.',
    severity: 'blocker',
    appliesTo: 'agent.selenium-java-analyzer',
    onFailure: 'stop',
    check: 'testCaseParity',
  });
  assert.equal(stopper.onFailure, 'stop');
  assert.equal(stopper.appliesTo, 'agent.selenium-java-analyzer');

  project.proposals = { agents, guardrails: [stopper] };
  project.graph = composeWorkflow(agents);

  const run = await executeRun(createRun(project).id, project);

  assert.equal(run.status, 'halted', 'the run stops rather than reporting the failure afterwards');
  assert.equal(run.validation.verdict, 'blocked');
  assert.equal(run.validation.haltedBy, stopper.guardrailId);
  assert.ok(run.nodes.some((n) => n.status === 'skipped'), 'downstream agents are skipped, not silently run');
  assert.ok(run.events.some((e) => e.type === 'run:halted'), 'the halt is on the timeline');
  assert.equal(run.nodes[0].status, 'done', 'the agent that triggered it still completed');
});

test('every run ends pending a human decision, and the decision is recorded', async () => {
  const sample = SAMPLES.find((s) => s.id === 'junit-to-pytest');
  const project = { id: id('prj'), name: 'approval', spec: sample.spec, interview: { answers: {}, ready: true } };
  project.discovery = runDiscovery(project.spec);
  const { proposals } = proposeAgents(project.discovery);
  project.proposals = { agents: proposals.map((p) => ({ ...p, decision: 'accepted' })), guardrails: [] };
  project.graph = composeWorkflow(project.proposals.agents);

  const run = await executeRun(createRun(project).id, project);
  assert.equal(run.approval.state, 'pending', 'nothing is accepted just because the run finished');

  const approval = recordApproval(run.id, { state: 'approved', note: 'Checked the generated specs by hand.' });
  assert.equal(approval.state, 'approved');
  assert.equal(getRun(run.id).approval.note, 'Checked the generated specs by hand.');
});

test('technology detection picks the most specific profile, not the first one listed', () => {
  // Regression: "Playwright API testing (TypeScript)" used to tie with the bare "playwright"
  // keyword and resolve to the UI profile, which then ran a browser emitter over an API source
  // model and produced code referencing an undefined `response`.
  const cases = [
    ['Playwright API testing (TypeScript)', 'target', 'playwright-api'],
    ['Playwright (TypeScript)', 'target', 'playwright-ts'],
    ['Playwright (Python)', 'target', 'playwright-python'],
    ['playwright', 'target', 'playwright-ts'],
    ['Selenium WebDriver (Java) with TestNG', 'source', 'selenium-java'],
    ['Selenium WebDriver (Python)', 'source', 'selenium-python'],
    ['Legacy REST API tests (Postman collection)', 'source', 'rest-collection'],
    ['Mainframe COBOL batch test harness', 'source', 'unknown'],
  ];
  for (const [declared, role, expected] of cases) {
    assert.equal(detectTechnology(declared, [], role).id, expected, `"${declared}" as ${role}`);
  }
});

test('the structure check does not trip over URLs, escaped quotes or truncated comments', async () => {
  // Regression: `//` inside 'https://shop.example.com/login' was read as a line comment, which
  // swallowed the rest of the line — including its closing bracket — and reported clean generated
  // files as structurally broken blockers.
  const sample = SAMPLES.find((s) => s.id === 'selenium-to-playwright');
  const project = { id: id('prj'), name: 'structure', spec: sample.spec, interview: { answers: {}, ready: true } };
  project.discovery = runDiscovery(project.spec);
  const { proposals } = proposeAgents(project.discovery);
  project.proposals = { agents: proposals.map((p) => ({ ...p, decision: 'accepted' })), guardrails: [] };
  project.graph = composeWorkflow(project.proposals.agents);

  const run = await executeRun(createRun(project).id, project);
  const report = run.ws.structureReport;

  assert.ok(run.ws.generated.some((a) => a.content.includes("goto('https://")), 'the sample really does contain a URL');
  assert.ok(run.ws.generated.some((a) => a.content.includes("xpath=//button")), 'and an xpath with a double slash');
  assert.equal(report.blockers, 0, `no structural blockers, got: ${JSON.stringify(report.findings.filter((f) => f.severity === 'blocker'))}`);
});

test('a REST collection migrates to real Playwright API tests, not broken browser specs', async () => {
  const sample = SAMPLES.find((s) => s.id === 'rest-to-playwright-api');
  const discovery = runDiscovery(sample.spec);
  assert.equal(discovery.target.id, 'playwright-api');

  const project = { id: id('prj'), name: 'api', spec: sample.spec, interview: { answers: {}, ready: true } };
  project.discovery = discovery;
  const { proposals } = proposeAgents(discovery);
  project.proposals = { agents: proposals.map((p) => ({ ...p, decision: 'accepted' })), guardrails: [] };
  project.graph = composeWorkflow(project.proposals.agents);

  const run = await executeRun(createRun(project).id, project);
  const spec = run.ws.generated.find((a) => a.path.endsWith('.spec.ts'));
  assert.ok(spec, 'an API spec file is produced');
  assert.match(spec.content, /await request\.(get|post)\(/, 'it uses APIRequestContext, not the page fixture');
  assert.ok(!spec.content.includes('{ page }'), 'no browser page fixture in an API spec');

  const balanced = (text, open, close) =>
    [...text].filter((c) => c === open).length === [...text].filter((c) => c === close).length;
  assert.ok(balanced(spec.content, '(', ')'), 'parentheses balance');
  assert.ok(balanced(spec.content, '{', '}'), 'braces balance');
  assert.ok(
    !spec.content.includes('response.status()') || spec.content.includes('const response = await request'),
    'any response assertion has a response binding to read',
  );
});
