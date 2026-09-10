/**
 * Project Discovery — stage 1 of the control plane.
 *
 * Reads the spec (requirements + source stack + target stack + artifacts) and answers:
 *   what is being migrated · which technologies · which entities · which CAPABILITIES are required
 *   · which RISKS are present · where the platform has a genuine gap.
 *
 * It never names an agent. Capabilities are the join; the Agent Factory does the matchmaking.
 */
import { detectTechnology } from '../registry/technologies.js';
import { buildSourceModel, SUPPORTED_SOURCE_PARSERS } from './parsers.js';
import { id, unique } from '../lib/util.js';

/** Capabilities are grouped into phases; the Workflow Composer turns phases into DAG edges. */
export const CAPABILITY_CATALOG = {
  'source.analyze': { phase: 10, label: 'Source analysis' },
  'mapping.command': { phase: 20, label: 'Command mapping' },
  'spec.bdd': { phase: 20, label: 'Specification' },
  'data.migrate': { phase: 20, label: 'Data migration' },
  'auth.migrate': { phase: 20, label: 'Authentication' },
  'target.generate': { phase: 30, label: 'Target generation' },
  'traceability': { phase: 40, label: 'Traceability' },
  'docs.bmad': { phase: 45, label: 'BMAD artifacts' },
  'validate': { phase: 50, label: 'Validation' },
};

export function capabilityPhase(capability) {
  const key = Object.keys(CAPABILITY_CATALOG)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => capability.startsWith(prefix));
  return key ? CAPABILITY_CATALOG[key].phase : 25;
}

export function capabilityGroup(capability) {
  const key = Object.keys(CAPABILITY_CATALOG)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => capability.startsWith(prefix));
  return key ? CAPABILITY_CATALOG[key].label : 'Custom';
}

const PII_PATTERNS = [
  { label: 'email address', re: /[\w.+-]+@(?!example\.(com|org)|test\.)[\w-]+\.[\w.]{2,}/ },
  { label: 'card-like number', re: /\b(?:\d[ -]*?){13,16}\b/ },
  { label: 'national id', re: /\b\d{3}-\d{2}-\d{4}\b/ },
];

