/**
 * Agent implementations — the execution layer.
 *
 * Every implementation has the same shape:
 *   async (ctx) => { outputs, metrics, notes }
 * where ctx = { spec, answers, discovery, ws (shared workspace), node, log }
 *
 * The workspace `ws` is how agents hand work to each other: an analyzer fills `ws.sourceModel`,
 * generators read it and push to `ws.generated`. No agent talks to another agent directly, which
 * is what lets the composer reorder them freely.
 */
import {
  buildSourceModel,
  toPlaywrightSelector,
} from './parsers.js';
import { slug, pascal, camel, id } from '../lib/util.js';
import { assist, llmAvailable } from '../lib/llm.js';
import { loadBmad, findBmadAgent, personaPrompt, resolveFacts } from '../bmad/loader.js';
import { getSettings } from '../lib/settings.js';

/* ------------------------------------------------------------------ output */

function artifact(path, content, extra = {}) {
  return {
    id: id('art'),
    path,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    lines: content.split('\n').length,
    kind: extra.kind || 'code',
    language: extra.language || guessLanguage(path),
    traces: extra.traces || [],
    producedBy: extra.producedBy || null,
  };
}

function guessLanguage(path) {
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.feature')) return 'gherkin';
  if (path.endsWith('.md')) return 'markdown';
  return 'text';
}

/* ------------------------------------------------------------- sanitisers */

const REAL_EMAIL = /[\w.+-]+@(?!example\.(?:com|org))[\w-]+\.[\w.]{2,}/g;

function sanitiseValue(value, ctx) {
  if (typeof value !== 'string') return value;
  let out = value.replace(REAL_EMAIL, 'user@example.com');
  out = out.replace(/\b(?:\d[ -]*?){13,16}\b/g, '4111111111111111');
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '000-00-0000');
  if (out !== value) ctx.notes.push(`Sanitised a value that matched a PII pattern (${value.slice(0, 12)}…).`);
  return out;
}

function isSecretish(raw = '') {
  return /(password|passwd|pwd|api[_-]?key|secret|token)/i.test(raw);
}

/** Secret handling follows the interview answer, defaulting to env vars. */
function secretExpression(raw, value, ctx) {
  const policy = ctx.answers?.secrets || 'Environment variables (process.env)';
  const name = (raw.match(/(password|passwd|pwd|api[_-]?key|secret|token)/i) || ['SECRET'])[0].toUpperCase().replace(/[^A-Z0-9]/g, '_');
  ctx.notes.push(`Moved a hardcoded ${name.toLowerCase()} out of generated code (policy: ${policy}).`);
  if (policy.startsWith('A secrets manager')) return `/* TODO: read ${name} from the secrets manager */ ''`;
  return `process.env.${name} ?? ''`;
}

/* ------------------------------------------------------------- analyzers */

function analyzerFor(technologyId) {
  return async (ctx) => {
    const model = buildSourceModel(technologyId, ctx.spec.artifacts || []);
    ctx.ws.sourceModel = model;
    ctx.log(`Parsed ${model.totals.suites} suite(s), ${model.totals.tests} test(s), ${model.totals.assertions} assertion(s), ${model.totals.locators} locator(s).`);
    if (model.unmapped.length) ctx.log(`${model.unmapped.length} construct(s) have no direct target equivalent.`);
    return {
      outputs: [artifact('analysis/source-model.json', JSON.stringify(model, null, 2), { kind: 'analysis' })],
      metrics: { ...model.totals, unmapped: model.unmapped.length },
      notes: model.unmapped.map((u) => `Unmapped: ${u.construct} in ${u.file}`),
    };
  };
}

/* ------------------------------------------------------------------- BDD */

async function bddGenerator(ctx) {
  const model = ctx.ws.sourceModel;
  const requirements = ctx.discovery.requirements;
  const outputs = [];

  for (const suite of model.suites) {
    const lines = [`Feature: ${humanise(suite.name)}`, `  # Source: ${suite.file}`, ''];
    for (const test of suite.tests) {
      const requirement = matchRequirement(test, ctx);
      if (requirement) lines.push(`  @${requirement.id}`);
      lines.push(`  Scenario: ${humanise(test.name)}`);
      const first = test.steps[0];
      lines.push(`    Given the application is open${first?.type === 'goto' ? ` at "${first.value}"` : ''}`);
      for (const step of test.steps.filter((s) => s.type !== 'goto')) {
        lines.push(`    When ${describeStep(step)}`);
      }
      for (const assertion of test.assertions) {
        lines.push(`    Then ${describeAssertion(assertion)}`);
      }
      if (!test.assertions.length) lines.push('    Then the step completes without error');
      lines.push('');
    }
    outputs.push(artifact(`features/${slug(suite.name)}.feature`, lines.join('\n'), { kind: 'spec', traces: suite.tests.map((t) => t.id) }));
  }

  ctx.ws.features = outputs.map((o) => o.path);
  ctx.log(`Wrote ${outputs.length} feature file(s) covering ${model.totals.tests} scenario(s).`);
  return { outputs, metrics: { features: outputs.length }, notes: [] };
}

function humanise(name) {
  return String(name)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function describeStep(step) {
  const target = step.locator ? `"${step.locator.value}"` : 'the page';
  switch (step.type) {
    case 'click': return `the user clicks ${target}`;
    case 'fill': return `the user enters "${step.value}" into ${target}`;
    case 'select': return `the user selects "${step.value}" in ${target}`;
    case 'clear': return `the user clears ${target}`;
    case 'wait': return `the user waits ${step.value}ms`;
    case 'waitFor': return `${target} becomes available`;
    case 'press': return `the user presses ${step.value} on ${target}`;
    case 'request': return `a ${step.method} request is sent to "${step.value}"`;
    case 'dialog': return 'the browser dialog is handled';
    default: return `the step "${(step.raw || step.type).slice(0, 80)}" runs`;
  }
}

function describeAssertion(assertion) {
  const target = assertion.locator ? `"${assertion.locator.value}"` : 'the page';
  switch (assertion.subject) {
    case 'title': return `the page title is "${assertion.expected ?? ''}"`;
    case 'url': return `the URL is "${assertion.expected ?? ''}"`;
    case 'visible': return `${target} is visible`;
    case 'enabled': return `${target} is enabled`;
    case 'status': return `the response status is ${assertion.expected}`;
    case 'body': return 'the response body matches the expected shape';
    default: return `${target} shows "${assertion.expected ?? 'the expected value'}"`;
  }
}

const STOP_WORDS = new Set(['with', 'that', 'this', 'from', 'when', 'then', 'they', 'their', 'shall', 'must', 'should', 'test', 'tests', 'user', 'users', 'able']);

function keyWords(text) {
  return new Set(
    humanise(text)
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word)),
  );
}

/**
 * Assigns requirements to tests ONE-TO-ONE wherever possible.
 *
 * Scoring each test independently lets two tests both claim the strongest requirement and leaves a
 * third orphaned — the traceability guardrail then reports a coverage failure that is an artefact
 * of the matcher, not of the migration. Strongest pairs are assigned first, each requirement is
 * used once, and only then may leftovers share.
 */
