import { Router } from 'express';
import { collection } from '../lib/store.js';
import { runDiscovery, parseRequirements } from '../engine/discovery.js';
import { proposeAgents, customAgentProposal } from '../engine/agentFactory.js';
import { proposeGuardrails, customGuardrailProposal } from '../engine/guardrailDesigner.js';
import { composeWorkflow } from '../engine/workflowComposer.js';
import { assessSpec, applyAnswers } from '../engine/interview.js';
import { createRun, executeRun, listRuns, deleteRunsForProject } from '../engine/orchestrator.js';
import { addAgent, listAgents } from '../registry/agents.js';
import { addGuardrail } from '../registry/guardrails.js';
import { id, now, HttpError, asyncH } from '../lib/util.js';

const projects = collection('projects');
const router = Router();

const EMPTY_SPEC = {
  // 'migration' assumes a source suite and a target framework. 'custom' assumes nothing at all —
  // the human authors the agents and the platform only contributes what it can prove.
  projectKind: 'migration',
  requirements: '',
  sourceStack: '',
  targetStack: '',
  constraints: '',
  artifacts: [],
  clarifications: {},
};

function trail(project, entry) {
  const trailEntries = project.trail || [];
  trailEntries.unshift({ id: id('ev'), at: now(), actor: entry.actor || 'human', ...entry });
  return trailEntries.slice(0, 400);
}

function must(projectId) {
  const project = projects.find(projectId);
  if (!project) throw new HttpError(404, `Project ${projectId} not found`);
  return project;
}

/* ------------------------------------------------------------- projects */

router.get('/', (req, res) => {
  res.json(
    projects.all().map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      stage: project.stage,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      source: project.spec?.sourceStack,
      target: project.spec?.targetStack,
      readiness: project.interview?.readiness ?? 0,
      runs: listRuns(project.id).length,
    })),
  );
});

router.post('/', (req, res) => {
  const { name, description, spec } = req.body || {};
  if (!name?.trim()) throw new HttpError(400, 'A project name is required.');
  const project = {
    id: id('prj'),
    name: name.trim(),
    description: description || '',
    stage: 'spec',
    createdAt: now(),
    updatedAt: now(),
    spec: { ...EMPTY_SPEC, ...(spec || {}) },
    interview: null,
    discovery: null,
    proposals: { agents: [], guardrails: [] },
    graph: null,
    trail: [],
  };
  project.trail = trail(project, { stage: 'spec', action: 'project.created', detail: `Project "${project.name}" created.` });
  projects.insert(project);
  res.status(201).json(project);
});

router.get('/:id', (req, res) => {
  const project = must(req.params.id);
  res.json({ ...project, runs: listRuns(project.id).map(summariseRun) });
});

router.delete('/:id', (req, res) => {
  must(req.params.id);
  deleteRunsForProject(req.params.id);
  projects.remove(req.params.id);
  res.json({ ok: true });
});

router.put('/:id/spec', (req, res) => {
  const project = must(req.params.id);
  const spec = { ...project.spec, ...(req.body || {}) };
  const updated = projects.update(project.id, {
    spec,
    stage: project.stage === 'spec' ? 'spec' : project.stage,
    trail: trail(project, { stage: 'spec', action: 'spec.updated', detail: describeSpecChange(project.spec, spec) }),
  });
  res.json(updated);
});

function describeSpecChange(before, after) {
  const changes = [];
  if (before.sourceStack !== after.sourceStack) changes.push(`source → "${after.sourceStack}"`);
  if (before.targetStack !== after.targetStack) changes.push(`target → "${after.targetStack}"`);
  if ((before.artifacts || []).length !== (after.artifacts || []).length) changes.push(`artifacts ${before.artifacts?.length || 0} → ${after.artifacts?.length || 0}`);
  if (before.requirements !== after.requirements) changes.push('requirements edited');
  if (before.constraints !== after.constraints) changes.push('constraints edited');
  return changes.length ? `Spec updated: ${changes.join(', ')}.` : 'Spec saved with no field changes.';
}

/* ------------------------------------------------------------ artifacts */

