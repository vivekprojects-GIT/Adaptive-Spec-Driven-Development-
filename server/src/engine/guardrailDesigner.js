/**
 * Guardrail Designer — stage 3 of the control plane.
 *
 * Discovery emits risks; this maps each risk to guardrails from the registry, and adds
 * project-specific proposals where the shape of the project (not a generic risk) demands one.
 */
import { findByRisk, listGuardrails } from '../registry/guardrails.js';
import { id } from '../lib/util.js';

export function proposeGuardrails(discovery) {
  const proposals = [];
  const seen = new Set();

  for (const risk of discovery.risks) {
    const matches = findByRisk(risk.id);
    if (!matches.length) {
      // A risk nobody covers becomes a custom proposal rather than being dropped.
      proposals.push({
        proposalId: id('gp'),
        kind: 'guardrail',
        decision: 'proposed',
        source: 'generated',
        guardrailId: `guard.custom.${risk.id.replace(/\./g, '-')}`,
        name: `${risk.label} watch (project-specific)`,
        risks: [risk.id],
        severity: risk.severity,
        description: `No registry guardrail covers "${risk.label}". This one records the risk on the run and forces a human sign-off.`,
        check: 'manualSignOff',
        params: {},
        rationale: risk.why,
        coversRisk: risk,
      });
      continue;
    }
    for (const guardrail of matches) {
      if (seen.has(guardrail.id)) continue;
      seen.add(guardrail.id);
      proposals.push({
        proposalId: id('gp'),
        kind: 'guardrail',
        decision: 'proposed',
        source: 'registry',
        guardrailId: guardrail.id,
        name: guardrail.name,
        risks: guardrail.risks,
        severity: guardrail.severity,
        description: guardrail.description,
        check: guardrail.check,
        params: { ...guardrail.params },
        rationale: `Covers "${risk.label}": ${risk.why}`,
        coversRisk: risk,
      });
    }
  }

  // Tune the coverage threshold to what discovery actually found.
  const coverage = proposals.find((p) => p.guardrailId === 'guard.coverage-threshold');
  if (coverage && discovery.entities.tests > 0) {
    coverage.params.threshold = discovery.gaps.length ? 0.7 : 0.95;
    coverage.rationale += ` Threshold set to ${coverage.params.threshold} because ${discovery.gaps.length ? 'capability gaps make a full migration unrealistic in this run' : 'every required capability is available'}.`;
  }

  return proposals.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function severityRank(severity) {
  return { blocker: 3, major: 2, minor: 1 }[severity] ?? 0;
}

/**
 * "Create my own guardrail" — the human writes the rule in plain English, says which agent it
 * applies to, and says what should happen when it fails. `onFailure: 'stop'` is honoured by the
 * orchestrator: the workflow halts at that agent and asks for review.
 */
export function customGuardrailProposal(input) {
  const known = listGuardrails().find((g) => g.id === input.guardrailId);
  const rule = input.rule?.trim() || '';
  return {
    proposalId: id('gp'),
    kind: 'guardrail',
    decision: 'accepted',
    source: known ? 'registry' : 'custom',
    guardrailId: known?.id || `guard.custom.${(input.name || 'rule').toLowerCase().replace(/\W+/g, '-')}`,
    name: input.name || known?.name || 'Custom guardrail',
    risks: input.risks || known?.risks || ['risk.custom'],
    severity: input.severity || known?.severity || 'major',
    description: rule || input.description || known?.description || 'Human-authored guardrail.',
    rule: rule || null,
    appliesTo: input.appliesTo || 'workflow',
    appliesToLabel: input.appliesToLabel || 'The whole workflow',
    onFailure: input.onFailure || 'flag',
    // A rule written in English is evaluated by customRule; anything else keeps its named check.
    check: input.check || (rule ? 'customRule' : known?.check || 'manualSignOff'),
    params: input.params || known?.params || {},
    rationale: rule
      ? `Authored by a human: "${rule.slice(0, 160)}"`
      : 'Added by a human during guardrail review.',
  };
}

export const ON_FAILURE_OPTIONS = [
  { value: 'stop', label: 'Stop workflow and request review' },
  { value: 'flag', label: 'Flag it and carry on' },
  { value: 'continue', label: 'Record it only' },
];
