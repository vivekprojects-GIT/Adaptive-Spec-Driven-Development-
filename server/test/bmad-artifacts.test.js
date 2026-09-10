/**
 * The BMAD Artifact Agent.
 *
 * The documents must be DERIVED — every requirement row, every epic, every graph node has to come
 * from what the run actually found. A brief that reads well but says things the run cannot support
 * is worse than no brief at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runDiscovery } from '../src/engine/discovery.js';
import { proposeAgents } from '../src/engine/agentFactory.js';
import { proposeGuardrails } from '../src/engine/guardrailDesigner.js';
import { composeWorkflow } from '../src/engine/workflowComposer.js';
import { createRun, executeRun } from '../src/engine/orchestrator.js';
import { exampleSpec } from '../src/templates.js';
import { listAgents } from '../src/registry/agents.js';
import { id } from '../src/lib/util.js';

async function runProject(spec) {
  const project = { id: id('prj'), name: 'bmad docs', spec, interview: { answers: {}, ready: true } };
  project.discovery = runDiscovery(spec);
  const { proposals, gaps } = proposeAgents(project.discovery);
  project.discovery.gaps = gaps;
  project.proposals = {
    agents: proposals.map((p) => ({ ...p, decision: 'accepted' })),
    guardrails: proposeGuardrails(project.discovery).map((g) => ({ ...g, decision: 'accepted' })),
  };
  project.graph = composeWorkflow(project.proposals.agents);
  return { project, run: await executeRun(createRun(project).id, project) };
}

test('the BMAD agent is in the registry and is proposed by default', () => {
  const agent = listAgents().find((a) => a.capability === 'docs.bmad.generate');
  assert.ok(agent, 'registered');
  assert.equal(agent.impl, 'bmadArtifactAgent');

  const discovery = runDiscovery(exampleSpec('selenium-to-playwright'));
  assert.ok(discovery.capabilities.some((c) => c.id === 'docs.bmad.generate'), 'required by discovery');

  const { proposals } = proposeAgents(discovery);
  const proposal = proposals.find((p) => p.capability === 'docs.bmad.generate');
  assert.equal(proposal.source, 'reuse', 'it is a registry hit, not a synthesised placeholder');
});

test('turning the BMAD document set off removes it from the graph', () => {
  const discovery = runDiscovery({ ...exampleSpec('selenium-to-playwright'), bmadArtifacts: false });
  assert.ok(!discovery.capabilities.some((c) => c.id === 'docs.bmad.generate'), 'not required when switched off');
});

test('it runs after traceability so the PRD can link requirements to artifacts', async () => {
  const { run } = await runProject(exampleSpec('selenium-to-playwright'));
  const order = run.nodes.map((n) => n.capability);
  assert.ok(
    order.indexOf('docs.bmad.generate') > order.indexOf('traceability.build'),
    `expected the docs after traceability, got ${order.join(' -> ')}`,
  );
  assert.ok(
    order.indexOf('docs.bmad.generate') > order.indexOf('target.generate.playwright-ts'),
    'and after the generator, so it can list what was produced',
  );
});

test('the four documents are written and derived from the run, not templated', async () => {
  const { run } = await runProject(exampleSpec('selenium-to-playwright'));
  const docs = Object.fromEntries(
    run.ws.generated.filter((a) => a.path.startsWith('docs/')).map((a) => [a.path, a.content]),
  );

  assert.deepEqual(
    Object.keys(docs).sort(),
    ['docs/architecture.md', 'docs/epics-and-stories.md', 'docs/prd.md', 'docs/product-brief.md'],
    'the full BMAD chain is written',
  );

  // Brief: real counts, and the constraint the human actually typed.
  assert.match(docs['docs/product-brief.md'], /5 test case\(s\) across 2 suite\(s\)/);
  assert.match(docs['docs/product-brief.md'], /6 assertion\(s\)/);
  assert.match(docs['docs/product-brief.md'], /4 fixture record\(s\)/);
  assert.match(docs['docs/product-brief.md'], /headless in CI/, 'the constraint from the spec is carried in');
  assert.match(docs['docs/product-brief.md'], /JavascriptExecutor/, 'the unmappable construct is a stated non-goal');

  // PRD: every requirement traced to the artifact that covers it.
  for (const requirementId of ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004', 'REQ-005']) {
    assert.match(docs['docs/prd.md'], new RegExp(`\\| ${requirementId} \\|`), `${requirementId} has a row`);
  }
  assert.match(docs['docs/prd.md'], /tests\/logintest\.spec\.ts/, 'rows name the generated artifact');
  assert.match(docs['docs/prd.md'], /No Assertion Loss \| blocker/, 'the accepted guardrails are the acceptance criteria');
  assert.ok(!docs['docs/prd.md'].includes('not covered'), 'nothing is reported uncovered when everything traced');

  // Architecture: the actual approved graph, agent by agent.
  assert.match(docs['docs/architecture.md'], /Selenium Java Analyzer.*source\.analyze\.selenium-java/);
  assert.match(docs['docs/architecture.md'], /Playwright TypeScript Generator/);
  assert.match(docs['docs/architecture.md'], /`playwrightTsGenerator`/, 'implementations are named');
  for (const node of run.nodes) {
    assert.ok(docs['docs/architecture.md'].includes(node.name), `${node.name} appears in the architecture`);
  }

  // Epics: one epic per suite, one story per test, status computed.
  assert.match(docs['docs/epics-and-stories.md'], /\*\*E1 LoginTest\*\*/);
  assert.match(docs['docs/epics-and-stories.md'], /\*\*E2 CheckoutTest\*\*/);
  assert.match(docs['docs/epics-and-stories.md'], /S1\.1 userCanLogInWithValidCredentials/);
  assert.match(docs['docs/epics-and-stories.md'], /Port by hand/, 'unmappable work becomes its own epic');
  assert.equal((docs['docs/epics-and-stories.md'].match(/\| S\d+\.\d+ /g) || []).length, 5, 'one story per source test');
});

test('the documents state what the run does not know rather than inventing it', async () => {
  const { run } = await runProject({
    projectKind: 'migration',
    sourceStack: 'Selenium WebDriver (Java) with TestNG',
    targetStack: 'Playwright (TypeScript)',
    requirements: 'REQ-900 Something nobody wrote a test for',
    constraints: '',
    artifacts: [{ path: 'src/test/java/EmptyTest.java', content: 'public class EmptyTest { }' }],
  });
  const brief = run.ws.generated.find((a) => a.path === 'docs/product-brief.md').content;
  const prd = run.ws.generated.find((a) => a.path === 'docs/prd.md').content;

  assert.match(brief, /No source tests were parsed/, 'the brief admits it parsed nothing');
  assert.match(prd, /\*\*not covered\*\*/, 'the PRD marks the untraced requirement rather than claiming coverage');
});
