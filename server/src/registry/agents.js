/**
 * Agent Registry.
 *
 * Architecture invariant #1: registry-first. The Agent Factory searches here before it proposes
 * anything new, so proven agents are reused across projects and only genuine gaps are generated.
 *
 * `impl` names a function in engine/agents.js. An agent with an `impl` that is not implemented
 * falls back to the generic adapter and is flagged in the run report.
 */
import { collection } from '../lib/store.js';
import { loadBmad } from '../bmad/loader.js';
import { getSettings } from '../lib/settings.js';

export const SEED_AGENTS = [
  {
    id: 'agent.selenium-java-analyzer',
    name: 'Selenium Java Analyzer',
    capability: 'source.analyze.selenium-java',
    description:
      'Parses Java Selenium sources into a technology-neutral source model: suites, test cases, locators, actions, assertions, waits.',
    inputs: ['artifacts:java'],
    outputs: ['analysis/source-model.json'],
    impl: 'seleniumJavaAnalyzer',
    tags: ['selenium', 'java', 'analysis'],
    maturity: 'proven',
  },
  {
    id: 'agent.cypress-analyzer',
    name: 'Cypress Analyzer',
    capability: 'source.analyze.cypress',
    description: 'Parses Cypress specs into the same source model, including cy.* commands and fixtures.',
    inputs: ['artifacts:javascript'],
    outputs: ['analysis/source-model.json'],
    impl: 'cypressAnalyzer',
    tags: ['cypress', 'analysis'],
    maturity: 'proven',
  },
  {
    id: 'agent.junit-analyzer',
    name: 'JUnit Analyzer',
    capability: 'source.analyze.junit',
    description: 'Extracts JUnit test classes, methods, fixtures and assertions into the source model.',
    inputs: ['artifacts:java'],
    outputs: ['analysis/source-model.json'],
    impl: 'junitAnalyzer',
    tags: ['junit', 'java', 'analysis'],
    maturity: 'proven',
  },
  {
    id: 'agent.rest-collection-analyzer',
    name: 'REST Collection Analyzer',
    capability: 'source.analyze.rest-collection',
    description:
      'Reads Postman collections, .http files and RestAssured suites into a request model with auth, headers and response assertions.',
    inputs: ['artifacts:json', 'artifacts:http'],
    outputs: ['analysis/source-model.json'],
    impl: 'restCollectionAnalyzer',
    tags: ['api', 'rest', 'analysis'],
    maturity: 'proven',
  },
  {
    id: 'agent.bdd-generator',
    name: 'BDD Specification Agent',
    capability: 'spec.bdd.generate',
    description:
      'Turns requirements plus the source model into Gherkin features, giving every generated test a requirement to trace to.',
    inputs: ['analysis/source-model.json', 'spec:requirements'],
    outputs: ['features/*.feature'],
    impl: 'bddGenerator',
    tags: ['bdd', 'gherkin', 'spec'],
    maturity: 'proven',
  },
  {
    id: 'agent.playwright-ts-generator',
    name: 'Playwright TypeScript Generator',
    capability: 'target.generate.playwright-ts',
    description:
      'Emits Playwright TypeScript specs and page objects from the source model, preserving every action and assertion.',
    inputs: ['analysis/source-model.json'],
    outputs: ['tests/*.spec.ts', 'pages/*.page.ts', 'playwright.config.ts'],
    impl: 'playwrightTsGenerator',
    tags: ['playwright', 'typescript', 'codegen'],
    maturity: 'proven',
  },
  {
    id: 'agent.playwright-python-generator',
    name: 'Playwright Python Generator',
    capability: 'target.generate.playwright-python',
    description: 'Emits Playwright Python (pytest style) tests from the source model.',
    inputs: ['analysis/source-model.json'],
    outputs: ['tests/test_*.py', 'conftest.py'],
    impl: 'playwrightPythonGenerator',
    tags: ['playwright', 'python', 'codegen'],
    maturity: 'beta',
  },
  {
    id: 'agent.playwright-api-generator',
    name: 'Playwright API Generator',
    capability: 'target.generate.playwright-api',
    description: 'Emits Playwright APIRequestContext tests from a request model, preserving status and body assertions.',
    inputs: ['analysis/source-model.json'],
    outputs: ['tests/api/*.spec.ts'],
    impl: 'playwrightApiGenerator',
    tags: ['playwright', 'api', 'codegen'],
    maturity: 'beta',
  },
  {
    id: 'agent.pytest-generator',
    name: 'PyTest Generator',
    capability: 'target.generate.pytest',
    description: 'Emits PyTest modules from a JUnit-derived source model, mapping JUnit assertions to plain asserts.',
    inputs: ['analysis/source-model.json'],
    outputs: ['tests/test_*.py'],
    impl: 'pytestGenerator',
    tags: ['pytest', 'python', 'codegen'],
    maturity: 'beta',
  },
  {
    id: 'agent.command-mapper',
    name: 'Command Mapping Agent',
    capability: 'mapping.command.cypress-playwright',
    description:
      'Produces the cy.* → Playwright command mapping table used by the generator and records any command with no equivalent.',
    inputs: ['analysis/source-model.json'],
    outputs: ['analysis/command-map.json'],
    impl: 'commandMapper',
    tags: ['cypress', 'playwright', 'mapping'],
    maturity: 'proven',
  },
  {
    id: 'agent.test-data-migrator',
    name: 'Test Data Migration Agent',
    capability: 'data.migrate.testdata',
    description:
      'Normalises CSV / JSON / .properties fixtures into the target data format and reports record counts in and out.',
    inputs: ['artifacts:data'],
    outputs: ['data/*.json'],
    impl: 'testDataMigrator',
    tags: ['data', 'fixtures'],
    maturity: 'proven',
  },
  {
    id: 'agent.auth-migrator',
    name: 'Authentication Agent',
    capability: 'auth.migrate',
    description:
      'Translates detected auth schemes (basic, bearer, OAuth2, API key) into a target-side auth setup and flags secrets that must move to env vars.',
    inputs: ['analysis/source-model.json'],
    outputs: ['auth/auth.setup.ts'],
    impl: 'authMigrator',
    tags: ['auth', 'security'],
    maturity: 'beta',
  },
  {
    id: 'agent.traceability',
    name: 'Traceability Agent',
    capability: 'traceability.build',
    description: 'Links every requirement to the source test, the generated artifact and the guardrails covering it.',
    inputs: ['spec:requirements', 'analysis/source-model.json', 'generated:*'],
    outputs: ['analysis/traceability.json'],
    impl: 'traceabilityAgent',
    tags: ['traceability', 'assurance'],
    maturity: 'proven',
  },
  {
    id: 'agent.bmad-artifacts',
    name: 'BMAD Artifact Agent',
    capability: 'docs.bmad.generate',
    description:
      'Writes the BMAD document set for the project — product brief, PRD, architecture and epics & stories — derived from the discovery report, the approved graph and the traceability matrix, so the migration lands in the shape the BMAD method expects.',
    inputs: ['spec:requirements', 'analysis/source-model.json', 'analysis/traceability.json', 'graph'],
    outputs: ['docs/product-brief.md', 'docs/prd.md', 'docs/architecture.md', 'docs/epics-and-stories.md'],
    impl: 'bmadArtifactAgent',
    tags: ['bmad', 'documentation', 'handover'],
    maturity: 'proven',
  },
  {
    id: 'agent.structure-validator',
    name: 'Structure & Compilation Validator',
    capability: 'validate.compile-structure',
    description:
      'Static structural check of generated code: balanced delimiters, required imports, no empty test bodies, no leftover TODO markers.',
    inputs: ['generated:*'],
    outputs: ['analysis/structure-report.json'],
    impl: 'structureValidator',
    tags: ['validation', 'assurance'],
    maturity: 'proven',
  },
];

