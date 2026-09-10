/**
 * BMAD, as seen by ASDD: which install was found, which agents and workflows it has, and the
 * resolved persona brief for any agent — the same brief an ASDD run uses, and the one Copilot
 * receives when a chat asks to "work as Winston".
 */
import { Router } from 'express';
import { loadBmad, findBmadAgent, personaPrompt, resolveFacts } from '../bmad/loader.js';
import { getSettings } from '../lib/settings.js';
import { collection } from '../lib/store.js';
import { HttpError } from '../lib/util.js';
import { listRuns } from '../engine/orchestrator.js';

const projects = collection('projects');
const router = Router();

function current(force = false) {
  return loadBmad({ root: getSettings().bmadRoot || undefined, force });
}

router.get('/', (req, res) => {
  const bmad = current(req.query.reload === '1');
  res.json({
    found: bmad.found,
    root: bmad.root,
    searched: bmad.searched,
    version: bmad.version,
    user: bmad.config.user_name || null,
    agents: bmad.agents.map(({ overview, ...agent }) => agent),
    workflows: bmad.workflows.map(({ overview, workflow, ...wf }) => wf),
    deprecated: bmad.deprecated.length,
    problems: bmad.problems,
  });
});

router.get('/agents/:agentId/brief', (req, res) => {
  const bmad = current();
  if (!bmad.found) throw new HttpError(404, 'No BMAD install was found. Set its folder in Settings or ASDD_BMAD_ROOT.', { searched: bmad.searched });
  const agent = findBmadAgent(req.params.agentId, bmad);
  if (!agent) {
    throw new HttpError(404, `No BMAD agent matches "${req.params.agentId}".`, { available: bmad.agents.map((a) => `${a.name} (${a.id})`) });
  }

  const facts = resolveFacts(agent.persona.persistent_facts, bmad.root);
  const system = personaPrompt(agent, { facts, config: bmad.config });

  let context = null;
  if (req.query.projectId) {
    const project = projects.find(String(req.query.projectId));
    if (!project) throw new HttpError(404, `Project ${req.query.projectId} not found.`);
    const lastRun = listRuns(project.id).sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))[0];
    context = {
      project: project.name,
      kind: project.spec.projectKind || 'migration',
      source: project.spec.sourceStack || null,
      target: project.spec.targetStack || null,
      requirements: project.spec.requirements || '',
      constraints: project.spec.constraints || '',
      discovery: project.discovery
        ? {
            summary: project.discovery.summary,
            risks: project.discovery.risks.map((r) => `${r.severity}: ${r.label}`),
            gaps: project.discovery.gaps.map((g) => g.capability),
          }
        : null,
      lastRun: lastRun ? { id: lastRun.id, verdict: lastRun.validation?.verdict || lastRun.status, approval: lastRun.approval?.state || null } : null,
    };
  }

  res.json({
    agent: { id: agent.id, name: agent.name, title: agent.title, icon: agent.icon, overrides: agent.overrides },
    system,
    facts: facts.map(({ entry, kind, files, missing }) => ({ entry, kind, files, missing: Boolean(missing) })),
    menu: agent.persona.menu,
    context,
  });
});

export default router;