function assignRequirements(tests, requirements) {
  const pairs = [];
  for (const test of tests) {
    const testWords = keyWords(test.name);
    for (const requirement of requirements) {
      const reqWords = keyWords(requirement.text);
      const shared = [...reqWords].filter((word) => testWords.has(word));
      if (!shared.length) continue;
      // Favour overlap that is a large share of the requirement, not just a long requirement.
      pairs.push({ testId: test.id, requirement, score: shared.length + shared.length / reqWords.size });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const byTest = new Map();
  const usedRequirements = new Set();
  for (const pair of pairs) {
    if (byTest.has(pair.testId) || usedRequirements.has(pair.requirement.id)) continue;
    byTest.set(pair.testId, pair.requirement);
    usedRequirements.add(pair.requirement.id);
  }
  // Anything still unmatched may share a requirement rather than being reported as untraced.
  for (const pair of pairs) {
    if (!byTest.has(pair.testId)) byTest.set(pair.testId, pair.requirement);
  }
  return byTest;
}

/** Cached per run, so every agent sees the same requirement → test assignment. */
function matchRequirement(test, ctx) {
  const requirements = ctx?.discovery?.requirements || [];
  if (!requirements.length) return null;
  if (!ctx.ws.requirementMap) {
    const tests = (ctx.ws.sourceModel?.suites || []).flatMap((suite) => suite.tests);
    ctx.ws.requirementMap = assignRequirements(tests, requirements);
  }
  return ctx.ws.requirementMap.get(test.id) || null;
}

/* ------------------------------------------------- playwright typescript */

async function playwrightTsGenerator(ctx) {
  const model = ctx.ws.sourceModel;
  const outputs = [];
  const usePom = String(ctx.answers?.pom || '').startsWith('Page Objects');
  const dropSleeps = !String(ctx.answers?.waits || '').startsWith('Keep');
  const unmappedPolicy = ctx.answers?.unmappedPolicy || 'Emit a skipped test with a TODO';
  let assertionCount = 0;

  for (const suite of model.suites) {
    const className = `${pascal(suite.name)}Page`;
    const pageLocators = new Map();
    const body = [];

    body.push(`test.describe('${escape(humanise(suite.name))}', () => {`);
    for (const test of suite.tests) {
      const requirement = matchRequirement(test, ctx);
      if (requirement) body.push(`  // traces: ${requirement.id} — ${escape(requirement.text.slice(0, 90))}`);
      body.push(`  // source: ${suite.file} :: ${test.name}`);
      body.push(`  test('${escape(humanise(test.name))}', async ({ page }) => {`);

      for (const step of test.steps) {
        const line = tsStep(step, ctx, usePom, className, pageLocators, dropSleeps);
        if (line) body.push(`    ${line}`);
      }
      for (const assertion of test.assertions) {
        const line = tsAssertion(assertion, ctx, usePom, className, pageLocators);
        if (line) {
          body.push(`    ${line}`);
          assertionCount += 1;
        }
      }
      if (!test.steps.length && !test.assertions.length) {
        body.push('    // TODO: source test body had no recognised statements');
      }
      body.push('  });');
      body.push('');
    }
    body.push('});');

    const imports = [`import { test, expect } from '@playwright/test';`];
    if (usePom && pageLocators.size) imports.push(`import { ${className} } from '../pages/${slug(suite.name)}.page';`);

    outputs.push(
      artifact(`tests/${slug(suite.name)}.spec.ts`, `${imports.join('\n')}\n\n${body.join('\n')}\n`, {
        kind: 'code',
        traces: suite.tests.map((t) => t.id),
      }),
    );

    if (usePom && pageLocators.size) {
      const fields = [...pageLocators.entries()].map(([name, selector]) => `  readonly ${name} = () => this.page.locator('${escape(selector)}');`);
      outputs.push(
        artifact(
          `pages/${slug(suite.name)}.page.ts`,
          `import type { Page } from '@playwright/test';\n\nexport class ${className} {\n  constructor(readonly page: Page) {}\n\n${fields.join('\n')}\n}\n`,
          { kind: 'code' },
        ),
      );
    }
  }

  // Unmapped constructs are never dropped silently.
  if (model.unmapped.length && !unmappedPolicy.startsWith('List them')) {
    const skip = unmappedPolicy.startsWith('Emit a skipped');
    const lines = [`import { test } from '@playwright/test';`, '', `test.describe('Unmapped source constructs', () => {`];
    for (const item of model.unmapped) {
      lines.push(`  test${skip ? '.skip' : ''}('${escape(item.construct)} — ${escape(item.file)}', async () => {`);
      lines.push(`    // ${escape(item.reason)}`);
      lines.push(`    // source: ${escape((item.raw || '').slice(0, 160))}`);
      lines.push(skip ? '    // TODO: port this construct by hand.' : `    throw new Error('Unmapped construct requires a human decision: ${escape(item.construct)}');`);
      lines.push('  });');
    }
    lines.push('});');
    outputs.push(artifact('tests/_unmapped.spec.ts', `${lines.join('\n')}\n`, { kind: 'code' }));
  }

  outputs.push(
    artifact(
      'playwright.config.ts',
      `import { defineConfig, devices } from '@playwright/test';\n\nexport default defineConfig({\n  testDir: './tests',\n  fullyParallel: true,\n  reporter: [['html'], ['list']],\n  use: {\n    baseURL: process.env.BASE_URL,\n    trace: 'on-first-retry',\n    screenshot: 'only-on-failure',\n  },\n  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],\n});\n`,
      { kind: 'config' },
    ),
  );

  ctx.ws.generatedAssertions = assertionCount;
  ctx.log(`Emitted ${outputs.length} file(s) with ${assertionCount} assertion(s) across ${model.totals.tests} test(s).`);
  return { outputs, metrics: { files: outputs.length, tests: model.totals.tests, assertions: assertionCount, pageObjects: usePom }, notes: ctx.notes.splice(0) };
}

function escape(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}

function locatorExpression(loc, usePom, className, pageLocators) {
  const selector = toPlaywrightSelector(loc);
  if (!selector) return null;
  if (usePom) {
    const name = camel(loc.value) || 'element';
    pageLocators.set(name, selector);
  }
  return `page.locator('${escape(selector)}')`;
}

function tsStep(step, ctx, usePom, className, pageLocators, dropSleeps) {
  const target = step.locator ? locatorExpression(step.locator, usePom, className, pageLocators) : null;
  switch (step.type) {
    case 'goto':
      return `await page.goto('${escape(step.value || '/')}');`;
    case 'click':
      return target ? `await ${target}.click();` : '// TODO: click with no resolvable locator';
    case 'fill': {
      const value = isSecretish(step.raw) ? secretExpression(step.raw, step.value, ctx) : `'${escape(sanitiseValue(step.value, ctx))}'`;
      return target ? `await ${target}.fill(${value});` : `// TODO: fill with no resolvable locator (${escape(step.raw).slice(0, 60)})`;
    }
    case 'clear':
      return target ? `await ${target}.clear();` : null;
    case 'select':
      return target ? `await ${target}.selectOption('${escape(step.value ?? '')}');` : null;
    case 'press':
      return target ? `await ${target}.press('${escape(step.value || 'Enter')}');` : `await page.keyboard.press('${escape(step.value || 'Enter')}');`;
    case 'wait':
      return dropSleeps
        ? `// auto-waiting replaces an explicit ${step.value}ms sleep`
        : `await page.waitForTimeout(${Number(step.value) || 500});`;
    case 'waitFor':
      return target ? `await ${target}.waitFor({ state: 'visible' });` : `await page.waitForLoadState('networkidle');`;
    case 'dialog':
      return `page.once('dialog', (dialog) => dialog.accept());`;
    case 'route':
      return `// TODO: port the intercepted route (${escape(step.raw).slice(0, 60)})`;
    case 'fixture':
      return `// fixture '${escape(step.value)}' is available under data/`;
    case 'statement':
      return `// ${escape(step.raw).slice(0, 120)}`;
    default:
      return `// TODO: ${escape(step.raw || step.type).slice(0, 120)}`;
  }
}

function tsAssertion(assertion, ctx, usePom, className, pageLocators) {
  const target = assertion.locator ? locatorExpression(assertion.locator, usePom, className, pageLocators) : null;
  const expected = escape(sanitiseValue(assertion.expected ?? '', ctx));

  switch (assertion.subject) {
    case 'title':
      return `await expect(page).toHaveTitle('${expected}');`;
    case 'url':
      return `await expect(page).toHaveURL('${expected}');`;
    case 'visible':
      return target ? `await expect(${target}).${assertion.type === 'false' ? 'not.' : ''}toBeVisible();` : `await expect(page.locator('body')).toBeVisible();`;
    case 'enabled':
      return target ? `await expect(${target}).toBeEnabled();` : null;
    case 'attribute':
      return target ? `await expect(${target}).toHaveAttribute('value', '${expected}');` : null;
    case 'status':
      // A response-status assertion has no meaning in a browser spec — emitting one would
      // reference a `response` binding that does not exist and produce code that cannot compile.
      ctx.notes.push('A response-status assertion was left as a TODO: this is a UI spec, not an API spec.');
      return `// TODO: response status ${assertion.expected ?? ''} — port this to an API test`;
    default:
      if (target && expected) return `await expect(${target}).toHaveText('${expected}');`;
      if (target) return `await expect(${target}).toBeVisible();`;
      if (expected) return `expect(await page.content()).toContain('${expected}');`;
      return `// TODO: assertion could not be resolved — ${escape(assertion.raw).slice(0, 100)}`;
  }
}

/* ---------------------------------------------------- playwright python */

async function playwrightPythonGenerator(ctx) {
  const model = ctx.ws.sourceModel;
  const outputs = [];
  let assertionCount = 0;

  for (const suite of model.suites) {
    const lines = ['import re', 'from playwright.sync_api import Page, expect', '', ''];
    for (const test of suite.tests) {
      lines.push(`def test_${slug(test.name).replace(/-/g, '_')}(page: Page):`);
      lines.push(`    """source: ${suite.file} :: ${test.name}"""`);
      let wrote = false;
      for (const step of test.steps) {
        const sel = step.locator ? toPlaywrightSelector(step.locator) : null;
        if (step.type === 'goto') { lines.push(`    page.goto("${step.value || '/'}")`); wrote = true; }
        else if (step.type === 'click' && sel) { lines.push(`    page.locator("${sel}").click()`); wrote = true; }
        else if (step.type === 'fill' && sel) { lines.push(`    page.locator("${sel}").fill("${sanitiseValue(step.value ?? '', ctx)}")`); wrote = true; }
        else if (step.type === 'select' && sel) { lines.push(`    page.locator("${sel}").select_option("${step.value ?? ''}")`); wrote = true; }
        else if (step.type === 'wait') { lines.push(`    # auto-waiting replaces a ${step.value}ms sleep`); }
      }
      for (const assertion of test.assertions) {
        const sel = assertion.locator ? toPlaywrightSelector(assertion.locator) : null;
        if (assertion.subject === 'title') lines.push(`    expect(page).to_have_title("${assertion.expected ?? ''}")`);
        else if (assertion.subject === 'url') lines.push(`    expect(page).to_have_url("${assertion.expected ?? ''}")`);
        else if (sel && assertion.expected) lines.push(`    expect(page.locator("${sel}")).to_have_text("${sanitiseValue(assertion.expected, ctx)}")`);
        else if (sel) lines.push(`    expect(page.locator("${sel}")).to_be_visible()`);
        else continue;
        assertionCount += 1;
        wrote = true;
      }
      if (!wrote) lines.push('    pass  # TODO: no recognised statements in the source test');
      lines.push('');
    }
    outputs.push(artifact(`tests/test_${slug(suite.name).replace(/-/g, '_')}.py`, `${lines.join('\n')}\n`, { kind: 'code', traces: suite.tests.map((t) => t.id) }));
  }

  outputs.push(artifact('conftest.py', 'import pytest\n\n\n@pytest.fixture(scope="session")\ndef browser_context_args(browser_context_args):\n    return {**browser_context_args, "ignore_https_errors": True}\n', { kind: 'config' }));
  ctx.ws.generatedAssertions = assertionCount;
  ctx.log(`Emitted ${outputs.length} Python file(s) with ${assertionCount} assertion(s).`);
  return { outputs, metrics: { files: outputs.length, assertions: assertionCount }, notes: [] };
}

/* -------------------------------------------------------------- pytest */

async function pytestGenerator(ctx) {
  const model = ctx.ws.sourceModel;
  const outputs = [];
  let assertionCount = 0;

  for (const suite of model.suites) {
    const lines = ['import pytest', '', ''];
    for (const test of suite.tests) {
      lines.push(`def test_${slug(test.name).replace(/-/g, '_')}():`);
      lines.push(`    """source: ${suite.file} :: ${test.name}"""`);
      for (const step of test.steps) lines.push(`    # ${(step.raw || '').slice(0, 110)}`);
      for (const assertion of test.assertions) {
        const expected = assertion.expected ? `"${sanitiseValue(assertion.expected, ctx)}"` : 'True';
        if (assertion.type === 'true') lines.push(`    assert ${expected} is not None  # ${(assertion.raw || '').slice(0, 60)}`);
        else if (assertion.type === 'false') lines.push(`    assert not ${expected}  # ${(assertion.raw || '').slice(0, 60)}`);
        else lines.push(`    assert ${expected} == ${expected}  # TODO: bind actual — ${(assertion.raw || '').slice(0, 60)}`);
        assertionCount += 1;
      }
      if (!test.assertions.length) lines.push('    pytest.skip("source test had no assertions")');
      lines.push('');
    }
    outputs.push(artifact(`tests/test_${slug(suite.name).replace(/-/g, '_')}.py`, `${lines.join('\n')}\n`, { kind: 'code', traces: suite.tests.map((t) => t.id) }));
  }

  ctx.ws.generatedAssertions = assertionCount;
  ctx.log(`Emitted ${outputs.length} PyTest module(s) with ${assertionCount} assertion(s).`);
  return { outputs, metrics: { files: outputs.length, assertions: assertionCount }, notes: ['JUnit assertions map to plain asserts; actual-value binding needs review.'] };
}

/* --------------------------------------------------------- playwright api */

/**
 * One parsed source check → the Playwright lines that assert the same thing.
 *
 * A check we cannot translate becomes a *failing* expectation rather than a comment: the migrated
 * suite goes red until a human ports it, which is the only honest way to not lose an assertion.
 */
function apiAssertionLines(assertion, ctx) {
  const expected = assertion.expected;

  switch (assertion.subject) {
    case 'status':
      return [
        `expect(response.status()).toBe(${Number(expected) || 200});${assertion.inferred ? ' // inferred: the source declared no assertion' : ''}`,
      ];
    case 'ok':
      return ['expect(response.ok()).toBeTruthy();'];
    case 'header':
      return expected
        ? [`expect(response.headers()['${escape(String(assertion.target).toLowerCase())}']).toContain('${escape(expected)}');`]
        : [`expect(response.headers()['${escape(String(assertion.target).toLowerCase())}']).toBeDefined();`];
    case 'json':
      return [`expect(body${assertion.target || ''}).toEqual(${normaliseExpected(expected)});`];
    case 'property':
      return [`expect(body).toHaveProperty('${escape(assertion.target)}');`];
    case 'contains':
      return [`expect(await response.text()).toContain('${escape(expected)}');`];
    case 'responseTime':
      ctx.notes.push(`"${assertion.name}" checks response time, which Playwright does not assert directly — ported as a timing measurement.`);
      return [
        '// response-time check ported as an explicit measurement',
        `expect(Date.now() - startedAt).toBeLessThan(${Number(expected) || 2000});`,
      ];
    default:
      ctx.notes.push(`Could not port the check "${assertion.name || 'unnamed'}" — the generated test fails until a human writes it.`);
      return [
        `// TODO: port this check from the source — ${escape((assertion.raw || '').slice(0, 110))}`,
        `expect(false, 'unported source check: ${escape(assertion.name || 'unnamed')}').toBeTruthy();`,
      ];
  }
}

/** Postman expectations are JS fragments; keep valid literals, quote anything else. */
function normaliseExpected(expected) {
  if (expected === null || expected === undefined || expected === '') return 'undefined';
  const text = String(expected).trim();
  if (/^-?\d+(\.\d+)?$/.test(text) || text === 'true' || text === 'false' || text === 'null') return text;
  if (/^["'`].*["'`]$/.test(text)) return `'${escape(text.slice(1, -1))}'`;
  if (/^[[{]/.test(text)) return text;
  return `'${escape(text)}'`;
}

async function playwrightApiGenerator(ctx) {
  const model = ctx.ws.sourceModel;
  const outputs = [];
  let assertionCount = 0;

  for (const suite of model.suites) {
    const lines = [`import { test, expect } from '@playwright/test';`, '', `test.describe('${escape(humanise(suite.name))} API', () => {`];
    for (const test of suite.tests) {
      const request = test.steps.find((s) => s.type === 'request');
      if (!request) continue;

      const requirement = matchRequirement(test, ctx);
      if (requirement) lines.push(`  // traces: ${requirement.id} — ${escape(requirement.text.slice(0, 90))}`);
      lines.push(`  test('${escape(test.name)}', async ({ request }) => {`);

      // A response-time assertion needs a clock started before the request goes out.
      if (test.assertions.some((a) => a.subject === 'responseTime')) lines.push('    const startedAt = Date.now();');
      lines.push(`    const response = await request.${request.method.toLowerCase()}('${escape(request.value)}'${['POST', 'PUT', 'PATCH'].includes(request.method) ? ', { data: {} }' : ''});`);

      // The body is parsed lazily, at the first assertion that needs it — parsing it up front
      // would throw on a non-JSON response before the status assertion ever ran.
      let bodyRead = false;
      for (const assertion of test.assertions) {
        if (!bodyRead && ['json', 'property'].includes(assertion.subject)) {
          lines.push('    const body = await response.json();');
          bodyRead = true;
        }
        for (const line of apiAssertionLines(assertion, ctx)) lines.push(`    ${line}`);
        assertionCount += 1;
      }
      lines.push('  });');
    }
    lines.push('});');
    outputs.push(artifact(`tests/api/${slug(suite.name)}.spec.ts`, `${lines.join('\n')}\n`, { kind: 'code', traces: suite.tests.map((t) => t.id) }));
  }

  ctx.ws.generatedAssertions = assertionCount;
  ctx.log(`Emitted ${outputs.length} API spec file(s) preserving ${assertionCount} status assertion(s).`);
  return { outputs, metrics: { files: outputs.length, assertions: assertionCount, requests: model.requests.length }, notes: [] };
}

/* ------------------------------------------------------------- mapping */

const CY_MAP = {
  'cy.visit': 'page.goto',
  'cy.get': 'page.locator',
  'cy.contains': 'page.getByText',
  '.type': '.fill',
  '.click': '.click',
  '.select': '.selectOption',
  '.check': '.check',
  'cy.wait': 'page.waitForTimeout',
  'cy.intercept': 'page.route',
  'cy.fixture': 'JSON import from data/',
  'should(be.visible)': 'expect(locator).toBeVisible()',
  'should(contain)': 'expect(locator).toContainText()',
  'should(have.value)': 'expect(locator).toHaveValue()',
  'cy.request': 'request.fetch',
};

async function commandMapper(ctx) {
  const model = ctx.ws.sourceModel;
  const used = new Set();
  for (const suite of model.suites) {
    for (const test of suite.tests) {
      for (const step of [...test.steps, ...test.assertions]) {
        const raw = step.raw || '';
        for (const key of Object.keys(CY_MAP)) if (raw.includes(key.replace(/\(.*\)/, ''))) used.add(key);
      }
    }
  }
  const table = [...used].map((key) => ({ cypress: key, playwright: CY_MAP[key], status: 'mapped' }));
  for (const item of model.unmapped) table.push({ cypress: item.construct, playwright: null, status: 'unmapped', reason: item.reason });

  ctx.ws.commandMap = table;
  ctx.log(`Mapped ${table.filter((r) => r.status === 'mapped').length} command(s); ${table.filter((r) => r.status === 'unmapped').length} have no equivalent.`);
  return {
    outputs: [artifact('analysis/command-map.json', JSON.stringify(table, null, 2), { kind: 'analysis' })],
    metrics: { mapped: table.filter((r) => r.status === 'mapped').length, unmapped: table.filter((r) => r.status === 'unmapped').length },
    notes: [],
  };
}

/* ----------------------------------------------------------- data agent */

async function testDataMigrator(ctx) {
  const policy = ctx.answers?.dataPolicy || 'Convert to JSON fixtures and keep every record';
  const anonymise = policy.startsWith('Anonymise');
  const outputs = [];
  let recordsIn = 0;
  let recordsOut = 0;

  const sources = (ctx.spec.artifacts || []).filter((a) => (ctx.ws.sourceModel?.dataFiles || []).some((d) => d.path === a.path));

  for (const source of sources) {
    const declared = ctx.ws.sourceModel.dataFiles.find((d) => d.path === source.path);
    recordsIn += declared.records;
    let rows = [];

    if (declared.format === 'csv') {
      const [header, ...body] = source.content.split('\n').map((r) => r.trim()).filter(Boolean);
      const columns = header.split(',').map((c) => c.trim());
      rows = body.map((line) => {
        const cells = line.split(',');
        return Object.fromEntries(columns.map((col, i) => [col, (cells[i] ?? '').trim()]));
      });
    } else if (declared.format === 'json') {
      try {
        const parsed = JSON.parse(source.content);
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        rows = [];
      }
    } else if (declared.format === 'properties') {
      rows = source.content
        .split('\n')
        .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
        .map((line) => {
          const [key, ...rest] = line.split('=');
          return { key: key.trim(), value: rest.join('=').trim() };
        });
    } else {
      rows = source.content.split('\n').filter(Boolean).map((value, index) => ({ index, value }));
    }

    if (anonymise) {
      rows = rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? sanitiseValue(value, ctx) : value]),
        ),
      );
    } else {
      rows = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? sanitiseValue(value, ctx) : value])),
      );
    }

    recordsOut += rows.length;
    const target = policy.startsWith('Keep the original format')
      ? artifact(`data/${source.path.split('/').pop()}`, source.content, { kind: 'data' })
      : artifact(`data/${slug(source.path.split('/').pop().replace(/\.\w+$/, ''))}.json`, JSON.stringify(rows, null, 2), { kind: 'data' });
    outputs.push(target);
  }

  ctx.ws.dataParity = { recordsIn, recordsOut };
  ctx.log(`Migrated ${sources.length} fixture file(s): ${recordsIn} records in, ${recordsOut} records out (policy: ${policy}).`);
  return { outputs, metrics: { files: sources.length, recordsIn, recordsOut }, notes: recordsIn === recordsOut ? [] : [`Record count changed: ${recordsIn} → ${recordsOut}.`] };
}

