import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Badge, useToast, Spinner } from '../lib/ui.jsx';
import SpecStage from '../stages/Spec.jsx';
import InterviewStage from '../stages/Interview.jsx';
import DiscoveryStage from '../stages/Discovery.jsx';
import ProposalsStage from '../stages/Proposals.jsx';
import WorkflowStage from '../stages/Workflow.jsx';
import RunStage from '../stages/Run.jsx';
import TraceStage from '../stages/Trace.jsx';
import ReportStage from '../stages/Report.jsx';

const STEPS = [
  { key: 'spec', label: 'Spec', done: (p) => (p.spec?.artifacts?.length || 0) > 0 || Boolean(p.spec?.sourceStack) },
  { key: 'interview', label: 'Interview', done: (p) => Boolean(p.interview?.ready) },
  { key: 'discovery', label: 'Discovery', done: (p) => Boolean(p.discovery) },
  { key: 'agents', label: 'Agents', done: (p) => (p.proposals?.agents || []).some((a) => a.decision === 'accepted') },
  { key: 'guardrails', label: 'Guardrails', done: (p) => (p.proposals?.guardrails || []).some((g) => g.decision === 'accepted') },
  { key: 'workflow', label: 'Workflow', done: (p) => Boolean(p.graph?.order?.length) },
  { key: 'run', label: 'Run', done: (p) => (p.runs || []).length > 0 },
  { key: 'trace', label: 'Trace', done: (p) => (p.runs || []).some((r) => r.status?.startsWith('completed')) },
  { key: 'report', label: 'Report', done: (p) => (p.runs || []).some((r) => r.verdict) },
];

export default function Workspace({ projectId, tab, navigate, onChanged, projectName }) {
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const toast = useToast();

  const reload = useCallback(async () => {
    try {
      const next = await api.project(projectId);
      setProject(next);
      setError(null);
      onChanged?.();
      return next;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [projectId, onChanged]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (error) {
    return (
      <div className="page">
        <div className="card"><div className="card-body">
          <strong>Could not load this project.</strong>
          <div className="small muted" style={{ marginTop: 6 }}>{error}</div>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => navigate('/projects')}>Back to projects</button>
        </div></div>
      </div>
    );
  }

  if (!project) {
    return <div className="page"><div className="row"><Spinner /> <span className="muted">Loading {projectName || 'project'}…</span></div></div>;
  }

  const go = (key) => navigate(`/projects/${projectId}/${key}`);
  const shared = { project, reload, navigate: go, toast };

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <span style={{ cursor: 'pointer' }} onClick={() => navigate('/projects')}>Projects</span> / <b>{project.name}</b>
        </div>
        <div className="spacer" />
        {project.spec?.sourceStack && (
          <Badge mono>
            {project.discovery?.source?.label || project.spec.sourceStack} → {project.discovery?.target?.label || project.spec.targetStack || '?'}
          </Badge>
        )}
        {project.interview && (
          <Badge tone={project.interview.ready ? 'pass' : 'warn'}>
            {project.interview.ready ? 'Requirements ready' : `${project.interview.blockingCount} question(s) open`}
          </Badge>
        )}
      </div>

      <div className="stepper">
        {STEPS.map((step, index) => (
          <div
            key={step.key}
            className={`step ${tab === step.key ? 'active' : ''} ${step.done(project) ? 'done' : ''}`}
            onClick={() => go(step.key)}
          >
            <span className="num">{step.done(project) ? '✓' : index + 1}</span>
            {step.label}
          </div>
        ))}
      </div>

      <div className="page wide">
        {tab === 'spec' && <SpecStage {...shared} />}
        {tab === 'interview' && <InterviewStage {...shared} />}
        {tab === 'discovery' && <DiscoveryStage {...shared} />}
        {tab === 'agents' && <ProposalsStage {...shared} kind="agents" />}
        {tab === 'guardrails' && <ProposalsStage {...shared} kind="guardrails" />}
        {tab === 'workflow' && <WorkflowStage {...shared} />}
        {tab === 'run' && <RunStage {...shared} />}
        {tab === 'trace' && <TraceStage {...shared} />}
        {tab === 'report' && <ReportStage {...shared} />}
      </div>
    </>
  );
}
