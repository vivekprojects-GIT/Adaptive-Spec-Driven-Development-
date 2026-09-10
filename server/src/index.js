import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import projectsRouter from './routes/projects.js';
import runsRouter from './routes/runs.js';
import registryRouter from './routes/registry.js';
import settingsRouter from './routes/settings.js';
import observabilityRouter from './routes/observability.js';
import approvalsRouter from './routes/approvals.js';
import bridgeRouter from './routes/bridge.js';
import bmadRouter from './routes/bmad.js';
import { bridgeToken } from './lib/bridge.js';
import { loadBmad } from './bmad/loader.js';
import { TEMPLATES, findTemplate, starterSpec, exampleSpec } from './templates.js';
import { ensureSeeded as seedAgents } from './registry/agents.js';
import { ensureSeeded as seedGuardrails } from './registry/guardrails.js';
import { llmStatus, getSettings } from './lib/settings.js';
import { HttpError } from './lib/util.js';
import { logger } from './lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5174;
// Loopback only by default: the API and the model bridge are for this machine. HOST=0.0.0.0 to share it.
const HOST = process.env.HOST || '127.0.0.1';

seedAgents();
seedGuardrails();

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Every API call is logged, so the dashboard can always show the last thing that happened.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') || req.path === '/api/logs' || req.path === '/api/dashboard' || req.path === '/api/approvals' || req.path.startsWith('/api/llm-bridge/')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    logger[level]('api', `${req.method} ${req.originalUrl.split('?')[0]} → ${res.statusCode} (${ms}ms)`, {
      projectId: req.params?.id || req.body?.projectId || null,
      status: res.statusCode,
      ms,
    });
  });
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'asdd-control-plane', version: '1.0.0', llm: llmStatus() });
});

/**
 * Templates are starting shapes, not ready-made runs: they set the stacks and say what you need to
 * provide. The example content is a separate, explicit request.
 */
app.get('/api/templates', (req, res) => {
  res.json(
    TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      headline: template.headline,
      source: template.starter.sourceStack,
      target: template.starter.targetStack,
      projectKind: template.starter.projectKind,
      expects: template.expects,
      requirementHints: template.requirementHints,
      hasExample: Boolean(template.example),
    })),
  );
});

app.get('/api/templates/:templateId', (req, res) => {
  const template = findTemplate(req.params.templateId);
  if (!template) throw new HttpError(404, 'Template not found.');
  const example = exampleSpec(template.id);
  res.json({
    id: template.id,
    name: template.name,
    headline: template.headline,
    expects: template.expects,
    requirementHints: template.requirementHints,
    starterSpec: starterSpec(template.id),
    example: example ? { ...example, artifacts: example.artifacts.map((a) => ({ ...a })) } : null,
  });
});

app.use('/api/projects', projectsRouter);
app.use('/api/runs', runsRouter);
app.use('/api/registry', registryRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/approvals', approvalsRouter);
app.use('/api/llm-bridge', bridgeRouter);
app.use('/api/bmad', bmadRouter);
app.use('/api', observabilityRouter);

// Production: serve the built UI from the same origin so `npm start` is a single process.
const dist = path.resolve(here, '../../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Errors are returned as JSON the UI can render, never swallowed.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  logger[status >= 500 ? 'error' : 'warn']('api', `${req.method} ${req.originalUrl.split('?')[0]} failed: ${err.message}`, {
    status,
    details: err.details || null,
    stack: status >= 500 ? String(err.stack || '').split('\n').slice(0, 4).join(' | ') : undefined,
  });
  res.status(status).json({ error: err.message || 'Internal error', details: err.details || null });
});

// Written before listening, so an MCP server started at the same moment finds it.
bridgeToken();
const bmadAtStart = loadBmad({ root: getSettings().bmadRoot || undefined });

app.listen(PORT, HOST, () => {
  console.log(
    bmadAtStart.found
      ? `\n  BMAD: ${bmadAtStart.agents.length} agents, ${bmadAtStart.workflows.length} workflows (v${bmadAtStart.version}) from ${bmadAtStart.root}`
      : '\n  BMAD: no install found — set its folder in Settings, or ASDD_BMAD_ROOT',
  );
  const status = llmStatus();
  console.log(`\n  ASDD control plane  →  http://${HOST}:${PORT}`);
  console.log(`  LLM assist: ${status.mode} — ${status.detail}`);
  console.log(fs.existsSync(dist) ? '  Serving the built UI from web/dist\n' : '  UI runs separately on http://localhost:5173 (npm run dev)\n');
});
