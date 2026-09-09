/**
 * End-to-end smoke test of the control plane, with no HTTP layer and no network.
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runDiscovery } from '../src/engine/discovery.js';
import { proposeAgents } from '../src/engine/agentFactory.js';
import { proposeGuardrails } from '../src/engine/guardrailDesigner.js';
import { composeWorkflow } from '../src/engine/workflowComposer.js';
import { createRun, executeRun } from '../src/engine/orchestrator.js';
import { assessSpec } from '../src/engine/interview.js';
import { SAMPLES } from '../src/samples.js';
import { id, now } from '../src/lib/util.js';

function projectFrom(sample, answers = {}) {
  return {
    id: id('prj'),
    name: sample.name,
    spec: sample.spec,
    interview: { answers, ready: true },
    createdAt: now(),
  };
}

async function pipeline(sample, answers = {}) {
  const project = projectFrom(sample, answers);
  project.discovery = runDiscovery(project.spec);
  const { proposals, gaps } = proposeAgents(project.discovery);
  project.discovery.gaps = gaps;
  const guardrails = proposeGuardrails(project.discovery);
  project.proposals = {
    agents: proposals.map((p) => ({ ...p, decision: 'accepted' })),
    guardrails: guardrails.map((g) => ({ ...g, decision: 'accepted' })),
  };
  project.graph = composeWorkflow(project.proposals.agents);
  const run = createRun(project);
  return executeRun(run.id, project);
}

test('selenium java → playwright ts: parses, generates and preserves assertions', async () => {
  const sample = SAMPLES.find((s) => s.id === 'selenium-to-playwright');
  const discovery = runDiscovery(sample.spec);

  assert.equal(discovery.source.id, 'selenium-java', 'source technology detected');
  assert.equal(discovery.target.id, 'playwright-ts', 'target technology detected');
  assert.equal(discovery.entities.suites, 2);
  assert.equal(discovery.entities.tests, 5);
  assert.equal(discovery.entities.assertions, 6, 'all six TestNG assertions found');
  assert.equal(discovery.entities.dataFiles, 1);
  assert.equal(discovery.entities.dataRecords, 4);
  assert.ok(discovery.gaps.length === 0, 'no capability gaps for a fully supported pair');

  const finished = await pipeline(sample);
  const specs = finished.ws.generated.filter((a) => a.path.endsWith('.spec.ts'));
  assert.ok(specs.length >= 2, 'playwright spec files generated');

  const login = specs.find((a) => a.path.includes('login'));
  assert.match(login.content, /page\.goto\('https:\/\/shop\.example\.com\/login'\)/);
  assert.match(login.content, /page\.locator\('#username'\)\.fill/);
  assert.match(login.content, /await expect\(page\)\.toHaveTitle\('Products'\)/);
  assert.match(login.content, /process\.env\.PASSWORD/, 'hardcoded password moved to the environment');

  const assertionCheck = finished.validation.results.find((r) => r.guardrailId === 'guard.no-assertion-loss');
  assert.equal(assertionCheck.status, 'pass', assertionCheck.evidence);

  const testCheck = finished.validation.results.find((r) => r.guardrailId === 'guard.no-test-case-loss');
  assert.equal(testCheck.status, 'pass', testCheck.evidence);

  const dataCheck = finished.validation.results.find((r) => r.guardrailId === 'guard.test-data-preservation');
  assert.equal(dataCheck.status, 'pass', dataCheck.evidence);

  const secrets = finished.validation.results.find((r) => r.guardrailId === 'guard.no-secret-leakage');
  assert.equal(secrets.status, 'pass', secrets.evidence);

  assert.ok(finished.ws.generated.some((a) => a.path === 'tests/_unmapped.spec.ts'), 'JavascriptExecutor surfaced, not dropped');
  assert.ok(finished.trace.counts.links > 0, 'trace graph has links');
  assert.match(finished.report, /Migration report/);
});

test('cypress → playwright: the factory swaps the analyzer and adds command mapping', async () => {
  const sample = SAMPLES.find((s) => s.id === 'cypress-to-playwright');
  const discovery = runDiscovery(sample.spec);
  assert.equal(discovery.source.id, 'cypress');
  assert.equal(discovery.entities.tests, 3);

  const { proposals } = proposeAgents(discovery);
  const capabilities = proposals.map((p) => p.capability);
  assert.ok(capabilities.includes('source.analyze.cypress'));
  assert.ok(capabilities.includes('mapping.command.cypress-playwright'), 'command mapper added for this pair only');

  const finished = await pipeline(sample);
  assert.ok(finished.ws.generated.some((a) => a.path === 'analysis/command-map.json'));
  assert.ok(finished.ws.generated.some((a) => a.path.endsWith('.spec.ts')));
});

test('rest collection → playwright api: contract parity is computed, not claimed', async () => {
  const sample = SAMPLES.find((s) => s.id === 'rest-to-playwright-api');
  const finished = await pipeline(sample);
  assert.equal(finished.discovery.entities.requests, 3);

  const contract = finished.validation.results.find((r) => r.guardrailId === 'guard.api-contract-preservation');
  assert.equal(contract.status, 'pass', contract.evidence);
  const auth = finished.validation.results.find((r) => r.guardrailId === 'guard.auth-validation');
  assert.ok(['pass', 'warn'].includes(auth.status), auth.evidence);
});

test('junit → pytest: a language change uses the same control plane', async () => {
  const sample = SAMPLES.find((s) => s.id === 'junit-to-pytest');
  const finished = await pipeline(sample);
  assert.ok(finished.ws.generated.some((a) => a.path.startsWith('tests/test_')));
  assert.equal(finished.discovery.entities.tests, 3);
});

test('unsupported source raises a capability gap instead of pretending', async () => {
  const sample = SAMPLES.find((s) => s.id === 'gap-demo');
  const discovery = runDiscovery(sample.spec);
  const { gaps } = proposeAgents(discovery);
  assert.ok(gaps.length > 0, 'a gap is raised');
  assert.match(gaps[0].needs, /parser|emitter|implementation/i);
});

test('the interview blocks an empty spec and unblocks once answered', async () => {
  const empty = { requirements: '', sourceStack: '', targetStack: '', artifacts: [], constraints: '' };
  const before = await assessSpec(empty, {}, { withLlm: false });
  assert.equal(before.ready, false);
  assert.ok(before.blockingCount >= 3, `expected blocking questions, got ${before.blockingCount}`);

  const sample = SAMPLES.find((s) => s.id === 'selenium-to-playwright');
  const after = await assessSpec(sample.spec, {}, { withLlm: false });
  assert.equal(after.blockingCount, 0, JSON.stringify(after.questions.map((q) => q.id)));
  assert.equal(after.ready, true);
});

test('workflow composer orders by phase and rejects a generator with no analyzer', () => {
  const graph = composeWorkflow([
    { proposalId: 'a', agentId: 'x', name: 'Gen', capability: 'target.generate.playwright-ts', group: 'Target generation', phase: 30, impl: 'playwrightTsGenerator', inputs: [], outputs: [], source: 'reuse' },
  ]);
  assert.equal(graph.order.length, 1);
  assert.ok(graph.errors.some((e) => e.includes('no source analyzer')));
});