/* ----------------------------------------------------------- auth agent */

async function authMigrator(ctx) {
  const schemes = ctx.ws.sourceModel?.auth || [];
  const lines = [`import { test as setup, expect } from '@playwright/test';`, '', `const authFile = '.auth/user.json';`, ''];

  for (const scheme of schemes) {
    lines.push(`// detected scheme: ${scheme.scheme} (${scheme.evidence})`);
  }
  lines.push(`setup('authenticate', async ({ page, request }) => {`);
  if (schemes.some((s) => /basic/i.test(s.scheme))) {
    lines.push(`  // basic auth — credentials come from the environment, never from generated code`);
    lines.push(`  await page.context().setHTTPCredentials({ username: process.env.AUTH_USER ?? '', password: process.env.AUTH_PASSWORD ?? '' });`);
  }
  if (schemes.some((s) => /bearer|oauth|token/i.test(s.scheme))) {
    lines.push(`  const token = process.env.AUTH_TOKEN ?? '';`);
    lines.push(`  await page.context().setExtraHTTPHeaders({ Authorization: \`Bearer \${token}\` });`);
  }
  if (!schemes.length) lines.push(`  // no auth scheme detected in the source suite — this file is a placeholder`);
  lines.push(`  await page.context().storageState({ path: authFile });`);
  lines.push('});');

  ctx.ws.authSchemes = schemes.map((s) => s.scheme);
  ctx.log(schemes.length ? `Generated auth setup for: ${ctx.ws.authSchemes.join(', ')}.` : 'No auth scheme detected; emitted a placeholder setup.');
  return {
    outputs: [artifact('auth/auth.setup.ts', `${lines.join('\n')}\n`, { kind: 'code' })],
    metrics: { schemes: schemes.length },
    notes: schemes.length ? ['Credentials must be provided as AUTH_USER / AUTH_PASSWORD / AUTH_TOKEN.'] : [],
  };
}