router.post('/:id/artifacts', (req, res) => {
  const project = must(req.params.id);
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const artifacts = [...(project.spec.artifacts || [])];
  for (const file of incoming) {
    if (!file?.path || typeof file.content !== 'string') throw new HttpError(400, 'Each artifact needs a path and string content.');
    artifacts.push({ id: id('src'), path: file.path, content: file.content, bytes: Buffer.byteLength(file.content, 'utf8'), addedAt: now() });
  }
  const updated = projects.update(project.id, {
    spec: { ...project.spec, artifacts },
    trail: trail(project, { stage: 'spec', action: 'artifacts.added', detail: `Added ${incoming.length} artifact(s): ${incoming.map((f) => f.path).join(', ')}.` }),
  });
  res.json(updated);
});

router.delete('/:id/artifacts/:artifactId', (req, res) => {
  const project = must(req.params.id);
  const removed = (project.spec.artifacts || []).find((a) => a.id === req.params.artifactId);
  const artifacts = (project.spec.artifacts || []).filter((a) => a.id !== req.params.artifactId);
  const updated = projects.update(project.id, {
    spec: { ...project.spec, artifacts },
    trail: trail(project, { stage: 'spec', action: 'artifacts.removed', detail: `Removed ${removed?.path || req.params.artifactId}.` }),
  });
  res.json(updated);
});

/**
 * Import a requirements document. Some people paste three lines, some upload a 40-page spec —
 * both land here, and the parser reports how many requirements it actually recognised so nobody
 * has to guess whether the import worked.
 */
router.post('/:id/requirements/import', (req, res) => {
  const project = must(req.params.id);
  const { content, path: docPath, mode = 'append' } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'content is required.');

  const extracted = parseRequirements(content);
  if (!extracted.length) {
    throw new HttpError(422, 'No requirements could be recognised in that document. Paste them directly, or check that the file is text.', {
      lines: content.split('\n').length,
    });
  }

  const asText = extracted.map((requirement) => `${requirement.id} ${requirement.text}`).join('\n');
  const requirements = mode === 'replace' || !project.spec.requirements ? asText : `${project.spec.requirements}\n${asText}`;

  const updated = projects.update(project.id, {
    spec: { ...project.spec, requirements, requirementsSource: docPath || 'pasted document' },
    trail: trail(project, {
      stage: 'spec',
      action: 'requirements.imported',
      detail: `Imported ${extracted.length} requirement(s) from ${docPath || 'a pasted document'} (${mode}).`,
    }),
  });
  res.json({ project: updated, extracted });
});

/* ------------------------------------------------------------ interview */

router.post('/:id/interview', asyncH(async (req, res) => {
  const project = must(req.params.id);
  const answers = { ...(project.interview?.answers || {}), ...(req.body?.answers || {}) };
  const spec = req.body?.applyAnswers === false ? project.spec : applyAnswers(project.spec, answers);
  const assessment = await assessSpec(spec, answers, { withLlm: req.body?.withLlm !== false });

  const updated = projects.update(project.id, {
    spec,
    interview: { ...assessment, answers, assessedAt: now() },
    stage: assessment.ready ? 'discovery' : 'interview',
    trail: trail(project, {
      stage: 'interview',
      actor: 'control-plane',
      action: 'interview.assessed',
      detail: `Readiness ${assessment.readiness}%. ${assessment.blockingCount} blocking question(s) outstanding. ${assessment.llm.detail}`,
    }),
  });
  res.json(updated);
}));

router.post('/:id/interview/answer', asyncH(async (req, res) => {
  const project = must(req.params.id);
  const { questionId, answer } = req.body || {};
  if (!questionId) throw new HttpError(400, 'questionId is required.');

  const answers = { ...(project.interview?.answers || {}), [questionId]: answer };
  const spec = applyAnswers(project.spec, answers);
  const assessment = await assessSpec(spec, answers, { withLlm: false });
  const question = (project.interview?.questions || []).find((q) => q.id === questionId);

  const updated = projects.update(project.id, {
    spec,
    interview: { ...assessment, answers, assessedAt: now() },
    stage: assessment.ready ? 'discovery' : 'interview',
    trail: trail(project, {
      stage: 'interview',
      action: 'interview.answered',
      detail: `Answered "${question?.question || questionId}" → "${String(answer).slice(0, 120)}". Readiness now ${assessment.readiness}%.`,
    }),
  });
  res.json(updated);
}));