const agents = collection('registry-agents');

export function ensureSeeded() {
  const existing = agents.all();
  if (!existing.length) {
    agents.replaceAll(SEED_AGENTS.map((agent) => ({ ...agent, source: 'registry' })));
    return;
  }
  // Add seeds introduced after this store was first written, without clobbering user edits.
  const byId = new Map(existing.map((agent) => [agent.id, agent]));
  let changed = false;
  for (const seed of SEED_AGENTS) {
    if (!byId.has(seed.id)) {
      existing.push({ ...seed, source: 'registry' });
      changed = true;
    }
  }
  if (changed) agents.replaceAll(existing);
}

/**
 * The user's BMAD agents, as registry entries. They are read live from the BMAD install rather than
 * copied into the store, so the registry always reflects the install — team overrides included.
 */
export function bmadAgents() {
  const bmad = loadBmad({ root: getSettings().bmadRoot || undefined });
  return bmad.agents.map((agent) => ({
    id: `bmad.${agent.id}`,
    name: `${agent.name} — ${agent.title}`,
    capability: `bmad.persona.${agent.role}`,
    description: (agent.overview || '').split('\n')[0] || agent.description,
    inputs: ['requirements', 'constraints', 'generated'],
    outputs: [`bmad/${agent.role}/*.md`],
    impl: 'bmadPersonaAgent',
    tags: ['bmad', agent.role],
    maturity: 'bmad',
    source: 'bmad',
    icon: agent.icon,
    bmad: { id: agent.id, role: agent.role, overrides: agent.overrides, phase: agent.phase, root: bmad.root },
  }));
}

export function listAgents() {
  ensureSeeded();
  return [...agents.all(), ...bmadAgents()];
}

export function findByCapability(capability) {
  return listAgents().filter((agent) => agent.capability === capability);
}

export function addAgent(agent) {
  ensureSeeded();
  return agents.insert(agent);
}

export function removeAgent(agentId) {
  agents.remove(agentId);
}