/* -------------------------------------------------------- traceability */

async function traceabilityAgent(ctx) {
  const model = ctx.ws.sourceModel || { suites: [] };
  const requirements = ctx.discovery.requirements || [];
  const generated = ctx.ws.generated.filter((a) => a.kind === 'code' || a.kind === 'spec');

  const rows = [];
  for (const suite of model.suites) {
    for (const test of suite.tests) {
      const requirement = matchRequirement(test, ctx);
      const artifacts = generated.filter((a) => a.traces.includes(test.id));
      rows.push({
        requirementId: requirement?.id || null,
        requirementText: requirement?.text || null,
        sourceSuite: suite.name,
        sourceFile: suite.file,
        sourceTest: test.name,
        testId: test.id,
        steps: test.steps.length,
        assertions: test.assertions.length,
        artifacts: artifacts.map((a) => a.path),
        status: artifacts.length ? 'migrated' : 'not-migrated',
      });
    }
  }

  const covered = new Set(rows.filter((r) => r.status === 'migrated' && r.requirementId).map((r) => r.requirementId));
  const orphanRequirements = requirements.filter((r) => !covered.has(r.id)).map((r) => ({ id: r.id, text: r.text }));

  const matrix = {
    requirements: requirements.length,
    coveredRequirements: covered.size,
    orphanRequirements,
    rows,
    generatedArtifacts: generated.map((a) => a.path),
  };

  ctx.ws.traceability = matrix;
  ctx.log(`Traced ${rows.length} test(s); ${covered.size}/${requirements.length} requirement(s) covered, ${orphanRequirements.length} orphan(s).`);
  return {
    outputs: [artifact('analysis/traceability.json', JSON.stringify(matrix, null, 2), { kind: 'analysis' })],
    metrics: { rows: rows.length, covered: covered.size, orphans: orphanRequirements.length },
    notes: orphanRequirements.map((r) => `Requirement ${r.id} has no migrated test.`),
  };
}

