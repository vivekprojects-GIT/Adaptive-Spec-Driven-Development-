import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Modal, Field, Empty, useToast, relTime, Bar, Dot } from '../lib/ui.jsx';

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
  const [templates, setTemplates] = useState([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);
  const [waiting, setWaiting] = useState({});
  const toast = useToast();

  useEffect(() => {
    api.templates().then(setTemplates).catch(() => setTemplates([]));
    api.approvals().then((data) => setWaiting(data.byProject || {})).catch(() => {});
  }, []);

  /**
   * A template sets the stacks and lands you on the Spec step to add YOUR files and requirements.
   * `withExample` is the separate, explicitly-labelled demo path.
   */
  async function createFromTemplate(templateId, withExample = false) {
    setBusy(`${templateId}${withExample ? ':example' : ''}`);
    try {
      const template = await api.template(templateId);
      const spec = withExample ? template.example : template.starterSpec;
      const project = await api.createProject({ name: template.name, description: template.headline, spec });
      await onChanged();
      toast(
        withExample
          ? `Created "${project.name}" loaded with demo content.`
          : `Created "${project.name}". Add your files and requirements on the Spec step.`,
        'ok',
      );
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
                  <th>Waiting on you</th>
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
                    <td>
                      {waiting[project.id] ? (
                        <span className="row" style={{ gap: 6 }}>
                          <Dot tone="warn" pulse />
                          <Badge tone="warn">{waiting[project.id]}</Badge>
                        </span>
                      ) : (
                        <span className="faint tiny">—</span>
                      )}
                    </td>
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
          title="Start from a template"
          sub="A template sets the stacks and tells you what to provide. It brings no content of its own — you add your files and your requirements, and nothing runs until you do."
        >
          <div className="grid cols-2">
            {templates.map((template) => (
              <div key={template.id} className="proposal">
                <div className="proposal-head">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
                      <strong style={{ fontSize: 13.5 }}>{template.name}</strong>
                      {template.projectKind === 'custom' && <Badge tone="accent">you author the agents</Badge>}
                      {template.id === 'gap-demo' && <Badge tone="warn">honest failure</Badge>}
                    </div>
                    <div className="small muted">{template.headline}</div>
                  </div>
                </div>
                <div className="proposal-body">
                  <div className="tiny faint" style={{ letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 5 }}>
                    You provide
                  </div>
                  <ul className="small muted" style={{ margin: 0, paddingLeft: 17 }}>
                    {(template.expects || []).map((item, index) => <li key={index}>{item}</li>)}
                  </ul>
                </div>
                <div className="proposal-actions">
                  <button
                    className="btn sm primary"
                    disabled={busy?.startsWith(template.id)}
                    onClick={() => createFromTemplate(template.id, false)}
                  >
                    {busy === template.id ? 'Creating…' : 'Use this template'}
                  </button>
                  {template.hasExample && (
                    <button
                      className="btn sm"
                      disabled={busy?.startsWith(template.id)}
                      title="Loads sample source files so you can watch the pipeline run before using your own"
                      onClick={() => createFromTemplate(template.id, true)}
                    >
                      {busy === `${template.id}:example` ? 'Loading…' : 'Load demo content'}
                    </button>
                  )}
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