/* ------------------------------------------------------------ discovery */

router.post('/:id/discover', (req, res) => {
  const project = must(req.params.id);
  if (project.interview && !project.interview.ready && !req.body?.force) {
    throw new HttpError(409, 'Requirements are not ready yet. Answer the blocking questions first, or pass force:true to proceed anyway.', {
      blockingCount: project.interview.blockingCount,
    });
  }

  const discovery = runDiscovery(project.spec);
  const { proposals: agentProposals, gaps } = proposeAgents(discovery);
  discovery.gaps = gaps;
  const guardrailProposals = proposeGuardrails(discovery);

  const updated = projects.update(project.id, {
    discovery,
    proposals: { agents: agentProposals, guardrails: guardrailProposals },
    graph: null,
    stage: 'agents',
    trail: trail(project, {
      stage: 'discovery',
      actor: 'control-plane',
      action: 'discovery.completed',
      detail: `${discovery.summary} Proposed ${agentProposals.length} agent(s) and ${guardrailProposals.length} guardrail(s); ${gaps.length} gap(s).`,
    }),
  });
  res.json(updated);
});

/* ------------------------------------------------------------ proposals */

function decide(project, kind, proposalId, action, patch) {
  const list = project.proposals[kind] || [];
  const index = list.findIndex((p) => p.proposalId === proposalId);
  if (index === -1) throw new HttpError(404, `Proposal ${proposalId} not found.`);
  const proposal = { ...list[index] };

  if (action === 'accept') proposal.decision = 'accepted';
  else if (action === 'reject') proposal.decision = 'rejected';
  else if (action === 'edit') {
    Object.assign(proposal, patch || {}, { decision: 'accepted', edited: true });
  } else throw new HttpError(400, `Unknown action "${action}".`);

  const next = [...list];
  next[index] = proposal;
  return { proposals: { ...project.proposals, [kind]: next }, proposal };
}

router.post('/:id/proposals/:kind/bulk', (req, res) => {
  const project = must(req.params.id);
  const kind = req.params.kind === 'agents' ? 'agents' : 'guardrails';
  const action = req.body?.action === 'reject' ? 'reject' : 'accept';
  const only = req.body?.only; // e.g. 'reuse' — accept only registry hits

  const list = (project.proposals[kind] || []).map((proposal) => {
    if (proposal.decision !== 'proposed') return proposal;
    if (only && proposal.source !== only) return proposal;
    // "Author your own" is an invitation, not a proposal — accepting it in bulk would put a
    // placeholder in the graph and call it a decision.
    if (proposal.authorRequired) return proposal;
    return { ...proposal, decision: action === 'accept' ? 'accepted' : 'rejected' };
  });

  const updated = projects.update(project.id, {
    proposals: { ...project.proposals, [kind]: list },
    graph: null,
    trail: trail(project, {
      stage: kind,
      action: `${kind}.bulk-${action}`,
      detail: `Bulk ${action}ed ${kind}${only ? ` limited to source="${only}"` : ''}.`,
    }),
  });
  res.json(updated);
});

router.post('/:id/proposals/:kind/:proposalId', (req, res) => {
  const project = must(req.params.id);
  const kind = req.params.kind === 'agents' ? 'agents' : 'guardrails';
  const { action, patch } = req.body || {};
  const { proposals, proposal } = decide(project, kind, req.params.proposalId, action, patch);

  const updated = projects.update(project.id, {
    proposals,
    graph: null,
    trail: trail(project, {
      stage: kind === 'agents' ? 'agents' : 'guardrails',
      action: `${kind.slice(0, -1)}.${action}`,
      detail: `${action === 'edit' ? 'Edited and accepted' : action === 'accept' ? 'Accepted' : 'Rejected'} "${proposal.name}"${proposal.capability ? ` (${proposal.capability})` : ''}.`,
    }),
  });
  res.json(updated);
});