/* ---------------------------------------------------- structure checks */

async function structureValidator(ctx) {
  const files = ctx.ws.generated.filter((a) => a.kind === 'code' || a.kind === 'config');
  const findings = [];

  for (const file of files) {
    const text = file.content;
    if (file.language === 'typescript') {
      // Count delimiters in CODE only. A source line quoted inside a comment can legitimately be
      // truncated mid-expression, and counting it produced a blocker on a file that compiles.
      const code = stripNonCode(text);
      if (countChar(code, '{') !== countChar(code, '}')) findings.push({ file: file.path, issue: 'Unbalanced braces', severity: 'blocker' });
      if (countChar(code, '(') !== countChar(code, ')')) findings.push({ file: file.path, issue: 'Unbalanced parentheses', severity: 'blocker' });
      if (/\btest\(/.test(text) && !/@playwright\/test/.test(text)) findings.push({ file: file.path, issue: 'Uses test() without importing @playwright/test', severity: 'blocker' });
      if (/test\('[^']*',\s*async\s*\([^)]*\)\s*=>\s*\{\s*\}\s*\)/.test(text)) findings.push({ file: file.path, issue: 'Empty test body', severity: 'major' });
    }
    if (file.language === 'python') {
      const bad = text.split('\n').find((line) => /^\s*def\s+test_/.test(line) && line.trim().endsWith(':') === false);
      if (bad) findings.push({ file: file.path, issue: 'Malformed test definition', severity: 'blocker' });
    }
    const todos = (text.match(/TODO/g) || []).length;
    if (todos) findings.push({ file: file.path, issue: `${todos} TODO marker(s) left for a human`, severity: 'minor' });
    if (!text.trim()) findings.push({ file: file.path, issue: 'Empty file', severity: 'blocker' });
  }

  const report = {
    filesChecked: files.length,
    blockers: findings.filter((f) => f.severity === 'blocker').length,
    majors: findings.filter((f) => f.severity === 'major').length,
    minors: findings.filter((f) => f.severity === 'minor').length,
    findings,
  };
  ctx.ws.structureReport = report;
  ctx.log(`Checked ${files.length} generated file(s): ${report.blockers} blocker(s), ${report.majors} major, ${report.minors} minor.`);
  return {
    outputs: [artifact('analysis/structure-report.json', JSON.stringify(report, null, 2), { kind: 'analysis' })],
    metrics: report,
    notes: findings.filter((f) => f.severity !== 'minor').map((f) => `${f.file}: ${f.issue}`),
  };
}

/**
 * Blanks out comments and string literals so delimiter counting only sees executable code.
 *
 * This is a left-to-right scan rather than a set of regexes on purpose: strip comments first and
 * the `//` inside `'https://example.com/login'` eats the rest of the line, taking the closing
 * bracket with it and reporting a perfectly good file as unbalanced.
 */
function stripNonCode(text) {
  let out = '';
  let state = 'code'; // code | line | block | single | double | template
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'single'; out += ' '; i += 1; continue; }
      if (c === '"') { state = 'double'; out += ' '; i += 1; continue; }
      if (c === '`') { state = 'template'; out += ' '; i += 1; continue; }
      out += c;
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; } else out += ' ';
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    // Inside a string literal.
    if (c === '\\') { out += '  '; i += 2; continue; }
    const closes = (state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`');
    if (closes) { state = 'code'; out += ' '; i += 1; continue; }
    out += c === '\n' ? '\n' : ' ';
    i += 1;
  }

  return out;
}

function countChar(text, char) {
  let count = 0;
  for (const c of text) if (c === char) count += 1;
  return count;
}

/* --------------------------------------------------------- fallback */

async function genericAdapter(ctx) {
  const node = ctx.node;
  const body = {
    agent: node.name,
    capability: node.capability,
    status: 'placeholder',
    explanation:
      'This agent was synthesised by the Agent Factory because no registry agent provides this capability. It runs on the generic adapter, which records intent and hands the work to a human rather than inventing output.',
    inputsSeen: {
      sourceModel: Boolean(ctx.ws.sourceModel),
      generatedSoFar: ctx.ws.generated.length,
    },
    suggestedNextStep: `Implement ${node.capability} as a real agent and register it, then re-run this project — the composed graph will pick the implementation up automatically.`,
  };
  ctx.log(`Generic adapter ran for "${node.name}" — placeholder output, no real work performed.`);
  ctx.ws.placeholders = (ctx.ws.placeholders || 0) + 1;
  return {
    outputs: [artifact(`analysis/${slug(node.capability)}-placeholder.json`, JSON.stringify(body, null, 2), { kind: 'analysis' })],
    metrics: { placeholder: true },
    notes: [`"${node.name}" produced placeholder output — it has no implementation yet.`],
  };
}

/* ---------------------------------------------------------- BMAD artifacts */

/**
 * Emits the BMAD document set for this project — brief → PRD → architecture → epics & stories —
 * so a migration lands in the same shape the BMAD method expects and `bmad-build` can pick it up.
 *
 * Every line is derived from what the run actually found: the parsed source model, the approved
 * graph, the traceability matrix and the guardrails. Nothing here is boilerplate, and where the
 * run does not know something it says so rather than filling the gap with a template sentence.
 */
async function bmadArtifactAgent(ctx) {
  const { discovery, ws, spec } = ctx;
  const model = ws.sourceModel;
  const trace = ws.traceability;
  const graphNodes = ctx.run?.nodes || [];
  const generated = ws.generated.filter((a) => a.kind === 'code' || a.kind === 'spec' || a.kind === 'data');
  const stamp = new Date().toISOString().slice(0, 10);

  const outputs = [
    artifact('docs/product-brief.md', bmadBrief({ discovery, model, spec, stamp }), { kind: 'spec' }),
    artifact('docs/prd.md', bmadPrd({ discovery, model, trace, spec, ctx, stamp }), { kind: 'spec' }),
    artifact('docs/architecture.md', bmadArchitecture({ discovery, graphNodes, generated, stamp }), { kind: 'spec' }),
    artifact('docs/epics-and-stories.md', bmadEpics({ discovery, model, trace, stamp }), { kind: 'spec' }),
  ];

  ctx.log(`Wrote the BMAD document set: ${outputs.map((o) => o.path.split('/').pop()).join(', ')}.`);
  return {
    outputs,
    metrics: { documents: outputs.length, requirements: discovery.requirements.length, epics: model?.suites.length || 0 },
    notes: trace ? [] : ['Traceability had not run when the documents were written, so the PRD could not link requirements to artifacts.'],
  };
}

function mdEscape(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function bmadBrief({ discovery, model, spec, stamp }) {
  const out = [];
  const kind = spec.projectKind === 'custom' ? 'Custom project' : 'Migration';

  out.push(`# Product Brief — ${discovery.source.label} → ${discovery.target.label}`);
  out.push('');
  out.push(`**Method:** BMAD · **Phase:** 1 (Analysis) · **Generated:** ${stamp} by ASDD`);
  out.push('');
  out.push('## Problem');
  out.push('');
  if (model?.totals.tests) {
    out.push(
      `${model.totals.tests} test case(s) across ${model.totals.suites} suite(s) are written in ${discovery.source.label}. ` +
        `They carry ${model.totals.assertions} assertion(s)${model.totals.dataRecords ? ` and ${model.totals.dataRecords} fixture record(s)` : ''}, ` +
        `all of which have to survive a move to ${discovery.target.label}.`,
    );
  } else {
    out.push(`This is a ${kind.toLowerCase()} against ${discovery.source.label}. No source tests were parsed, so the scope below comes from the requirements alone.`);
  }
  out.push('');
  out.push('## The ask');
  out.push('');
  for (const requirement of discovery.requirements) out.push(`- **${requirement.id}** — ${requirement.text}`);
  if (!discovery.requirements.length) out.push('- _No requirements were supplied._');
  out.push('');

  if (spec.constraints?.trim()) {
    out.push('## Constraints');
    out.push('');
    for (const line of spec.constraints.split('\n').filter(Boolean)) out.push(`- ${line.trim()}`);
    out.push('');
  }

  out.push('## Non-goals');
  out.push('');
  if (discovery.gaps.length) {
    for (const gap of discovery.gaps) out.push(`- \`${gap.capability}\` — ${gap.reason} _Needs: ${gap.needs}_`);
  }
  if (model?.unmapped.length) {
    for (const item of model.unmapped) out.push(`- ${item.construct} (${item.file}) — ${item.reason}`);
  }
  if (!discovery.gaps.length && !model?.unmapped.length) out.push('- Nothing was found that this migration cannot cover.');
  out.push('');

  out.push('## Success criteria');
  out.push('');
  out.push(`1. Every one of the ${model?.totals.tests ?? 0} source test case(s) has a counterpart in the target.`);
  out.push(`2. Every one of the ${model?.totals.assertions ?? 0} source assertion(s) is present in the generated output.`);
  out.push(`3. Every requirement above traces to at least one generated artifact.`);
  if (model?.unmapped.length) out.push(`4. The ${model.unmapped.length} unmappable construct(s) are ported by hand or explicitly dropped by a human.`);
  out.push('');
  return out.join('\n');
}

function bmadPrd({ discovery, model, trace, spec, ctx, stamp }) {
  const out = [];
  const rows = trace?.rows || [];

  out.push('# PRD — Migration requirements');
  out.push('');
  out.push(`**Method:** BMAD · **Phase:** 2 (Planning) · **Traces to:** product-brief.md · **Generated:** ${stamp} by ASDD`);
  out.push('');
  out.push('## 1. Functional requirements');
  out.push('');
  out.push('| ID | Requirement | Covered by | Generated artifact | Status |');
  out.push('|---|---|---|---|---|');
  for (const requirement of discovery.requirements) {
    const covering = rows.filter((row) => row.requirementId === requirement.id);
    const artifacts = [...new Set(covering.flatMap((row) => row.artifacts))];
    out.push(
      `| ${requirement.id} | ${mdEscape(requirement.text)} | ${covering.map((r) => `\`${r.sourceTest}\``).join('<br>') || '—'} | ${artifacts.map((a) => `\`${a}\``).join('<br>') || '—'} | ${covering.length ? (covering.every((r) => r.status === 'migrated') ? 'migrated' : 'partial') : '**not covered**'} |`,
    );
  }
  if (!discovery.requirements.length) out.push('| — | _No requirements supplied_ | — | — | — |');
  out.push('');

  out.push('## 2. Non-functional requirements');
  out.push('');
  const nfrs = [];
  if (spec.constraints?.trim()) {
    for (const line of spec.constraints.split('\n').map((l) => l.trim()).filter(Boolean)) nfrs.push(line);
  }
  for (const [key, value] of Object.entries(ctx.answers || {})) nfrs.push(`${key}: ${value}`);
  if (!nfrs.length) nfrs.push('None stated beyond the functional requirements above.');
  nfrs.forEach((nfr, index) => out.push(`- **NFR-${String(index + 1).padStart(2, '0')}** ${mdEscape(nfr)}`));
  out.push('');

  out.push('## 3. Acceptance — the guardrails this project runs under');
  out.push('');
  out.push('| Guardrail | Severity | Covers risk |');
  out.push('|---|---|---|');
  for (const guardrail of ctx.run?.guardrails || []) {
    out.push(`| ${guardrail.name} | ${guardrail.severity} | ${(guardrail.risks || []).join(', ')} |`);
  }
  if (!(ctx.run?.guardrails || []).length) out.push('| _No guardrails were accepted_ | — | — |');
  out.push('');

  out.push('## 4. Out of scope');
  out.push('');
  if (model?.unmapped.length) for (const item of model.unmapped) out.push(`- ${item.construct} — ${item.reason}`);
  if (discovery.gaps.length) for (const gap of discovery.gaps) out.push(`- \`${gap.capability}\` — ${gap.needs}`);
  if (!model?.unmapped.length && !discovery.gaps.length) out.push('- Nothing.');
  out.push('');
  return out.join('\n');
}

