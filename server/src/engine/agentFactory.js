/**
 * Agent Factory — stage 2 of the control plane.
 *
 * Invariant #1: registry-first.
 *   capability → registry match?  yes → REUSE
 *                                 no  → can we describe a generatable adapter? → GENERATE (proposal)
 *                                 no  → GAP (surface it, never fake it)
 *
 * Nothing here executes. It emits proposals; a human accepts or rejects them.
 */
import { findByCapability, listAgents } from '../registry/agents.js';
import { capabilityGroup, capabilityPhase } from './discovery.js';
import { id, pascal } from '../lib/util.js';

/**
 * Capabilities we are willing to synthesise an agent for. These are orchestration-shaped jobs
 * (mapping, bookkeeping, reporting) where a generic adapter genuinely can carry the work.
 * Parsing and code emission are deliberately NOT here — those need a real implementation.
 */
const GENERATABLE_PREFIXES = ['mapping.', 'data.', 'auth.', 'traceability', 'validate.', 'spec.'];

function isGeneratable(capability) {
  return GENERATABLE_PREFIXES.some((prefix) => capability.startsWith(prefix));
}

export function proposeAgents(discovery) {
  const proposals = [];
  const gaps = [...(discovery.gaps || [])];

  for (const capability of discovery.capabilities) {
    const matches = findByCapability(capability.id);

    if (matches.length) {
      const best = pickBest(matches);
      proposals.push({
        proposalId: id('ap'),
        kind: 'agent',
        decision: 'proposed',
        source: 'reuse',
        capability: capability.id,
        group: capability.group,
        phase: capability.phase,
        agentId: best.id,
        name: best.name,
        description: best.description,
        inputs: best.inputs,
        outputs: best.outputs,
        impl: best.impl,
        maturity: best.maturity || 'unknown',
        rationale: `Registry hit: "${best.name}" already provides ${capability.id}. ${capability.why}`,
        alternatives: matches.filter((m) => m.id !== best.id).map((m) => ({ agentId: m.id, name: m.name })),
      });
      continue;
    }

    if (isGeneratable(capability.id)) {
      const name = `${pascal(capability.id.split('.').slice(-1)[0])} Agent (generated)`;
      proposals.push({
        proposalId: id('ap'),
        kind: 'agent',
        decision: 'proposed',
        source: 'generated',
        capability: capability.id,
        group: capability.group,
        phase: capability.phase,
        agentId: `agent.generated.${capability.id.replace(/\./g, '-')}`,
        name,
        description: `No registry agent provides ${capability.id}. This agent is synthesised for the project and runs on the generic adapter, which records intent and hands off to a human.`,
        inputs: ['analysis/source-model.json'],
        outputs: [`analysis/${capability.id.replace(/\./g, '-')}.json`],
        impl: 'genericAdapter',
        maturity: 'generated',
        rationale: `${capability.why} No registry match, but the capability is orchestration-shaped, so a project-specific agent is proposed instead of blocking the run.`,
        alternatives: [],
        warning: 'Runs on the fallback adapter — its output is a scaffold, not finished work.',
      });
      continue;
    }

    // Neither reusable nor safely generatable.
    if (!gaps.some((g) => g.capability === capability.id)) {
      gaps.push({
        capability: capability.id,
        reason: `No registry agent provides ${capability.id}, and this capability needs a real implementation (parser, emitter, connector or runtime) rather than a generic adapter.`,
        needs: capability.id.startsWith('source.analyze')
          ? 'A parser for this source technology.'
          : capability.id.startsWith('target.generate')
            ? 'An emitter for this target framework.'
            : 'A purpose-built implementation.',
        blocking: true,
      });
    }
  }

  return { proposals: proposals.sort((a, b) => a.phase - b.phase), gaps };
}

function pickBest(matches) {
  const rank = { proven: 3, beta: 2, generated: 1, unknown: 0 };
  return [...matches].sort((a, b) => (rank[b.maturity] ?? 0) - (rank[a.maturity] ?? 0))[0];
}

/** Used when a human clicks "Create your own" — builds a well-formed proposal from a form. */
export function customAgentProposal(input) {
  const capability = input.capability || `custom.${(input.name || 'agent').toLowerCase().replace(/\W+/g, '-')}`;
  const known = listAgents().find((a) => a.id === input.agentId);
  return {
    proposalId: id('ap'),
    kind: 'agent',
    decision: 'accepted',
    source: known ? 'reuse' : 'custom',
    capability,
    group: capabilityGroup(capability),
    phase: Number(input.phase) || capabilityPhase(capability),
    agentId: known?.id || `agent.custom.${(input.name || 'agent').toLowerCase().replace(/\W+/g, '-')}`,
    name: input.name || known?.name || 'Custom agent',
    description: input.description || known?.description || 'Human-authored agent.',
    inputs: input.inputs || known?.inputs || [],
    outputs: input.outputs || known?.outputs || [],
    impl: input.impl || known?.impl || 'genericAdapter',
    maturity: known?.maturity || 'custom',
    rationale: 'Added by a human during proposal review.',
    alternatives: [],
  };
}
