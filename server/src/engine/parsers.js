/**
 * Source parsers.
 *
 * Every parser produces the SAME technology-neutral source model, which is the only thing the
 * generators ever read. That is what lets a new source technology be added without touching the
 * generators, and a new target without touching the parsers.
 *
 * Source model shape:
 * {
 *   kind, language,
 *   suites:  [{ name, file, tests: [{ id, name, tags, steps, assertions }] }],
 *   locators:[{ name, strategy, value, file }],
 *   requests:[{ name, method, url, headers, body, expectedStatus, assertions }],
 *   auth:    [{ scheme, evidence }],
 *   dataFiles:[{ path, format, records }],
 *   unmapped:[{ construct, file, raw, reason }],
 *   totals:  { suites, tests, assertions, steps, locators, requests, dataRecords }
 * }
 */
import { id, pascal, camel } from '../lib/util.js';

const DATA_EXTENSIONS = ['.csv', '.properties', '.xml', '.yaml', '.yml'];

export function emptyModel(kind = 'unknown', language = 'unknown') {
  return {
    kind,
    language,
    suites: [],
    locators: [],
    requests: [],
    auth: [],
    dataFiles: [],
    unmapped: [],
    totals: { suites: 0, tests: 0, assertions: 0, steps: 0, locators: 0, requests: 0, dataRecords: 0 },
  };
}

export function finaliseModel(model) {
  const tests = model.suites.flatMap((s) => s.tests);
  model.totals = {
    suites: model.suites.length,
    tests: tests.length,
    assertions: tests.reduce((sum, t) => sum + t.assertions.length, 0),
    steps: tests.reduce((sum, t) => sum + t.steps.length, 0),
    locators: model.locators.length,
    requests: model.requests.length,
    dataRecords: model.dataFiles.reduce((sum, f) => sum + (f.records || 0), 0),
  };
  return model;
}

/* ------------------------------------------------------------------ helpers */

/** Returns the body of a block starting at the first `{` at or after `from`. */
function blockBody(text, from) {
  const start = text.indexOf('{', from);
  if (start === -1) return { body: '', end: from };
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(start + 1, i), end: i };
    }
  }
  return { body: text.slice(start + 1), end: text.length };
}

const BY_STRATEGIES = {
  id: 'id',
  name: 'name',
  xpath: 'xpath',
  cssSelector: 'css',
  className: 'class',
  linkText: 'linkText',
  partialLinkText: 'partialLinkText',
  tagName: 'tag',
};