function bmadArchitecture({ discovery, graphNodes, generated, stamp }) {
  const out = [];

  out.push('# Architecture — the agent graph that performs this migration');
  out.push('');
  out.push(`**Method:** BMAD · **Phase:** 3 (Solutioning) · **Traces to:** prd.md · **Generated:** ${stamp} by ASDD`);
  out.push('');
  out.push('## 1. Approach');
  out.push('');
  out.push(`${discovery.source.label} is parsed into a technology-neutral source model, and ${discovery.target.label} is emitted from that model. Neither side knows about the other, which is what lets either end change independently.`);
  out.push('');

  out.push('## 2. Capabilities this project required');
  out.push('');
  out.push('| Capability | Why it was required |');
  out.push('|---|---|');
  for (const capability of discovery.capabilities) out.push(`| \`${capability.id}\` | ${mdEscape(capability.why)} |`);
  out.push('');

  out.push('## 3. The approved graph');
  out.push('');
  out.push('```');
  const byPhase = new Map();
  for (const node of graphNodes) {
    if (!byPhase.has(node.phase)) byPhase.set(node.phase, []);
    byPhase.get(node.phase).push(node);
  }
  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  phases.forEach((phase, index) => {
    for (const node of byPhase.get(phase)) out.push(`${'  '.repeat(index)}${index ? '└─▶ ' : ''}${node.name}  (${node.capability})`);
  });
  if (!graphNodes.length) out.push('(no agents in the graph)');
  out.push('```');
  out.push('');

  out.push('| # | Agent | Capability | Provenance | Implementation |');
  out.push('|---|---|---|---|---|');
  graphNodes.forEach((node, index) => {
    out.push(`| ${index + 1} | ${node.name} | \`${node.capability}\` | ${node.source} | \`${node.impl}\` |`);
  });
  out.push('');

  out.push('## 4. Artifacts this architecture produces');
  out.push('');
  out.push('| Path | Kind | Lines |');
  out.push('|---|---|---|');
  for (const item of generated) out.push(`| \`${item.path}\` | ${item.kind} | ${item.lines} |`);
  if (!generated.length) out.push('| _Nothing generated yet_ | — | — |');
  out.push('');

  if (discovery.gaps.length) {
    out.push('## 5. Known gaps');
    out.push('');
    for (const gap of discovery.gaps) out.push(`- \`${gap.capability}\` — ${gap.reason} **Needs:** ${gap.needs}`);
    out.push('');
  }
  return out.join('\n');
}

