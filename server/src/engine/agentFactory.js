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
        authored: best.authored || null,
        maturity: best.maturity || 'unknown',
        rationale: `Registry hit: "${best.name}" already provides ${capability.id}. ${capability.why}`,
        alternatives: matches.filter((m) => m.id !== best.id).map((m) => ({ agentId: m.id, name: m.name })),
      });
      continue;
    }

    // A custom project's workflow is the human's to author. That is not a gap in the platform —
    // it is the design — so it becomes an invitation rather than a blocker.
    if (capability.id.startsWith('custom.')) {
      proposals.push({
        proposalId: id('ap'),
        kind: 'agent',
        decision: 'proposed',
        source: 'author-required',
        authorRequired: true,
        capability: capability.id,
        group: capability.group,
        phase: capability.phase,
        agentId: `agent.author.${capability.id.replace(/\./g, '-')}`,
        name: 'Your agents go here',
        description:
          'This project is custom, so the platform does not presume to know the work. Use "Create your own" to author the agents that do it — name, purpose, inputs, output, instructions, and where each one runs.',
        inputs: [],
        outputs: [],
        impl: 'genericAdapter',
        maturity: 'n/a',
        rationale: capability.why,
        alternatives: [],
        warning: 'Accepting this placeholder as-is produces nothing. Author a real agent instead.',
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

/**
 * "Create my own agent" — the human authors purpose, inputs, output, instructions and where it
 * runs. The result is a first-class node in the graph, not an annotation on someone else's.
 *
 * `runAfter` is resolved against the agents already accepted, so "after BDD generation" means
 * exactly that, whatever the graph happens to look like on this project.
 */
export function customAgentProposal(input, acceptedAgents = []) {
  const capability = input.capability?.trim() || `custom.${(input.name || 'agent').toLowerCase().replace(/\W+/g, '-')}`;
  const known = listAgents().find((a) => a.id === input.agentId);
  const authored = {
    purpose: input.purpose || '',
    instructions: input.instructions || '',
    inputSelections: input.inputSelections || [],
    artifactFilter: input.artifactFilter || '',
    outputDescription: input.outputDescription || '',
    runAfter: input.runAfter || 'end',
    runAfterLabel: labelForRunAfter(input.runAfter, acceptedAgents),
  };

  return {
    proposalId: id('ap'),
    kind: 'agent',
    decision: 'accepted',
    source: known ? 'reuse' : 'custom',
    capability,
    group: capabilityGroup(capability),
    phase: resolvePhase(input, acceptedAgents, capability),
    agentId: known?.id || `agent.custom.${(input.name || 'agent').toLowerCase().replace(/\W+/g, '-')}`,
    name: input.name || known?.name || 'Custom agent',
    description: input.purpose || input.description || known?.description || 'Human-authored agent.',
    inputs: input.inputSelections?.length ? input.inputSelections : known?.inputs || [],
    outputs: input.outputDescription ? [input.outputDescription] : known?.outputs || [],
    // An authored agent with instructions runs on the instruction agent, which actually executes them.
    impl: input.impl || (input.instructions?.trim() ? 'instructionAgent' : known?.impl || 'genericAdapter'),
    maturity: known?.maturity || 'custom',
    authored,
    rationale: input.purpose
      ? `Authored by a human: ${input.purpose}`
      : 'Added by a human during proposal review.',
    alternatives: [],
  };
}

/** Positions in the graph a human can choose from, phrased the way the flow reads. */
export function runAfterOptions(acceptedAgents = []) {
  return [
    { value: 'start', label: 'Before everything else' },
    ...acceptedAgents
      .slice()
      .sort((a, b) => a.phase - b.phase)
      .map((agent) => ({ value: agent.agentId, label: `After ${agent.name}` })),
    { value: 'end', label: 'At the very end' },
  ];
}

function labelForRunAfter(runAfter, acceptedAgents) {
  if (!runAfter || runAfter === 'end') return 'At the very end';
  if (runAfter === 'start') return 'Before everything else';
  const match = acceptedAgents.find((agent) => agent.agentId === runAfter);
  return match ? `After ${match.name}` : 'At the very end';
}

function resolvePhase(input, acceptedAgents, capability) {
  if (input.phase !== undefined && input.phase !== null && input.phase !== '') return Number(input.phase);
  const runAfter = input.runAfter;
  if (runAfter === 'start') return 5;
  if (!runAfter || runAfter === 'end') return 60;
  const match = acceptedAgents.find((agent) => agent.agentId === runAfter);
  // Sit between the chosen agent and whatever came after it.
  return match ? match.phase + 1 : capabilityPhase(capability);
}
