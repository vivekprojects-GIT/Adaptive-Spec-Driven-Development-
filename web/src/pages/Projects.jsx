import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Modal, Field, Empty, useToast, relTime, Bar } from '../lib/ui.jsx';

const STAGE_LABEL = {
  spec: 'Spec',
  interview: 'Interview',
  discovery: 'Discovery',
  agents: 'Agent review',
  guardrails: 'Guardrail review',
  workflow: 'Workflow',
  run: 'Run',
};

export default function Projects({ projects, onChanged, navigate }) {
  const [samples, setSamples] = useState([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);
  const toast = useToast();

  useEffect(() => {
    api.samples().then(setSamples).catch(() => setSamples([]));
  }, []);

  async function createFromSample(sampleId) {
    setBusy(sampleId);
    try {
      const sample = await api.sample(sampleId);
      const project = await api.createProject({ name: sample.name, description: sample.description, spec: sample.spec });
      await onChanged();
      toast(`Created "${project.name}" with ${sample.spec.artifacts.length} artifact(s).`, 'ok');
      navigate(`/projects/${project.id}/spec`);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Projects</b></div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>+ New project</button>
      </div>

      <div className="page">
        <Card
          title="Your projects"
          sub="Each project holds one spec, its approved agent graph, and every run it has produced."
          right={<Badge mono>{projects.length}</Badge>}
          tight
        >
          {projects.length === 0 ? (
            <Empty icon="▤" title="No projects yet">
              <div className="small">Start from a sample below — each one is a real, parseable suite.</div>
            </Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Migration</th>
                  <th>Stage</th>
                  <th style={{ width: 150 }}>Readiness</th>
                  <th>Runs</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${project.id}/spec`)}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{project.name}</div>
                      <div className="tiny faint mono">{project.id}</div>
                    </td>
                    <td className="small">
                      <div>{project.source || <span className="faint">source not set</span>}</div>
                      <div className="faint">→ {project.target || 'target not set'}</div>
                    </td>
                    <td><Badge tone={project.stage === 'run' ? 'pass' : 'info'}>{STAGE_LABEL[project.stage] || project.stage}</Badge></td>
                    <td>
                      <Bar value={project.readiness} tone={project.readiness >= 70 ? 'pass' : project.readiness > 0 ? 'warn' : ''} />
                      <div className="tiny faint mono" style={{ marginTop: 3 }}>{project.readiness}%</div>
                    </td>
                    <td className="mono">{project.runs}</td>
                    <td className="tiny faint">{relTime(project.updatedAt)}</td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <button
                        className="btn ghost sm"
                        onClick={async () => {
                          if (!window.confirm(`Delete "${project.name}" and all of its runs?`)) return;
                          await api.deleteProject(project.id);
                          await onChanged();
                          toast('Project deleted.', 'ok');
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title="Start from a sample"
          sub="Real source files, not lorem ipsum. Each one exercises a different path through the control plane."
        >
          <div className="grid cols-2">
            {samples.map((sample) => (
              <div key={sample.id} className="proposal">
                <div className="proposal-head">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
                      <strong style={{ fontSize: 13.5 }}>{sample.name}</strong>
                      {sample.id === 'gap-demo' && <Badge tone="warn">honest failure</Badge>}
                    </div>
                    <div className="small muted">{sample.headline}</div>
                  </div>
                </div>
                <div className="proposal-body">
                  <div className="chip-row">
                    <Badge mono>{sample.artifacts} artifact(s)</Badge>
                    <Badge mono>{sample.requirements} requirement(s)</Badge>
                  </div>
                </div>
                <div className="proposal-actions">
                  <button className="btn sm primary" disabled={busy === sample.id} onClick={() => createFromSample(sample.id)}>
                    {busy === sample.id ? 'Creating…' : 'Create project'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={async (project) => {
            setCreating(false);
            await onChanged();
            navigate(`/projects/${project.id}/spec`);
          }}
        />
      )}
    </>
  );
}

function NewProjectModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceStack, setSourceStack] = useState('');
  const [targetStack, setTargetStack] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit() {
    if (!name.trim()) return toast('A project name is required.', 'err');
    setBusy(true);
    try {
      const project = await api.createProject({ name, description, spec: { sourceStack, targetStack } });
      onCreated(project);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create'}</button>
        </>
      }
    >
      <Field label="Project name">
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Regression suite migration" autoFocus />
      </Field>
      <Field label="Description" hint="Optional. What is this migration for?">
        <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid cols-2">
        <Field label="Source stack" hint="e.g. Selenium WebDriver (Java)">
          <input type="text" value={sourceStack} onChange={(e) => setSourceStack(e.target.value)} />
        </Field>
        <Field label="Target stack" hint="e.g. Playwright (TypeScript)">
          <input type="text" value={targetStack} onChange={(e) => setTargetStack(e.target.value)} />
        </Field>
      </div>
      <div className="small faint">You can leave the stacks blank — the interview will ask for anything missing.</div>
    </Modal>
  );
}