const SECRET_PATTERNS = [
  { label: 'password literal', re: /(password|passwd|pwd)\s*[=:]\s*["'][^"']{3,}["']/i },
  { label: 'api key literal', re: /(api[_-]?key|secret|token)\s*[=:]\s*["'][A-Za-z0-9_\-]{8,}["']/i },
  // A credential typed straight into a field is the same leak wearing a different hat.
  { label: 'credential typed into a field', re: /(?:password|passwd|pwd|api[_-]?key|secret|token)[^\n]{0,80}(?:sendKeys|send_keys|\.type|\.fill)\s*\(\s*["'][^"']{3,}["']/i },
];

/**
 * Pulls requirements out of whatever the requirements document looks like: bullets, numbered
 * lists, tagged IDs (REQ-001, US-14), user stories, or "The system shall …" sentences.
 *
 * Headings, table rules and prose scaffolding are skipped, because a heading traced to a test is
 * a false positive and the traceability guardrail would then be measuring nothing.
 */
export function parseRequirements(text = '') {
  const SKIP = /^(#{1,6}\s|[-=]{3,}$|\|?\s*[-:|\s]+\|?$|>\s|```)/;
  const PROSE = /^(introduction|overview|scope|background|purpose|context|out of scope|assumptions?|glossary|table of contents|appendix)\b/i;
  const SHALL = /\b(shall|must|should|can|is able to|will)\b/i;

  const candidates = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !SKIP.test(line));

  /**
   * Two shapes arrive here and both are legitimate:
   *   - somebody typed three lines into the box — every line is a requirement, full stop;
   *   - somebody pasted a 200-line requirements document — most lines are prose scaffolding.
   * Short input is read loosely; long input is filtered. If filtering a long document finds
   * nothing, fall back to loose rather than reporting zero requirements.
   */
  const looksLikeDocument =
    /^#{1,6}\s/m.test(text) ||
    /^\s*\d+\.\s+[A-Z][a-z]+\s*$/m.test(text) ||
    candidates.filter((line) => /^(?:[-*•·]|\d+[.)])\s+/.test(line) || /^[A-Z]{2,6}[-_ ]?\d{1,4}\b/.test(line)).length >= 3;
  const loose = !looksLikeDocument;

  const collect = (permissive) => {
    const out = [];
    let counter = 0;
    for (const line of candidates) {
      const bulleted = /^(?:[-*•·]|\d+[.)])\s+/.test(line);
      const stripped = line
        .replace(/^(?:[-*•·]|\d+[.)])\s+/, '')
        .replace(/^\*\*(.+?)\*\*/, '$1')
        .trim();
      if (stripped.length < 4) continue;

      const tagged = stripped.match(/^([A-Z]{2,6}[-_ ]?\d{1,4})\s*[:.—–-]?\s*(.+)$/);
      const story = /^as an?\s+.+?,?\s+i (?:want|need|should)/i.test(stripped);

      if (!permissive) {
        if (!tagged && !bulleted && !story && !SHALL.test(stripped)) continue;
        if (!tagged && PROSE.test(stripped)) continue;
      }

      counter += 1;
      out.push(
        tagged
          ? { id: tagged[1].replace(/[_ ]/g, '-').toUpperCase(), text: tagged[2].trim(), raw: line }
          : { id: `REQ-${String(counter).padStart(3, '0')}`, text: stripped, raw: line },
      );
    }
    return out;
  };

  const out = loose ? collect(true) : collect(false).length ? collect(false) : collect(true);

  // Deduplicate ids that repeat across a document (tables often restate them).
  const seen = new Map();
  return out.filter((requirement) => {
    const count = (seen.get(requirement.id) || 0) + 1;
    seen.set(requirement.id, count);
    return count === 1;
  });
}

