/**
 * Technology profiles. Discovery matches the user's free-text stack description *and* the
 * artifact contents against these, so "java selenium", "Selenium WebDriver (Java 11)" and a
 * pasted file full of `WebDriver driver` all land on the same profile.
 *
 * A profile that is not in this list is not an error — it becomes an `unknown` profile, which
 * is what makes the Agent Factory raise a Capability Gap instead of pretending.
 */
export const TECHNOLOGIES = [
  {
    id: 'selenium-java',
    label: 'Selenium WebDriver (Java)',
    language: 'java',
    kind: 'ui-test',
    keywords: ['selenium java', 'java selenium', 'selenium webdriver', 'testng', 'junit selenium'],
    codeSignals: [/org\.openqa\.selenium/, /WebDriver\s+\w+/, /By\.(id|name|xpath|cssSelector)/],
    fileHints: ['.java'],
    analyzeCapability: 'source.analyze.selenium-java',
    generateCapability: null,
  },
  {
    id: 'selenium-python',
    label: 'Selenium WebDriver (Python)',
    language: 'python',
    kind: 'ui-test',
    keywords: ['selenium python', 'python selenium', 'pytest selenium'],
    codeSignals: [/from selenium import webdriver/, /find_element\(By\./],
    fileHints: ['.py'],
    analyzeCapability: 'source.analyze.selenium-python',
    generateCapability: null,
  },
  {
    id: 'cypress',
    label: 'Cypress',
    language: 'javascript',
    kind: 'ui-test',
    keywords: ['cypress'],
    codeSignals: [/cy\.(visit|get|contains|intercept)/, /describe\(.*function/],
    fileHints: ['.cy.js', '.cy.ts', '.spec.js'],
    analyzeCapability: 'source.analyze.cypress',
    generateCapability: null,
  },
  {
    id: 'junit',
    label: 'JUnit (Java unit tests)',
    language: 'java',
    kind: 'unit-test',
    keywords: ['junit', 'java unit test'],
    codeSignals: [/import org\.junit/, /@Test/],
    fileHints: ['.java'],
    analyzeCapability: 'source.analyze.junit',
    generateCapability: null,
  },
  {
    id: 'rest-collection',
    label: 'Legacy REST API test collection',
    language: 'json',
    kind: 'api-test',
    keywords: ['postman', 'rest assured', 'legacy rest', 'soapui', 'api collection', 'rest api tests'],
    codeSignals: [/"request"\s*:\s*\{/, /RestAssured\.given\(/, /^\s*(GET|POST|PUT|DELETE)\s+https?:\/\//m],
    fileHints: ['.json', '.http'],
    analyzeCapability: 'source.analyze.rest-collection',
    generateCapability: null,
  },
  {
    id: 'playwright-ts',
    label: 'Playwright (TypeScript)',
    language: 'typescript',
    kind: 'ui-test',
    keywords: ['playwright typescript', 'playwright ts', 'playwright'],
    codeSignals: [/@playwright\/test/],
    fileHints: ['.spec.ts'],
    analyzeCapability: null,
    generateCapability: 'target.generate.playwright-ts',
  },
  {
    id: 'playwright-python',
    label: 'Playwright (Python)',
    language: 'python',
    kind: 'ui-test',
    keywords: ['playwright python'],
    codeSignals: [/from playwright\.sync_api/],
    fileHints: ['.py'],
    analyzeCapability: null,
    generateCapability: 'target.generate.playwright-python',
  },
  {
    id: 'playwright-api',
    label: 'Playwright API testing (TypeScript)',
    language: 'typescript',
    kind: 'api-test',
    keywords: ['playwright api', 'modern api automation', 'api automation framework'],
    codeSignals: [/request\.(get|post)\(/],
    fileHints: ['.spec.ts'],
    analyzeCapability: null,
    generateCapability: 'target.generate.playwright-api',
  },
  {
    id: 'pytest',
    label: 'PyTest',
    language: 'python',
    kind: 'unit-test',
    keywords: ['pytest', 'py test', 'python unit test'],
    codeSignals: [/^def test_/m, /import pytest/],
    fileHints: ['.py'],
    analyzeCapability: 'source.analyze.pytest',
    generateCapability: 'target.generate.pytest',
  },
];

const UNKNOWN = (raw, role) => ({
  id: 'unknown',
  label: raw ? `Unrecognised stack: ${raw}` : 'Unspecified stack',
  language: 'unknown',
  kind: 'unknown',
  raw,
  role,
  confidence: 0,
  evidence: [],
  analyzeCapability: 'source.analyze.unknown',
  generateCapability: 'target.generate.unknown',
});

/**
 * Score every profile against the declared stack string and the artifact bodies.
 * Returns the best match with its evidence, or an `unknown` profile.
 */
export function detectTechnology(rawStack, artifacts = [], role = 'source') {
  const declared = String(rawStack || '').toLowerCase();
  const scored = TECHNOLOGIES.map((tech) => {
    let score = 0;
    const evidence = [];

    for (const keyword of tech.keywords) {
      if (declared.includes(keyword)) {
        score += 6;
        evidence.push(`declared stack mentions "${keyword}"`);
      }
    }
    // Single-word fallback so "Cypress" alone still matches.
    const head = tech.id.split('-')[0];
    if (!evidence.length && head.length > 3 && declared.includes(head)) {
      score += 3;
      evidence.push(`declared stack mentions "${head}"`);
    }

    for (const artifact of artifacts) {
      const body = artifact.content || '';
      for (const signal of tech.codeSignals) {
        if (signal.test(body)) {
          score += 4;
          evidence.push(`${artifact.path}: matches ${signal}`);
          break;
        }
      }
      if (tech.fileHints.some((hint) => (artifact.path || '').endsWith(hint))) {
        score += 1;
      }
    }

    // A profile that cannot play this role is not a candidate for it.
    if (role === 'source' && !tech.analyzeCapability) score -= 5;
    if (role === 'target' && !tech.generateCapability) score -= 5;

    return { tech, score, evidence: evidence.slice(0, 6) };
  })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return UNKNOWN(rawStack, role);

  const best = scored[0];
  return {
    ...best.tech,
    raw: rawStack,
    role,
    confidence: Math.min(1, Number((best.score / 12).toFixed(2))),
    evidence: best.evidence,
  };
}
