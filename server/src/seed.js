/**
 * `npm run seed` — creates the flagship sample project so a fresh clone has something to open.
 * Safe to run repeatedly: it skips a project whose name already exists.
 */
import { collection } from './lib/store.js';
import { SAMPLES } from './samples.js';
import { ensureSeeded as seedAgents } from './registry/agents.js';
import { ensureSeeded as seedGuardrails } from './registry/guardrails.js';
import { id, now } from './lib/util.js';

seedAgents();
seedGuardrails();

const projects = collection('projects');
const sample = SAMPLES[0];

if (projects.all().some((p) => p.name === sample.name)) {
  console.log(`Sample project "${sample.name}" already exists — nothing to do.`);
} else {
  const project = {
    id: id('prj'),
    name: sample.name,
    description: sample.description,
    stage: 'spec',
    createdAt: now(),
    updatedAt: now(),
    spec: {
      ...sample.spec,
      clarifications: {},
      artifacts: sample.spec.artifacts.map((file) => ({
        id: id('src'),
        path: file.path,
        content: file.content,
        bytes: Buffer.byteLength(file.content, 'utf8'),
        addedAt: now(),
      })),
    },
    interview: null,
    discovery: null,
    proposals: { agents: [], guardrails: [] },
    graph: null,
    trail: [{ id: id('ev'), at: now(), actor: 'seed', stage: 'spec', action: 'project.created', detail: 'Seeded from the built-in sample.' }],
  };
  projects.insert(project);
  console.log(`Seeded project "${project.name}" (${project.id}) with ${project.spec.artifacts.length} artifact(s).`);
}

seedAgents();
console.log('Registries ready.');