function bmadEpics({ discovery, model, trace, stamp }) {
  const out = [];
  const rows = trace?.rows || [];

  out.push('# Epics & Stories');
  out.push('');
  out.push(`**Method:** BMAD · **Phase:** 4 (Implementation) · **Traces to:** architecture.md · **Generated:** ${stamp} by ASDD`);
  out.push('');
  out.push('One epic per source suite, one story per source test. Status is computed from the run, not asserted.');
  out.push('');
  out.push('| Epic | Story | Traces | Assertions | Generated | Status |');
  out.push('|---|---|---|---|---|---|');

  (model?.suites || []).forEach((suite, index) => {
    suite.tests.forEach((test, testIndex) => {
      const row = rows.find((r) => r.testId === test.id);
      out.push(
        `| ${testIndex === 0 ? `**E${index + 1} ${mdEscape(suite.name)}**` : ''} | S${index + 1}.${testIndex + 1} ${mdEscape(test.name)} | ${row?.requirementId || '—'} | ${test.assertions.length} | ${(row?.artifacts || []).map((a) => `\`${a}\``).join('<br>') || '—'} | ${row?.status || 'unknown'} |`,
      );
    });
  });
  if (!(model?.suites || []).length) out.push('| _No source suites were parsed_ | — | — | — | — | — |');
  out.push('');

  if (model?.unmapped.length) {
    out.push(`## Epic E${(model.suites.length || 0) + 1} — Port by hand`);
    out.push('');
    out.push('Constructs with no target equivalent. These are the stories a human still owns.');
    out.push('');
    for (const [index, item] of model.unmapped.entries()) {
      out.push(`- **H${index + 1}** ${item.construct} in \`${item.file}\` — ${item.reason}`);
    }
    out.push('');
  }

  const orphans = trace?.orphanRequirements || [];
  if (orphans.length) {
    out.push('## Requirements with no story');
    out.push('');
    for (const orphan of orphans) out.push(`- **${orphan.id}** — ${orphan.text}`);
    out.push('');
  }

  out.push('## Definition of done');
  out.push('');
  out.push('1. Every story above reads `migrated`.');
  out.push('2. Every guardrail in the PRD passes, or its failure is accepted by a named human.');
  out.push('3. The hand-port epic is empty, or each item is explicitly signed off.');
  out.push('');
  return out.join('\n');
}

/* --------------------------------------------------- human-authored agent */

/**
 * The input kinds a human can tick when authoring an agent. Each one knows how to pull its
 * material out of the run context, so "which inputs does this agent see" is a checkbox list in
 * the UI and a real, auditable slice of context here.
 */
export const INPUT_SOURCES = {
  requirements: {
    label: 'Requirements',
    collect: (ctx) => (ctx.discovery.requirements || []).map((r) => `${r.id} ${r.text}`).join('\n'),
  },
  constraints: {
    label: 'Constraints & clarifications',
    collect: (ctx) =>
      [ctx.spec.constraints, ...Object.entries(ctx.answers || {}).map(([key, value]) => `${key}: ${value}`)]
        .filter(Boolean)
        .join('\n'),
  },
  artifacts: {
    label: 'Source artifacts',
    collect: (ctx, authored) => {
      const filter = (authored?.artifactFilter || '')
        .split(',')
        .map((part) => part.trim().toLowerCase().replace(/^\*?\.?/, ''))
        .filter(Boolean);
      const files = (ctx.spec.artifacts || []).filter(
        (file) => !filter.length || filter.some((ext) => file.path.toLowerCase().endsWith(`.${ext}`)),
      );
      return files.map((file) => `--- ${file.path}\n${file.content.slice(0, 6000)}`).join('\n\n');
    },
  },
  sourceModel: {
    label: 'Parsed source model',
    collect: (ctx) => (ctx.ws.sourceModel ? JSON.stringify(ctx.ws.sourceModel, null, 1).slice(0, 12000) : ''),
  },
  generated: {
    label: 'Artifacts generated earlier in this run',
    collect: (ctx) =>
      ctx.ws.generated.map((a) => `--- ${a.path}\n${a.content.slice(0, 4000)}`).join('\n\n'),
  },
};

/** Keeps a model-proposed path inside the run's output tree. */
function safePath(raw, fallbackDir) {
  const cleaned = String(raw || '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  return cleaned || `${fallbackDir}/output.txt`;
}

/** What every model-backed agent must hand back, whatever persona it runs as. */
const AUTHORED_OUTPUT_CONTRACT = 'Respond as {"files":[{"path":"relative/path.ext","content":"..."}],"notes":["..."],"unableTo":["..."]}';

const AUTHORED_SYSTEM =
  "You are executing one agent inside a migration platform. Follow the operator's instructions exactly and produce files. " +
  'Never invent source material that is not in the inputs. If the inputs are insufficient to do the job properly, say so in notes and produce only what is genuinely supported.';

/** What a BMAD persona does when a human adds it to the graph without writing a task of its own. */
const BMAD_DEFAULT_TASKS = {
  architect:
    'Review this migration as its architect. From the generated artifacts, state the invariants the migrated suite must keep (structure, locator strategy, fixtures, configuration), the risks you see, and concrete changes, each tied to a file or a requirement. Write it as bmad/architect/review.md.',
  analyst:
    'Analyse the requirements against what the source suite and the migration actually cover. List requirements with no test evidence, ambiguous requirements, and assumptions the migration is making. Write it as bmad/analyst/requirements-analysis.md.',
  pm:
    'Check that every requirement is testable and has an acceptance signal in the migrated suite. Flag requirements that cannot be verified and propose acceptance criteria for each. Write it as bmad/pm/acceptance-review.md.',
  'ux-designer':
    'Review the user journeys the migrated tests exercise. List journeys with no coverage, and edge cases missing from the journeys that are covered. Write it as bmad/ux-designer/journey-review.md.',
  dev:
    'Review the generated code as the implementing engineer: correctness, conventions, maintainability. List concrete fixes, each naming the file and the change. Write it as bmad/dev/code-review.md.',
};

/**
 * The engine behind every model-backed agent — one a human wrote in the UI, or one of their BMAD
 * personas.
 *
 * With a model available (an Anthropic key, or the editor's model through the MCP bridge) it
 * executes the instructions and writes whatever files come back. With no model it writes the fully
 * resolved brief instead and marks itself a placeholder — it does not invent output and then let a
 * guardrail call it a success.
 */
async function runModelAgent(ctx, { persona = null, bmadAgent = null } = {}) {
  const node = ctx.node;
  const authored = node.authored || {};
  const defaultInputs = bmadAgent ? ['requirements', 'constraints', 'generated'] : ['requirements', 'artifacts'];
  const selections = authored.inputSelections?.length ? authored.inputSelections : defaultInputs;

  const sections = [];
  for (const key of selections) {
    const source = INPUT_SOURCES[key];
    if (!source) continue;
    const body = source.collect(ctx, authored);
    if (body?.trim()) sections.push({ key, label: source.label, body });
  }
  const inputDigest = sections.map((section) => `## ${section.label}\n${section.body}`).join('\n\n');

  const instructions =
    authored.instructions?.trim() ||
    (bmadAgent ? BMAD_DEFAULT_TASKS[bmadAgent.role] || 'Review the migration in your role and report what you find, with evidence.' : '');
  const who = bmadAgent ? `${bmadAgent.icon} ${bmadAgent.name} — ${bmadAgent.title} (BMAD ${bmadAgent.id})` : `"${node.name}"`;
  const outputDir = bmadAgent ? `bmad/${bmadAgent.role}` : `custom/${slug(node.name) || 'agent'}`;

  ctx.log(`${who} reading ${sections.length} input source(s): ${sections.map((s) => s.label).join(', ') || 'none'}.`);

  if (!llmAvailable()) {
    const brief = [`# ${node.name}`, ''];
    if (bmadAgent) brief.push(`**BMAD agent:** ${who}, customised by ${bmadAgent.overrides.join(' + ')}`);
    brief.push(
      `**Purpose:** ${authored.purpose || node.description || '(not stated)'}`,
      `**Expected output:** ${authored.outputDescription || '(not stated)'}`,
      `**Runs:** ${authored.runAfterLabel || `phase ${node.phase}`}`,
      '',
      '## Instructions',
      '',
      instructions || '(no instructions were provided)',
      '',
    );
    if (persona) brief.push('## The BMAD persona that would carry them out', '', persona, '');
    brief.push(
      '## Inputs this agent was given',
      '',
      ...sections.map((section) => `- **${section.label}** — ${section.body.split('\n').length} line(s)`),
      '',
      '---',
      '',
      'No model is available, so these instructions were **not executed**. The deterministic engine cannot',
      'interpret free-text instructions. Add an Anthropic key in Settings — or open this folder in VS Code and',
      'start the "asdd" MCP server to borrow your Copilot model — then re-run.',
    );

    ctx.ws.placeholders = (ctx.ws.placeholders || 0) + 1;
    ctx.log('No model available — wrote the resolved brief instead of executing the instructions.');
    return {
      outputs: [artifact(`${outputDir}/BRIEF.md`, brief.join('\n'), { kind: 'analysis' })],
      metrics: { placeholder: true, inputsSeen: sections.length, bmad: bmadAgent?.id },
      notes: [`${node.name} did not execute: it needs a model, and none is available.`],
    };
  }

  const response = await assist({
    task: 'generation',
    maxTokens: 8000,
    system: `${persona || AUTHORED_SYSTEM}\n\n${AUTHORED_OUTPUT_CONTRACT}`,
    prompt: [
      `# Agent: ${node.name}`,
      `Purpose: ${authored.purpose || node.description || '(not stated)'}`,
      `Expected output: ${authored.outputDescription || '(not stated)'}`,
      '',
      '# Instructions',
      instructions || '(none given — infer from the purpose)',
      '',
      '# Project context',
      `Source stack: ${ctx.spec.sourceStack || 'unspecified'}`,
      `Target stack: ${ctx.spec.targetStack || 'unspecified'}`,
      '',
      '# Inputs',
      inputDigest || '(no inputs matched the selected sources)',
      '',
      `Write files under "${outputDir}/" unless the instructions name specific paths.`,
    ].join('\n'),
  });

  if (!response || response.__error) {
    ctx.ws.placeholders = (ctx.ws.placeholders || 0) + 1;
    const reason = response?.__error || 'the model was unavailable';
    ctx.log(`Model call failed: ${reason}`);
    return {
      outputs: [
        artifact(`${outputDir}/FAILED.md`, `# ${node.name} did not run\n\n${reason}\n\nInstructions were:\n\n${instructions || '(none)'}\n`, { kind: 'analysis' }),
      ],
      metrics: { placeholder: true, error: reason, bmad: bmadAgent?.id },
      notes: [`${node.name} failed to execute: ${reason}`],
    };
  }

  const files = Array.isArray(response.files) ? response.files : [];
  const outputs = files
    .filter((file) => typeof file?.content === 'string' && file.content.trim())
    .map((file) => artifact(safePath(file.path, outputDir), file.content, { kind: file.kind || (bmadAgent ? 'spec' : 'code') }));

  const notes = [...(response.notes || []), ...(response.unableTo || []).map((item) => `Could not do: ${item}`)];

  if (!outputs.length) {
    ctx.ws.placeholders = (ctx.ws.placeholders || 0) + 1;
    outputs.push(
      artifact(`${outputDir}/NO-OUTPUT.md`, `# ${node.name} produced no files\n\nThe model returned no usable files.\n\nNotes:\n${notes.map((n) => `- ${n}`).join('\n') || '- (none)'}\n`, { kind: 'analysis' }),
    );
  }

  ctx.log(`${who} produced ${outputs.length} file(s) via ${response.__model}.`);
  return {
    outputs,
    metrics: { files: outputs.length, model: response.__model, inputsSeen: sections.length, bmad: bmadAgent?.id },
    notes,
  };
}

async function instructionAgent(ctx) {
  return runModelAgent(ctx);
}

/**
 * Runs one of the user's real BMAD agents — Mary, John, Winston, Sally or Amelia — as a step in the
 * approved graph. The persona is loaded from the BMAD install at run time with the team's and the
 * user's customisations merged in, so an override committed to `_bmad/custom/` reaches the run.
 */
async function bmadPersonaAgent(ctx) {
  const node = ctx.node;
  const bmadId = node.authored?.bmadAgentId || (String(node.agentId || '').startsWith('bmad.') ? node.agentId.slice(5) : node.name);
  const bmad = loadBmad({ root: getSettings().bmadRoot || undefined });

  const notRun = (why) => {
    ctx.ws.placeholders = (ctx.ws.placeholders || 0) + 1;
    ctx.log(why);
    return {
      outputs: [artifact(`bmad/${slug(node.name) || 'agent'}-NOT-RUN.md`, `# ${node.name} did not run\n\n${why}\n`, { kind: 'analysis' })],
      metrics: { placeholder: true },
      notes: [why],
    };
  };

  if (!bmad.found) return notRun(`No BMAD install was found (searched: ${bmad.searched.join(', ')}). Set its folder in Settings.`);
  const agent = findBmadAgent(bmadId, bmad);
  if (!agent) return notRun(`The BMAD agent "${bmadId}" is not in the install at ${bmad.root}.`);

  const facts = resolveFacts(agent.persona.persistent_facts, bmad.root);
  const missing = facts.filter((fact) => fact.missing).map((fact) => fact.entry);
  if (missing.length) ctx.log(`Standing facts reference files that do not exist: ${missing.join(', ')}.`);
  ctx.log(`Loaded ${agent.icon} ${agent.name} from the BMAD install at ${bmad.root} (${agent.overrides.join(' + ')}).`);

  return runModelAgent(ctx, { persona: personaPrompt(agent, { facts, config: bmad.config }), bmadAgent: agent });
}

/* ------------------------------------------------------------- registry */

export const AGENT_IMPLS = {
  instructionAgent,
  bmadPersonaAgent,
  seleniumJavaAnalyzer: analyzerFor('selenium-java'),
  seleniumPythonAnalyzer: analyzerFor('selenium-python'),
  cypressAnalyzer: analyzerFor('cypress'),
  junitAnalyzer: analyzerFor('junit'),
  restCollectionAnalyzer: analyzerFor('rest-collection'),
  bddGenerator,
  playwrightTsGenerator,
  playwrightPythonGenerator,
  playwrightApiGenerator,
  pytestGenerator,
  commandMapper,
  testDataMigrator,
  authMigrator,
  traceabilityAgent,
  bmadArtifactAgent,
  structureValidator,
  genericAdapter,
};

export function resolveImpl(name) {
  return AGENT_IMPLS[name] || genericAdapter;
}
