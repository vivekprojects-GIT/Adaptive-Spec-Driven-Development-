import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import projectsRouter from './routes/projects.js';
import runsRouter from './routes/runs.js';
import registryRouter from './routes/registry.js';
import settingsRouter from './routes/settings.js';
import { SAMPLES, findSample } from './samples.js';
import { ensureSeeded as seedAgents } from './registry/agents.js';
import { ensureSeeded as seedGuardrails } from './registry/guardrails.js';
import { llmStatus } from './lib/settings.js';
import { HttpError } from './lib/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5174;

seedAgents();
seedGuardrails();

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'asdd-control-plane', version: '1.0.0', llm: llmStatus() });
});

app.get('/api/samples', (req, res) => {
  res.json(
    SAMPLES.map((sample) => ({
      id: sample.id,
      name: sample.name,
      headline: sample.headline,
      description: sample.description,
      source: sample.spec.sourceStack,
      target: sample.spec.targetStack,
      artifacts: sample.spec.artifacts.length,
      requirements: sample.spec.requirements.split('\n').filter(Boolean).length,
    })),
  );
});

app.get('/api/samples/:sampleId', (req, res) => {
  const sample = findSample(req.params.sampleId);
  if (!sample) throw new HttpError(404, 'Sample not found.');
  res.json(sample);
});

app.use('/api/projects', projectsRouter);
app.use('/api/runs', runsRouter);
app.use('/api/registry', registryRouter);
app.use('/api/settings', settingsRouter);

// Production: serve the built UI from the same origin so `npm start` is a single process.
const dist = path.resolve(here, '../../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Errors are returned as JSON the UI can render, never swallowed.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal error', details: err.details || null });
});

app.listen(PORT, () => {
  const status = llmStatus();
  console.log(`\n  ASDD control plane  →  http://localhost:${PORT}`);
  console.log(`  LLM assist: ${status.mode} — ${status.detail}`);
  console.log(fs.existsSync(dist) ? '  Serving the built UI from web/dist\n' : '  UI runs separately on http://localhost:5173 (npm run dev)\n');
});
