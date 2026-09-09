/**
 * Guardrail Registry.
 *
 * Architecture invariant #3: a verdict must be computed from artifacts. Each guardrail names a
 * `check` implemented in engine/validator.js; a guardrail whose check cannot run returns `warn`,
 * never `pass`.
 *
 * `risks` is the join used by the Guardrail Designer: discovery emits risk ids, and any guardrail
 * covering one of them is recommended.
 */
import { collection } from '../lib/store.js';

export const SEED_GUARDRAILS = [
  {
    id: 'guard.no-assertion-loss',
    name: 'No Assertion Loss',
    risks: ['risk.assertion-loss'],
    severity: 'blocker',
    description: 'Every assertion found in the source must have a counterpart in the generated output.',
    check: 'assertionParity',
    params: { tolerance: 0 },
  },
  {
    id: 'guard.no-test-case-loss',
    name: 'No Test Case Loss',
    risks: ['risk.test-loss'],
    severity: 'blocker',
    description: 'The number of migrated test cases must match the number discovered in the source.',
    check: 'testCaseParity',
    params: { tolerance: 0 },
  },
  {
    id: 'guard.test-data-preservation',
    name: 'Test Data Preservation',
    risks: ['risk.data-loss'],
    severity: 'blocker',
    description: 'Fixture record counts in must equal record counts out.',
    check: 'dataParity',
    params: {},
  },
  {
    id: 'guard.requirement-traceability',
    name: 'Requirement Traceability',
    risks: ['risk.traceability-loss'],
    severity: 'major',
    description: 'Every requirement in the spec must map to at least one generated test.',
    check: 'requirementCoverage',
    params: { minCoverage: 1 },
  },
  {
    id: 'guard.unsupported-feature-detection',
    name: 'Unsupported Feature Detection',
    risks: ['risk.unmapped-constructs'],
    severity: 'major',
    description: 'Any source construct the generator could not map must be listed, not silently dropped.',
    check: 'unmappedConstructs',
    params: { maxUnmapped: 0 },
  },
  {
    id: 'guard.structure-compilation',
    name: 'Compilation / Structure Check',
    risks: ['risk.broken-output'],
    severity: 'blocker',
    description: 'Generated files must be structurally sound: balanced delimiters, imports present, no empty tests.',
    check: 'structureSound',
    params: {},
  },
  {
    id: 'guard.pii-protection',
    name: 'PII Protection',
    risks: ['risk.pii-exposure'],
    severity: 'blocker',
    description: 'Generated artifacts must not carry real emails, national IDs or card numbers.',
    check: 'noPii',
    params: {},
  },
  {
    id: 'guard.no-secret-leakage',
    name: 'No Hardcoded Secrets',
    risks: ['risk.secret-leakage'],
    severity: 'blocker',
    description: 'Credentials and API keys must be read from the environment, not embedded in generated code.',
    check: 'noSecrets',
    params: {},
  },
  {
    id: 'guard.coverage-threshold',
    name: 'Coverage Threshold',
    risks: ['risk.partial-migration'],
    severity: 'major',
    description: 'Migrated share of the source suite must meet the configured threshold.',
    check: 'coverageThreshold',
    params: { threshold: 0.9 },
  },
  {
    id: 'guard.api-contract-preservation',
    name: 'API Contract Preservation',
    risks: ['risk.contract-drift'],
    severity: 'blocker',
    description: 'Every request method, path and expected status must survive the migration unchanged.',
    check: 'apiContractParity',
    params: {},
  },
  {
    id: 'guard.auth-validation',
    name: 'Authentication Validation',
    risks: ['risk.auth-break'],
    severity: 'major',
    description: 'Every auth scheme used by the source suite must be handled by the target setup.',
    check: 'authCoverage',
    params: {},
  },
  {
    id: 'guard.no-unimplemented-agents',
    name: 'No Unimplemented Agents In Path',
    risks: ['risk.generated-agent'],
    severity: 'major',
    description:
      'A generated agent running on the fallback adapter produced a placeholder rather than real work — the run must say so.',
    check: 'noPlaceholderOutput',
    params: {},
  },
];

const guardrails = collection('registry-guardrails');

export function ensureSeeded() {
  const existing = guardrails.all();
  if (!existing.length) {
    guardrails.replaceAll(SEED_GUARDRAILS.map((g) => ({ ...g, source: 'registry' })));
    return;
  }
  const byId = new Map(existing.map((g) => [g.id, g]));
  let changed = false;
  for (const seed of SEED_GUARDRAILS) {
    if (!byId.has(seed.id)) {
      existing.push({ ...seed, source: 'registry' });
      changed = true;
    }
  }
  if (changed) guardrails.replaceAll(existing);
}

export function listGuardrails() {
  ensureSeeded();
  return guardrails.all();
}

export function findByRisk(riskId) {
  return listGuardrails().filter((g) => (g.risks || []).includes(riskId));
}

export function addGuardrail(guardrail) {
  ensureSeeded();
  return guardrails.insert(guardrail);
}

export function removeGuardrail(guardrailId) {
  guardrails.remove(guardrailId);
}