router.post('/:id/proposals/:kind', (req, res) => {
  const project = must(req.params.id);
  const kind = req.params.kind === 'agents' ? 'agents' : 'guardrails';
  const accepted = (project.proposals.agents || []).filter((a) => a.decision === 'accepted');
  const proposal = kind === 'agents' ? customAgentProposal(req.body || {}, accepted) : customGuardrailProposal(req.body || {});

  if (req.body?.saveToRegistry) {
    if (kind === 'agents') {
      addAgent({
        id: proposal.agentId,
        name: proposal.name,
        capability: proposal.capability,
        description: proposal.description,
        inputs: proposal.inputs,
        outputs: proposal.outputs,
        impl: proposal.impl,
        authored: proposal.authored,
        tags: ['user'],
        maturity: 'custom',
        source: 'user',
      });
    } else {
      addGuardrail({
        id: proposal.guardrailId,
        name: proposal.name,
        risks: proposal.risks,
        severity: proposal.severity,
        description: proposal.description,
        rule: proposal.rule,
        appliesTo: proposal.appliesTo,
        onFailure: proposal.onFailure,
        check: proposal.check,
        params: proposal.params,
        source: 'user',
      });
    }
  }

  const updated = projects.update(project.id, {
    proposals: { ...project.proposals, [kind]: [...(project.proposals[kind] || []), proposal] },
    graph: null,
    trail: trail(project, {
      stage: kind,
      action: `${kind.slice(0, -1)}.created`,
      detail: `Human added "${proposal.name}"${req.body?.saveToRegistry ? ' and saved it to the registry for reuse' : ''}.`,
    }),
  });
  res.json(updated);
});

/* -------------------------------------------------------------- compose */

router.post('/:id/compose', (req, res) => {
  const project = must(req.params.id);
  const accepted = (project.proposals.agents || []).filter((a) => a.decision === 'accepted');
  const graph = composeWorkflow(accepted);

  const updated = projects.update(project.id, {
    graph,
    stage: graph.errors.length && !graph.order.length ? 'workflow' : 'workflow',
    trail: trail(project, {
      stage: 'workflow',
      actor: 'control-plane',
      action: 'workflow.composed',
      detail: `Composed ${graph.nodes.length} node(s) across ${graph.layers.length} layer(s) with ${graph.edges.length} edge(s).${graph.errors.length ? ` Warnings: ${graph.errors.join(' ')}` : ''}`,
    }),
  });
  res.json(updated);
});

/* ------------------------------------------------------------------ run */

router.post('/:id/runs', asyncH(async (req, res) => {
  const project = must(req.params.id);
  if (!project.graph?.order?.length) throw new HttpError(409, 'Compose a workflow before running.');
  if (project.graph.errors.includes('Cycle detected in the composed graph — the workflow cannot be executed.')) {
    throw new HttpError(409, 'The composed graph has a cycle and cannot be executed.');
  }

  const run = createRun(project);
  projects.update(project.id, {
    stage: 'run',
    trail: trail(project, { stage: 'run', action: 'run.started', detail: `Run ${run.id} started with ${run.nodes.length} agent(s) and ${run.guardrails.length} guardrail(s).` }),
  });

  // Fire and forget — the client follows progress on the SSE stream.
  executeRun(run.id, project)
    .then((finished) => {
      const latest = projects.find(project.id);
      projects.update(project.id, {
        trail: trail(latest, {
          stage: 'run',
          actor: 'control-plane',
          action: 'run.finished',
          detail: `Run ${finished.id} ${finished.status}; verdict ${finished.validation?.verdict}.`,
        }),
      });
    })
    .catch(() => {});

  res.status(202).json({ runId: run.id });
}));

router.get('/:id/runs', (req, res) => {
  must(req.params.id);
  res.json(listRuns(req.params.id).map(summariseRun));
});

function summariseRun(run) {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    verdict: run.validation?.verdict || null,
    nodes: run.nodes.length,
    artifacts: run.ws?.generated?.length || 0,
    modelUsed: run.modelUsed,
  };
}

export default router;