export function extractLocator(raw) {
  const by = raw.match(/By\.(\w+)\(\s*"((?:[^"\\]|\\.)*)"\s*\)/);
  if (by && BY_STRATEGIES[by[1]]) return { strategy: BY_STRATEGIES[by[1]], value: by[2] };
  const findBy = raw.match(/@FindBy\s*\(\s*(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/);
  if (findBy && BY_STRATEGIES[findBy[1]]) return { strategy: BY_STRATEGIES[findBy[1]], value: findBy[2] };
  const python = raw.match(/By\.([A-Z_]+)\s*,\s*["']([^"']+)["']/);
  if (python) {
    const map = { ID: 'id', NAME: 'name', XPATH: 'xpath', CSS_SELECTOR: 'css', CLASS_NAME: 'class', LINK_TEXT: 'linkText', TAG_NAME: 'tag' };
    if (map[python[1]]) return { strategy: map[python[1]], value: python[2] };
  }
  return null;
}

/** Locator → Playwright selector string. The one place selector dialects are translated. */
export function toPlaywrightSelector(loc) {
  if (!loc) return null;
  switch (loc.strategy) {
    case 'id':
      return `#${loc.value}`;
    case 'name':
      return `[name="${loc.value}"]`;
    case 'css':
      return loc.value;
    case 'class':
      return `.${loc.value.trim().split(/\s+/).join('.')}`;
    case 'xpath':
      return `xpath=${loc.value}`;
    case 'linkText':
      return `text="${loc.value}"`;
    case 'partialLinkText':
      return `text=${loc.value}`;
    case 'tag':
      return loc.value;
    default:
      return loc.value;
  }
}

function firstString(raw) {
  const m = raw.match(/"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : null;
}

/**
 * Locator arguments are string literals too, so a naive "first string on the line" reads
 * `sendKeys` on `findElement(By.id("username")).sendKeys("standard_user")` as "username".
 * Strip the locator calls first, then the remaining literals are the real values.
 */
function stripLocators(raw) {
  return String(raw)
    .replace(/By\.\w+\(\s*"(?:[^"\\]|\\.)*"\s*\)/g, 'BY()')
    .replace(/By\.[A-Z_]+\s*,\s*["'][^"']*["']/g, 'BY()');
}

/** The argument of a specific call, e.g. argString(line, 'sendKeys'). */
function argString(raw, fnPattern) {
  const m = String(raw).match(new RegExp(`(?:${fnPattern})\\s*\\(\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1] : null;
}

/** Last string literal that is not part of a locator — the expected value in most assertions. */
function lastValueString(raw) {
  const matches = stripLocators(raw).match(/"((?:[^"\\]|\\.)*)"/g);
  if (!matches?.length) return null;
  return matches[matches.length - 1].slice(1, -1);
}

function newTest(name, file) {
  return { id: id('tc'), name, file, tags: [], steps: [], assertions: [] };
}

/* --------------------------------------------------------- java (selenium) */

export function parseJavaSelenium(artifacts) {
  const model = emptyModel('ui-test', 'java');

  for (const artifact of artifacts) {
    const text = artifact.content || '';
    if (!/\bclass\s+\w+/.test(text)) continue;
    const className = (text.match(/(?:public\s+)?class\s+(\w+)/) || [])[1] || pascal(artifact.path);

    // @FindBy page-object fields become named locators.
    const findByRe = /@FindBy\s*\(([^)]*)\)\s*(?:private|public|protected)?\s*WebElement\s+(\w+)/g;
    let fb;
    while ((fb = findByRe.exec(text))) {
      const loc = extractLocator(`@FindBy(${fb[1]})`);
      if (loc) model.locators.push({ name: fb[2], ...loc, file: artifact.path, owner: className });
    }

    const isTestFile = /@Test/.test(text);
    if (!isTestFile) {
      // Page object without tests: still record it so the generator can emit a page class.
      continue;
    }

    const suite = { name: className, file: artifact.path, tests: [] };
    const testRe = /@Test(?:\s*\([^)]*\))?\s*(?:@\w+(?:\([^)]*\))?\s*)*public\s+void\s+(\w+)\s*\([^)]*\)/g;
    let match;
    while ((match = testRe.exec(text))) {
      const { body } = blockBody(text, match.index + match[0].length);
      const test = newTest(match[1], artifact.path);
      readJavaBody(body, test, model, artifact.path);
      suite.tests.push(test);
    }
    if (suite.tests.length) model.suites.push(suite);
  }

  return finaliseModel(model);
}

/**
 * Java statements wrap across lines freely, and a line-at-a-time reader loses the expected value
 * of any assertion that wraps. Rejoin physical lines into statements before scanning.
 */
function statementsOf(body) {
  const out = [];
  let buffer = '';
  for (const raw of body.split('\n').map((line) => line.trim())) {
    if (!raw || raw.startsWith('//') || raw.startsWith('*')) continue;
    buffer = buffer ? `${buffer} ${raw}` : raw;
    if (raw.endsWith(';') || raw.endsWith('{') || raw.endsWith('}')) {
      out.push(buffer);
      buffer = '';
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

function readJavaBody(body, test, model, file) {
  const lines = statementsOf(body);

  for (const line of lines) {
    if (line.startsWith('//') || line.startsWith('*')) continue;
    const loc = extractLocator(line);

    // Assertions first — an assertion line may also contain a locator.
    const assertion = readJavaAssertion(line, loc);
    if (assertion) {
      test.assertions.push(assertion);
      continue;
    }

    if (/\.get\s*\(\s*"/.test(line) && /driver|navigate/.test(line)) {
      test.steps.push({ type: 'goto', value: firstString(line), raw: line });
      continue;
    }
    if (/\.sendKeys\s*\(/.test(line)) {
      test.steps.push({ type: 'fill', locator: loc, value: argString(line, 'sendKeys') ?? lastValueString(line) ?? '', raw: line });
      if (loc) model.locators.push({ name: camel(loc.value), ...loc, file });
      continue;
    }
    if (/\.click\s*\(\s*\)/.test(line)) {
      test.steps.push({ type: 'click', locator: loc, raw: line });
      if (loc) model.locators.push({ name: camel(loc.value), ...loc, file });
      continue;
    }
    if (/\.clear\s*\(\s*\)/.test(line)) {
      test.steps.push({ type: 'clear', locator: loc, raw: line });
      continue;
    }
    if (/selectBy(VisibleText|Value|Index)\s*\(/.test(line)) {
      test.steps.push({ type: 'select', locator: loc, value: argString(line, 'selectByVisibleText|selectByValue|selectByIndex') ?? lastValueString(line), raw: line });
      continue;
    }
    if (/Thread\.sleep\s*\(\s*(\d+)/.test(line)) {
      const ms = Number(line.match(/Thread\.sleep\s*\(\s*(\d+)/)[1]);
      test.steps.push({ type: 'wait', value: ms, raw: line });
      continue;
    }
    if (/WebDriverWait|ExpectedConditions/.test(line)) {
      test.steps.push({ type: 'waitFor', locator: loc, raw: line });
      continue;
    }
    if (/switchTo\(\)\.alert\(\)/.test(line)) {
      test.steps.push({ type: 'dialog', raw: line });
      continue;
    }
    if (/\.submit\s*\(\s*\)/.test(line)) {
      test.steps.push({ type: 'press', locator: loc, value: 'Enter', raw: line });
      continue;
    }
    if (/JavascriptExecutor|Robot|Actions\s+\w+|\.dragAndDrop\(/.test(line)) {
      model.unmapped.push({
        construct: /JavascriptExecutor/.test(line) ? 'JavascriptExecutor' : /Robot/.test(line) ? 'java.awt.Robot' : 'Actions chain',
        file,
        raw: line,
        reason: 'No 1:1 Playwright equivalent — needs a human decision.',
      });
      continue;
    }
    if (loc && /findElement/.test(line)) {
      model.locators.push({ name: camel(loc.value), ...loc, file });
    }
  }
}

function readJavaAssertion(line, loc) {
  if (!/\bAssert\w*\.|\bassert(Equals|True|False|NotNull|Null|That)\b/.test(line)) return null;
  const kind = (line.match(/assert(Equals|True|False|NotNull|Null|That)/i) || [])[1] || 'Equals';
  const expected = lastValueString(line);
  let subject = 'text';
  if (/getTitle\(\)/.test(line)) subject = 'title';
  else if (/getCurrentUrl\(\)/.test(line)) subject = 'url';
  else if (/isDisplayed\(\)/.test(line)) subject = 'visible';
  else if (/isEnabled\(\)/.test(line)) subject = 'enabled';
  else if (/getAttribute/.test(line)) subject = 'attribute';
  return { type: kind.toLowerCase(), subject, expected, locator: loc, raw: line };
}

/* --------------------------------------------------------------- junit */

export function parseJUnit(artifacts) {
  const model = emptyModel('unit-test', 'java');
  for (const artifact of artifacts) {
    const text = artifact.content || '';
    if (!/@Test/.test(text)) continue;
    const className = (text.match(/(?:public\s+)?class\s+(\w+)/) || [])[1] || pascal(artifact.path);
    const suite = { name: className, file: artifact.path, tests: [] };
    const testRe = /@Test(?:\s*\([^)]*\))?\s*(?:@\w+(?:\([^)]*\))?\s*)*public\s+void\s+(\w+)\s*\([^)]*\)/g;
    let match;
    while ((match = testRe.exec(text))) {
      const { body } = blockBody(text, match.index + match[0].length);
      const test = newTest(match[1], artifact.path);
      for (const line of statementsOf(body)) {
        if (!line || line.startsWith('//')) continue;
        const assertion = readJavaAssertion(line, null);
        if (assertion) test.assertions.push(assertion);
        else test.steps.push({ type: 'statement', raw: line });
      }
      suite.tests.push(test);
    }
    if (suite.tests.length) model.suites.push(suite);
  }
  return finaliseModel(model);
}

/* -------------------------------------------------------------- cypress */

export function parseCypress(artifacts) {
  const model = emptyModel('ui-test', 'javascript');

  for (const artifact of artifacts) {
    const text = artifact.content || '';
    if (!/\b(it|describe)\s*\(/.test(text)) continue;
    const describeName = (text.match(/describe\s*\(\s*['"`]([^'"`]+)/) || [])[1] || artifact.path;
    const suite = { name: describeName, file: artifact.path, tests: [] };

    const itRe = /\bit\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s*)?(?:\([^)]*\)|function\s*\([^)]*\))\s*=>?/g;
    let match;
    while ((match = itRe.exec(text))) {
      const { body } = blockBody(text, match.index + match[0].length);
      const test = newTest(match[1], artifact.path);
      let pendingSelector = null;

      for (const line of statementsOf(body)) {
        if (line.startsWith('//')) continue;
        const selector = (line.match(/cy\.get\(\s*['"`]([^'"`]+)['"`]\s*\)/) || [])[1] || null;
        if (selector) {
          pendingSelector = { strategy: 'css', value: selector };
          model.locators.push({ name: camel(selector), strategy: 'css', value: selector, file: artifact.path });
        }
        const target = selector ? { strategy: 'css', value: selector } : pendingSelector;

        if (/cy\.visit\(/.test(line)) {
          test.steps.push({ type: 'goto', value: (line.match(/cy\.visit\(\s*['"`]([^'"`]+)/) || [])[1], raw: line });
        } else if (/\.should\(/.test(line) || /expect\(/.test(line)) {
          const matcher = (line.match(/\.should\(\s*['"`]([^'"`]+)/) || [])[1] || 'be.ok';
          const expected = (line.match(/\.should\([^,]+,\s*['"`]([^'"`]*)/) || [])[1] || null;
          test.assertions.push({
            type: matcher.includes('contain') ? 'equals' : matcher.includes('visible') ? 'true' : 'equals',
            subject: matcher.includes('visible') ? 'visible' : matcher.includes('url') ? 'url' : 'text',
            expected,
            locator: target,
            raw: line,
          });
        } else if (/\.type\(/.test(line)) {
          test.steps.push({ type: 'fill', locator: target, value: (line.match(/\.type\(\s*['"`]([^'"`]*)/) || [])[1] ?? '', raw: line });
        } else if (/\.click\(/.test(line)) {
          test.steps.push({ type: 'click', locator: target, raw: line });
        } else if (/\.select\(/.test(line)) {
          test.steps.push({ type: 'select', locator: target, value: (line.match(/\.select\(\s*['"`]([^'"`]*)/) || [])[1], raw: line });
        } else if (/cy\.wait\(/.test(line)) {
          test.steps.push({ type: 'wait', value: Number((line.match(/cy\.wait\(\s*(\d+)/) || [])[1] || 500), raw: line });
        } else if (/cy\.intercept\(/.test(line)) {
          test.steps.push({ type: 'route', raw: line });
        } else if (/cy\.fixture\(/.test(line)) {
          test.steps.push({ type: 'fixture', value: (line.match(/cy\.fixture\(\s*['"`]([^'"`]+)/) || [])[1], raw: line });
        } else if (/Cypress\.(env|Commands)|cy\.task\(/.test(line)) {
          model.unmapped.push({ construct: 'Cypress custom command / task', file: artifact.path, raw: line, reason: 'Custom Cypress extension has no direct Playwright equivalent.' });
        }
      }
      suite.tests.push(test);
    }
    if (suite.tests.length) model.suites.push(suite);
  }

  return finaliseModel(model);
}

/* ------------------------------------------------------- python selenium */

export function parsePythonSelenium(artifacts) {
  const model = emptyModel('ui-test', 'python');
  for (const artifact of artifacts) {
    const text = artifact.content || '';
    if (!/def\s+test_/.test(text)) continue;
    const suite = { name: pascal(artifact.path.split('/').pop() || 'Suite'), file: artifact.path, tests: [] };
    const blocks = text.split(/\ndef\s+/).slice(1);
    for (const block of blocks) {
      const name = (block.match(/^(\w+)/) || [])[1];
      if (!name || !name.startsWith('test_')) continue;
      const test = newTest(name, artifact.path);
      for (const line of block.split('\n').map((l) => l.trim())) {
        if (!line || line.startsWith('#')) continue;
        const loc = extractLocator(line);
        if (/^assert\b/.test(line)) {
          test.assertions.push({ type: 'true', subject: 'text', expected: (line.match(/["']([^"']+)["']/) || [])[1] || null, locator: loc, raw: line });
        } else if (/\.get\(["']/.test(line)) {
          test.steps.push({ type: 'goto', value: (line.match(/["']([^"']+)["']/) || [])[1], raw: line });
        } else if (/send_keys\(/.test(line)) {
          test.steps.push({ type: 'fill', locator: loc, value: (line.match(/send_keys\(\s*["']([^"']*)/) || [])[1] ?? '', raw: line });
        } else if (/\.click\(\)/.test(line)) {
          test.steps.push({ type: 'click', locator: loc, raw: line });
        }
        if (loc) model.locators.push({ name: camel(loc.value), ...loc, file: artifact.path });
      }
      suite.tests.push(test);
    }
    if (suite.tests.length) model.suites.push(suite);
  }
  return finaliseModel(model);
}

/* ------------------------------------------------------ rest collections */

export function parseRestCollection(artifacts) {
  const model = emptyModel('api-test', 'json');

  for (const artifact of artifacts) {
    const text = artifact.content || '';

    // 1. Postman collection
    if (/"info"\s*:/.test(text) || /"request"\s*:/.test(text)) {
      try {
        const json = JSON.parse(text);
        walkPostman(json, model, artifact.path);
        continue;
      } catch {
        /* fall through to the text parsers */
      }
    }

    // 2. .http / .rest files
    const httpRe = /^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/gim;
    let m;
    while ((m = httpRe.exec(text))) {
      model.requests.push({
        id: id('req'),
        name: `${m[1]} ${m[2]}`,
        method: m[1].toUpperCase(),
        url: m[2],
        headers: {},
        expectedStatus: 200,
        assertions: [],
        file: artifact.path,
      });
    }

    // 3. RestAssured
    const raRe = /given\(\)([\s\S]*?);/g;
    let ra;
    while ((ra = raRe.exec(text))) {
      const chunk = ra[1];
      const method = (chunk.match(/\.(get|post|put|delete|patch)\(/i) || [])[1];
      if (!method) continue;
      const url = (chunk.match(/\.(?:get|post|put|delete|patch)\(\s*"([^"]+)"/i) || [])[1] || '/';
      const status = Number((chunk.match(/statusCode\(\s*(\d+)/) || [])[1] || 200);
      model.requests.push({
        id: id('req'),
        name: `${method.toUpperCase()} ${url}`,
        method: method.toUpperCase(),
        url,
        headers: {},
        expectedStatus: status,
        assertions: (chunk.match(/body\(\s*"([^"]+)"/g) || []).map((raw) => ({ type: 'body', raw })),
        file: artifact.path,
      });
      if (/auth\(\)\.basic|\.header\(\s*"Authorization"/.test(chunk)) {
        model.auth.push({ scheme: /basic/i.test(chunk) ? 'basic' : 'bearer', evidence: artifact.path });
      }
    }
  }

  // Deduplicate detected auth schemes.
  const seen = new Set();
  model.auth = model.auth.filter((a) => (seen.has(a.scheme) ? false : seen.add(a.scheme)));

  // API suites are rendered one per host/prefix so the generator can emit grouped spec files.
  const groups = new Map();
  for (const req of model.requests) {
    const key = (req.url.replace(/^https?:\/\//, '').split('/')[1] || 'root').replace(/\W+/g, '-');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(req);
  }
  for (const [key, requests] of groups) {
    model.suites.push({
      name: pascal(key),
      file: requests[0].file,
      tests: requests.map((req) => ({
        id: req.id,
        name: req.name,
        file: req.file,
        tags: ['api'],
        steps: [{ type: 'request', method: req.method, value: req.url, raw: `${req.method} ${req.url}` }],
        // The parsed script IS the assertion list. Adding a synthetic status check on top counted
        // one real `pm.test` twice and made assertion parity unachievable by construction.
        assertions: req.assertions.length
          ? req.assertions
          : [{ type: 'equals', subject: 'status', expected: String(req.expectedStatus), inferred: true, raw: `no assertions in source; expecting ${req.expectedStatus}` }],
      })),
    });
  }

  return finaliseModel(model);
}

function walkPostman(node, model, file) {
  if (!node || typeof node !== 'object') return;
  if (node.request) {
    const req = node.request;
    const url = typeof req.url === 'string' ? req.url : (req.url?.raw || '/');
    const headers = {};
    for (const h of req.header || []) headers[h.key] = h.value;

    const scripts = (node.event || []).flatMap((e) => e.script?.exec || []).join('\n');
    const assertions = parseApiScript(scripts, file, model);
    const statusAssertion = assertions.find((a) => a.subject === 'status');

    model.requests.push({
      id: id('req'),
      name: node.name || `${req.method} ${url}`,
      method: (req.method || 'GET').toUpperCase(),
      url,
      headers,
      body: req.body?.raw || null,
      expectedStatus: statusAssertion ? Number(statusAssertion.expected) : 200,
      statusInferred: !statusAssertion,
      assertions,
      file,
    });
    if (req.auth?.type) model.auth.push({ scheme: req.auth.type, evidence: `${file}: ${node.name || ''}` });
    else if (headers.Authorization) model.auth.push({ scheme: /bearer/i.test(headers.Authorization) ? 'bearer' : 'basic', evidence: `${file}: Authorization header` });
  }
  for (const child of node.item || []) walkPostman(child, model, file);
}

/**
 * Reads the assertions out of a Postman test script.
 *
 * Previously this recorded "a pm.test exists" and nothing about what it checked, so the generator
 * had nothing to emit and every body assertion was lost to a TODO comment. Now each check inside
 * the block is turned into a concrete assertion the emitters can actually produce, and anything
 * unrecognised is recorded as `custom` so it is counted and surfaced rather than dropped.
 */
export function parseApiScript(scripts, file, model) {
  const assertions = [];
  if (!scripts?.trim()) return assertions;

  const testRe = /pm\.test\s*\(\s*["'`]([^"'`]+)["'`]\s*,/g;
  let match;
  let matchedAnyBlock = false;

  while ((match = testRe.exec(scripts))) {
    matchedAnyBlock = true;
    const name = match[1];
    const { body } = blockBody(scripts, match.index + match[0].length);
    const found = readApiChecks(name, body);
    if (found.length) {
      assertions.push(...found);
    } else {
      assertions.push({ type: 'custom', subject: 'custom', name, expected: null, raw: `pm.test("${name}") — ${body.trim().slice(0, 120)}` });
      model?.unmapped.push({
        construct: `pm.test("${name}")`,
        file,
        raw: body.trim().slice(0, 160),
        reason: 'The assertion inside this Postman check was not recognised, so it cannot be ported automatically.',
      });
    }
  }

  // Legacy Postman syntax: tests["name"] = responseCode.code === 200;
  const legacyRe = /tests\s*\[\s*["'`]([^"'`]+)["'`]\s*\]\s*=\s*([^;\n]+)/g;
  while ((match = legacyRe.exec(scripts))) {
    matchedAnyBlock = true;
    const [, name, expression] = match;
    const status = expression.match(/responseCode\.code\s*===?\s*(\d{3})/);
    if (status) assertions.push({ type: 'equals', subject: 'status', expected: status[1], name, raw: match[0] });
    else assertions.push({ type: 'custom', subject: 'custom', name, expected: null, raw: match[0] });
  }

  // A bare script with no pm.test wrapper still often asserts something.
  if (!matchedAnyBlock) assertions.push(...readApiChecks('response check', scripts));

  return assertions;
}

/** The individual checks understood inside one test block. */
function readApiChecks(name, body) {
  const checks = [];
  const add = (subject, extra = {}) => checks.push({ type: 'equals', subject, name, raw: body.trim().slice(0, 160), expected: null, ...extra });

  const status = body.match(/to\.have\.status\s*\(\s*(\d{3})\s*\)/) || body.match(/\.status\s*\)?\s*\.to\.(?:eql|equal|be)\s*\(\s*(\d{3})/);
  if (status) add('status', { expected: status[1] });

  if (/to\.be\.(?:ok|success)\b/.test(body)) add('ok');

  const header = body.match(/to\.have\.header\s*\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*["'`]([^"'`]*)["'`])?/);
  if (header) add('header', { target: header[1], expected: header[2] ?? null });

  // pm.expect(pm.response.json().items.length).to.eql(3) / jsonData.status to.equal("ok")
  const jsonRe = /(?:pm\.response\.json\(\)|jsonData|responseJson|body)((?:\.[\w$]+|\[\s*\d+\s*\])*)\s*\)?\s*\.to(?:\.be)?\.(eql|equal|deep\.equal)\s*\(\s*([^)]+?)\s*\)/g;
  let json;
  while ((json = jsonRe.exec(body))) {
    add('json', { target: json[1] || '', expected: json[3].trim() });
  }

  const jsonBody = body.match(/to\.have\.jsonBody\s*\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*([^)]+))?\)/);
  if (jsonBody) add('json', { target: `.${jsonBody[1]}`, expected: (jsonBody[2] || '').trim() || null });

  const includes = body.match(/to\.include\s*\(\s*["'`]([^"'`]+)["'`]/);
  if (includes) add('contains', { expected: includes[1] });

  const property = body.match(/to\.have\.(?:own\.)?property\s*\(\s*["'`]([^"'`]+)["'`]/);
  if (property) add('property', { target: property[1] });

  if (/responseTime|pm\.response\.responseTime/.test(body)) {
    const limit = body.match(/below\s*\(\s*(\d+)/) || body.match(/lessThan\s*\(\s*(\d+)/);
    add('responseTime', { expected: limit ? limit[1] : null });
  }

  return checks;
}

/* ------------------------------------------------------------- data files */

export function collectDataFiles(artifacts) {
  const files = [];
  for (const artifact of artifacts) {
    const path = artifact.path || '';
    const text = artifact.content || '';
    const isData =
      DATA_EXTENSIONS.some((ext) => path.endsWith(ext)) ||
      (path.endsWith('.json') && !/"request"\s*:/.test(text) && /^\s*[[{]/.test(text) && !/"info"\s*:/.test(text));
    if (!isData) continue;

    let format = path.split('.').pop();
    let records = 0;
    if (format === 'csv') {
      const rows = text.split('\n').map((r) => r.trim()).filter(Boolean);
      records = Math.max(0, rows.length - 1);
    } else if (format === 'json') {
      try {
        const parsed = JSON.parse(text);
        records = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
      } catch {
        records = 0;
      }
    } else if (format === 'properties') {
      records = text.split('\n').filter((line) => line.includes('=') && !line.trim().startsWith('#')).length;
    } else {
      records = text.split('\n').filter(Boolean).length;
    }
    files.push({ path, format, records, content: text });
  }
  return files;
}

/* ------------------------------------------------------------ entry point */

const PARSERS = {
  'selenium-java': parseJavaSelenium,
  'selenium-python': parsePythonSelenium,
  cypress: parseCypress,
  junit: parseJUnit,
  pytest: parsePythonSelenium,
  'rest-collection': parseRestCollection,
};

export function buildSourceModel(technologyId, artifacts) {
  const parser = PARSERS[technologyId];
  const model = parser ? parser(artifacts) : emptyModel('unknown', 'unknown');
  model.dataFiles = collectDataFiles(artifacts).map(({ content, ...rest }) => rest);
  if (!parser) {
    model.unmapped.push({
      construct: technologyId || 'unspecified source technology',
      file: '-',
      raw: '-',
      reason: 'No parser is registered for this technology. A parser agent must be built before migration.',
    });
  }
  return finaliseModel(model);
}

export const SUPPORTED_SOURCE_PARSERS = Object.keys(PARSERS);
