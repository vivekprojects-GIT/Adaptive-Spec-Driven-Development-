/**
 * Assertion fidelity for API migrations.
 *
 * The point of the platform is that a check present in the source is present in the output — as
 * working code, not as a comment. These tests use a collection with the assertion shapes people
 * actually write, including one deliberately unportable check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSourceModel } from '../src/engine/parsers.js';
import { runDiscovery } from '../src/engine/discovery.js';
import { proposeAgents } from '../src/engine/agentFactory.js';
import { composeWorkflow } from '../src/engine/workflowComposer.js';
import { createRun, executeRun } from '../src/engine/orchestrator.js';
import { id } from '../src/lib/util.js';

const COLLECTION = JSON.stringify({
  info: { name: 'Rich checks' },
  item: [
    {
      name: 'List widgets',
      request: { method: 'GET', header: [], url: { raw: 'https://api.example.com/widgets' } },
      event: [
        {
          listen: 'test',
          script: {
            exec: [
              'pm.test("status is 200", function () { pm.response.to.have.status(200); });',
              'pm.test("returns json", function () { pm.response.to.have.header("Content-Type", "application/json"); });',
              'pm.test("has three widgets", function () { pm.expect(pm.response.json().total).to.eql(3); });',
              'pm.test("mentions widget", function () { pm.expect(pm.response.text()).to.include("widget"); });',
              'pm.test("has an id field", function () { pm.expect(pm.response.json()).to.have.property("id"); });',
              'pm.test("is fast", function () { pm.expect(pm.response.responseTime).to.be.below(500); });',
              'pm.test("business rule holds", function () { const x = compute(pm.response); if (!weirdLegacyHelper(x)) throw new Error("nope"); });',
            ],
          },
        },
      ],
    },
  ],
}, null, 2);

const SPEC = {
  projectKind: 'migration',
  sourceStack: 'Legacy REST API tests (Postman collection)',
  targetStack: 'Playwright API testing (TypeScript)',
  requirements: 'REQ-001 The widgets endpoint returns the widget list',
  constraints: '',
  artifacts: [{ path: 'collections/widgets.postman_collection.json', content: COLLECTION }],
};

test('every assertion shape in a Postman script is parsed, not just counted', () => {
  const model = buildSourceModel('rest-collection', SPEC.artifacts);
  const subjects = model.suites[0].tests[0].assertions.map((a) => a.subject);

  assert.deepEqual(
    subjects.sort(),
    ['contains', 'custom', 'header', 'json', 'property', 'responseTime', 'status'].sort(),
    `parsed subjects were ${JSON.stringify(subjects)}`,
  );
  assert.equal(model.totals.assertions, 7, 'seven checks in, seven assertions recorded');

  const status = model.suites[0].tests[0].assertions.find((a) => a.subject === 'status');
  assert.equal(status.expected, '200', 'the expected status is read from the check, not guessed');

  const json = model.suites[0].tests[0].assertions.find((a) => a.subject === 'json');
  assert.equal(json.target, '.total');
  assert.equal(json.expected, '3');

  assert.ok(
    model.unmapped.some((u) => u.construct.includes('business rule holds')),
    'the unrecognised check is surfaced as unmapped, not silently dropped',
  );
});

test('a status check is not double-counted against an inferred one', () => {
  const model = buildSourceModel('rest-collection', SPEC.artifacts);
  const statuses = model.suites[0].tests[0].assertions.filter((a) => a.subject === 'status');
  assert.equal(statuses.length, 1, 'one status check in the source is one assertion, not two');
});

test('parsed API assertions become real Playwright code and parity holds', async () => {
  const project = { id: id('prj'), name: 'rich api', spec: SPEC, interview: { answers: {}, ready: true } };
  project.discovery = runDiscovery(SPEC);
  const { proposals, gaps } = proposeAgents(project.discovery);
  project.discovery.gaps = gaps;
  project.proposals = { agents: proposals.map((p) => ({ ...p, decision: 'accepted' })), guardrails: [] };
  project.graph = composeWorkflow(project.proposals.agents);

  const run = await executeRun(createRun(project).id, project);
  const spec = run.ws.generated.find((a) => a.path.endsWith('.spec.ts'));

  assert.match(spec.content, /expect\(response\.status\(\)\)\.toBe\(200\)/, 'status ported');
  assert.match(spec.content, /expect\(response\.headers\(\)\['content-type'\]\)\.toContain\('application\/json'\)/, 'header ported');
  assert.match(spec.content, /const body = await response\.json\(\)/, 'body read once when needed');
  assert.match(spec.content, /expect\(body\.total\)\.toEqual\(3\)/, 'json path equality ported as a number, not a string');
  assert.match(spec.content, /expect\(body\)\.toHaveProperty\('id'\)/, 'property check ported');
  assert.match(spec.content, /expect\(await response\.text\(\)\)\.toContain\('widget'\)/, 'body-contains ported');

  // The check that cannot be ported must fail loudly rather than vanish into a comment.
  assert.match(spec.content, /unported source check: business rule holds/);
  assert.match(spec.content, /expect\(false,/, 'the unportable check becomes a failing expectation');

  // Every binding the generated code reads must be one the generated code declared.
  assert.match(spec.content, /const startedAt = Date\.now\(\);[\s\S]*Date\.now\(\) - startedAt/, 'the timer is started before it is read');
  const bodyDeclaration = spec.content.indexOf('const body = await response.json()');
  assert.ok(bodyDeclaration > -1 && bodyDeclaration < spec.content.indexOf('expect(body'), 'body is declared before it is used');
  assert.ok(
    spec.content.indexOf('expect(response.status()') < bodyDeclaration,
    'status is asserted before the body is parsed, so a non-JSON response fails on the status, not on a parse error',
  );
  assert.equal((spec.content.match(/const body = await response\.json\(\)/g) || []).length, 1, 'the body is parsed once');

  const sourceCount = run.discovery.entities.assertions;
  const generatedCount = (spec.content.match(/\bexpect\s*\(/g) || []).length;
  assert.ok(generatedCount >= sourceCount, `generated ${generatedCount} assertions for ${sourceCount} source assertions`);
});