export function runDiscovery(spec) {
  const artifacts = spec.artifacts || [];
  const source = detectTechnology(spec.sourceStack, artifacts, 'source');
  const target = detectTechnology(spec.targetStack, artifacts, 'target');
  const requirements = parseRequirements(spec.requirements);
  const sourceModel = buildSourceModel(source.id, artifacts);

  const capabilities = [];
  const risks = [];
  const gaps = [];

  const require = (capability, why, requiredBy) => {
    const existing = capabilities.find((c) => c.id === capability);
    if (existing) {
      existing.requiredBy = unique([...existing.requiredBy, ...requiredBy]);
      return;
    }
    capabilities.push({ id: capability, group: capabilityGroup(capability), phase: capabilityPhase(capability), why, requiredBy });
  };
  const risk = (riskId, label, severity, why, evidence) => {
    if (risks.some((r) => r.id === riskId)) return;
    risks.push({ id: riskId, label, severity, why, evidence });
  };

  /* ---- capabilities ------------------------------------------------ */

  // A "custom" project makes no assumption that this is a test migration. The platform contributes
  // what it can prove (traceability, structural checks) and leaves the shape of the work to the
  // agents the human authors. Nothing here is specific to any framework.
  const isCustom = spec.projectKind === 'custom';

  if (isCustom) {
    require(
      'custom.workflow',
      'This project is marked custom, so the platform does not assume what the work is. Author the agents that do it — the graph is yours.',
      ['project kind'],
    );
    if (source.id !== 'unknown' && source.analyzeCapability) {
      require(source.analyzeCapability, `The artifacts still look like ${source.label}, so parsing them into the source model is available if you want it.`, ['artifacts']);
    }
  } else {
    require(
      source.analyzeCapability || 'source.analyze.unknown',
      `The source suite is ${source.label}; its constructs must be read into the neutral source model before anything can be generated.`,
      ['source stack'],
    );

    if (target.generateCapability) {
      require(target.generateCapability, `The target is ${target.label}; a generator must emit it from the source model.`, ['target stack']);
    } else {
      require('target.generate.unknown', `The declared target "${spec.targetStack || 'unspecified'}" has no registered emitter.`, ['target stack']);
    }
  }

  if (!isCustom && source.id === 'cypress' && String(target.id).startsWith('playwright')) {
    require('mapping.command.cypress-playwright', 'Cypress chains commands off cy.*; each command needs an explicit Playwright equivalent before generation.', ['source/target pair']);
  }

  if (requirements.length) {
    if (!isCustom) {
      require('spec.bdd.generate', `${requirements.length} requirement(s) were supplied, so generated tests can and should be anchored to them.`, requirements.slice(0, 3).map((r) => r.id));
    }
    require('traceability.build', 'Requirements exist, so requirement → output → artifact links must be produced.', ['requirements']);
  }

  if (sourceModel.dataFiles.length) {
    require('data.migrate.testdata', `${sourceModel.dataFiles.length} fixture file(s) detected (${sourceModel.totals.dataRecords} records); they must move across without loss.`, sourceModel.dataFiles.map((f) => f.path));
  }

  if (sourceModel.auth.length) {
    require('auth.migrate', `Authentication detected (${sourceModel.auth.map((a) => a.scheme).join(', ')}); the target needs an equivalent setup.`, sourceModel.auth.map((a) => a.evidence));
  }

  require('validate.compile-structure', 'Generated code must be checked structurally before anyone is asked to trust it.', ['always']);

  // The BMAD document set is on by default — the work is planned this way, so it should be
  // written up this way — but it is a spec-level choice a human can turn off.
  if (spec.bmadArtifacts !== false) {
    require(
      'docs.bmad.generate',
      'The project is run the BMAD way, so it should hand back the BMAD document set: brief, PRD, architecture, epics and stories, all derived from what this run actually found.',
      ['bmad method'],
    );
  }

  /* ---- risks -------------------------------------------------------- */

  if (sourceModel.totals.assertions > 0) {
    risk('risk.assertion-loss', 'Assertion loss', 'blocker', `${sourceModel.totals.assertions} assertions exist in the source and can silently disappear during translation.`, `${sourceModel.totals.assertions} assertions across ${sourceModel.totals.tests} tests`);
  }
  if (sourceModel.totals.tests > 0) {
    risk('risk.test-loss', 'Test case loss', 'blocker', `${sourceModel.totals.tests} test cases must all survive.`, `${sourceModel.totals.suites} suites`);
    risk('risk.partial-migration', 'Partial migration', 'major', 'A run can succeed while covering only part of the suite.', `${sourceModel.totals.tests} source tests`);
  }
  if (sourceModel.dataFiles.length) {
    risk('risk.data-loss', 'Test data loss', 'blocker', 'Fixture reformatting is the most common place records go missing.', sourceModel.dataFiles.map((f) => `${f.path} (${f.records} records)`).join(', '));
  }
  if (requirements.length) {
    risk('risk.traceability-loss', 'Traceability loss', 'major', 'Requirements can end up with no test pointing back at them.', `${requirements.length} requirements`);
  }
  risk('risk.broken-output', 'Structurally broken output', 'blocker', 'Generated code can look plausible and still not compile.', 'always checked');
  risk('risk.unmapped-constructs', 'Unmapped source constructs', 'major', 'Constructs with no target equivalent must be surfaced rather than dropped.', `${sourceModel.unmapped.length} already detected during discovery`);

  if (sourceModel.requests.length) {
    risk('risk.contract-drift', 'API contract drift', 'blocker', 'Method, path or expected status can shift during rewriting.', `${sourceModel.requests.length} requests`);
  }
  if (sourceModel.auth.length) {
    risk('risk.auth-break', 'Authentication break', 'major', 'Auth flows rarely translate literally between frameworks.', sourceModel.auth.map((a) => a.scheme).join(', '));
  }

  for (const artifact of artifacts) {
    for (const pattern of PII_PATTERNS) {
      if (pattern.re.test(artifact.content || '')) {
        risk('risk.pii-exposure', 'PII exposure', 'blocker', `Real-looking ${pattern.label} found in the source artifacts; it must not be copied into generated code.`, artifact.path);
      }
    }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(artifact.content || '')) {
        risk('risk.secret-leakage', 'Secret leakage', 'blocker', `Hardcoded ${pattern.label} found in ${artifact.path}; it must move to an environment variable.`, artifact.path);
      }
    }
  }

  /* ---- gaps --------------------------------------------------------- */

  // A custom project has no expectation of a parser or an emitter, so neither is a gap.
  if (!isCustom && !SUPPORTED_SOURCE_PARSERS.includes(source.id)) {
    gaps.push({
      capability: source.analyzeCapability || 'source.analyze.unknown',
      reason: `No parser exists for "${spec.sourceStack || 'the declared source'}".`,
      needs: 'A source parser / grammar for this technology. Until it exists the platform cannot read the suite, and no amount of prompting changes that.',
      blocking: true,
    });
    risk('risk.generated-agent', 'Unbuilt capability in the path', 'blocker', 'The migration depends on a capability the platform does not have yet.', spec.sourceStack || 'unknown source');
  }
  if (!isCustom && !target.generateCapability) {
    gaps.push({
      capability: 'target.generate.unknown',
      reason: `No emitter exists for "${spec.targetStack || 'the declared target'}".`,
      needs: 'A target emitter (templates + selector dialect + assertion mapping) for this framework.',
      blocking: true,
    });
    risk('risk.generated-agent', 'Unbuilt capability in the path', 'blocker', 'The migration depends on a capability the platform does not have yet.', spec.targetStack || 'unknown target');
  }

  const migrationKind =
    source.kind !== 'unknown' && target.kind !== 'unknown' && source.kind === target.kind
      ? `${source.kind}-migration`
      : source.kind !== 'unknown'
        ? `${source.kind}-migration`
        : 'unknown-migration';

  return {
    id: id('disc'),
    createdAt: new Date().toISOString(),
    migrationKind,
    source,
    target,
    requirements,
    entities: {
      artifacts: artifacts.length,
      suites: sourceModel.totals.suites,
      tests: sourceModel.totals.tests,
      assertions: sourceModel.totals.assertions,
      steps: sourceModel.totals.steps,
      locators: sourceModel.totals.locators,
      requests: sourceModel.totals.requests,
      dataFiles: sourceModel.dataFiles.length,
      dataRecords: sourceModel.totals.dataRecords,
      authSchemes: sourceModel.auth.map((a) => a.scheme),
    },
    sourceModel,
    capabilities: capabilities.sort((a, b) => a.phase - b.phase),
    risks,
    gaps,
    summary: buildSummary({ source, target, sourceModel, requirements, gaps }),
  };
}

function buildSummary({ source, target, sourceModel, requirements, gaps }) {
  const lines = [
    `Migrating ${source.label} → ${target.label}.`,
    `${sourceModel.totals.suites} suite(s), ${sourceModel.totals.tests} test case(s), ${sourceModel.totals.assertions} assertion(s), ${sourceModel.totals.locators} locator(s) read from ${sourceModel.suites.length ? 'the supplied artifacts' : 'no parseable artifacts'}.`,
  ];
  if (sourceModel.dataFiles.length) lines.push(`${sourceModel.dataFiles.length} fixture file(s) carrying ${sourceModel.totals.dataRecords} records.`);
  if (requirements.length) lines.push(`${requirements.length} requirement(s) available to trace against.`);
  if (sourceModel.unmapped.length) lines.push(`${sourceModel.unmapped.length} construct(s) already look unmappable and will need a human decision.`);
  if (gaps.length) lines.push(`${gaps.length} capability gap(s) block a fully automated run.`);
  return lines.join(' ');
}
