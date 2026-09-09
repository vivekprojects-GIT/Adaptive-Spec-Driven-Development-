/**
 * Workflow Composer — stage 4 of the control plane.
 *
 * Turns the accepted agent proposals into a validated DAG. Edges come from capability phases,
 * not from a hand-written pipeline: that is the whole point of the adaptive design.
 *
 * Each node depends on every node in the nearest preceding non-empty phase, which produces a
 * readable layered graph and a correct topological order.
 */
import { id } from '../lib/util.js';

export function composeWorkflow(acceptedAgents, options = {}) {
  const nodes = acceptedAgents.map((agent, index) => ({
    nodeId: `n${index + 1}`,
    proposalId: agent.proposalId,
    agentId: agent.agentId,
    name: agent.name,
    capability: agent.capability,
    group: agent.group,
    phase: agent.phase,
    impl: agent.impl,
    inputs: agent.inputs,
    outputs: agent.outputs,
    source: agent.source,
  }));

  if (!nodes.length) {
    return { id: id('wf'), nodes: [], edges: [], order: [], layers: [], errors: ['No agents accepted — nothing to compose.'] };
  }

  const phases = [...new Set(nodes.map((n) => n.phase))].sort((a, b) => a - b);
  const layers = phases.map((phase) => ({ phase, nodes: nodes.filter((n) => n.phase === phase).map((n) => n.nodeId) }));

  const edges = [];
  for (let i = 1; i < layers.length; i += 1) {
    for (const from of layers[i - 1].nodes) {
      for (const to of layers[i].nodes) {
        edges.push({ from, to });
      }
    }
  }

  const errors = [];
  const order = topologicalOrder(nodes, edges, errors);

  // Sanity: a generator with no analyzer upstream is a composition the user should see flagged.
  const hasAnalyzer = nodes.some((n) => n.capability.startsWith('source.analyze'));
  const hasGenerator = nodes.some((n) => n.capability.startsWith('target.generate'));
  if (hasGenerator && !hasAnalyzer) {
    errors.push('A target generator is accepted with no source analyzer — the generator will have no source model to read.');
  }
  if (!hasGenerator) {
    errors.push('No target generator accepted — the run will analyse and validate but produce no migrated code.');
  }

  return { id: id('wf'), createdAt: new Date().toISOString(), nodes, edges, layers, order, errors, notes: options.notes || [] };
}

function topologicalOrder(nodes, edges, errors) {
  const indegree = new Map(nodes.map((n) => [n.nodeId, 0]));
  const adjacency = new Map(nodes.map((n) => [n.nodeId, []]));
  for (const edge of edges) {
    adjacency.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }
  const queue = nodes.filter((n) => indegree.get(n.nodeId) === 0).map((n) => n.nodeId);
  const order = [];
  while (queue.length) {
    const current = queue.shift();
    order.push(current);
    for (const next of adjacency.get(current)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) {
    errors.push('Cycle detected in the composed graph — the workflow cannot be executed.');
  }
  return order;
}
