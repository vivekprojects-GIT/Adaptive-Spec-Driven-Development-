import { Router } from 'express';
import { listAgents, addAgent, removeAgent } from '../registry/agents.js';
import { listGuardrails, addGuardrail, removeGuardrail } from '../registry/guardrails.js';
import { AGENT_IMPLS, INPUT_SOURCES } from '../engine/agents.js';
import { AVAILABLE_CHECKS } from '../engine/validator.js';
import { TECHNOLOGIES } from '../registry/technologies.js';
import { CAPABILITY_CATALOG } from '../engine/discovery.js';
import { ON_FAILURE_OPTIONS } from '../engine/guardrailDesigner.js';
import { HttpError } from '../lib/util.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({
    agents: listAgents(),
    guardrails: listGuardrails(),
    technologies: TECHNOLOGIES.map(({ codeSignals, ...rest }) => ({ ...rest, codeSignals: codeSignals.map(String) })),
    capabilityGroups: CAPABILITY_CATALOG,
    impls: Object.keys(AGENT_IMPLS),
    // The authoring forms are built from these, so the UI never drifts from what the engine accepts.
    inputSources: Object.entries(INPUT_SOURCES).map(([id, source]) => ({ id, label: source.label })),
    onFailureOptions: ON_FAILURE_OPTIONS,
    checks: AVAILABLE_CHECKS,
  });
});

router.get('/agents', (req, res) => res.json(listAgents()));

router.post('/agents', (req, res) => {
  const { id: agentId, name, capability } = req.body || {};
  if (!name || !capability) throw new HttpError(400, 'name and capability are required.');
  const agent = addAgent({
    id: agentId || `agent.user.${name.toLowerCase().replace(/\W+/g, '-')}`,
    name,
    capability,
    description: req.body.description || '',
    inputs: req.body.inputs || [],
    outputs: req.body.outputs || [],
    impl: req.body.impl || 'genericAdapter',
    tags: req.body.tags || ['user'],
    maturity: req.body.maturity || 'custom',
    source: 'user',
  });
  res.status(201).json(agent);
});

router.delete('/agents/:agentId', (req, res) => {
  removeAgent(req.params.agentId);
  res.json({ ok: true });
});

router.get('/guardrails', (req, res) => res.json(listGuardrails()));

router.post('/guardrails', (req, res) => {
  const { id: guardrailId, name, risks } = req.body || {};
  if (!name) throw new HttpError(400, 'name is required.');
  const guardrail = addGuardrail({
    id: guardrailId || `guard.user.${name.toLowerCase().replace(/\W+/g, '-')}`,
    name,
    risks: risks || ['risk.custom'],
    severity: req.body.severity || 'major',
    description: req.body.description || '',
    check: req.body.check || 'manualSignOff',
    params: req.body.params || {},
    source: 'user',
  });
  res.status(201).json(guardrail);
});

router.delete('/guardrails/:guardrailId', (req, res) => {
  removeGuardrail(req.params.guardrailId);
  res.json({ ok: true });
});

export default router;
