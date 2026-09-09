import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Stat, Empty, toneForSeverity } from '../lib/ui.jsx';

export default function DiscoveryStage({ project, reload, navigate, toast }) {
  const [busy, setBusy] = useState(false);
  const discovery = project.discovery;

  async function discover(force) {
    setBusy(true);
    try {
      await api.discover(project.id, force);
      await reload();
      toast('Discovery complete — agents and guardrails proposed.', 'ok');
      navigate('agents');
    } catch (err) {
      if (err.status === 409) {
        toast(`${err.message}`, 'err');
      } else {
        toast(err.message, 'err');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!discovery) {
    return (
      <Card title="Project discovery" sub="Reads the spec and works out what is actually being migrated.">
        <Empty icon="⌕" title="Discovery has not run for this spec yet">
          <div className="small" style={{ maxWidth: 520, margin: '0 auto 14px' }}>
            Discovery classifies the source and target, parses the artifacts into a neutral model, then
            emits the <b>capabilities</b> the migration needs and the <b>risks</b> it carries. It never
            names an agent — that is the factory's job.
          </div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn primary" disabled={busy} onClick={() => discover(false)}>{busy ? 'Running…' : 'Run discovery'}</button>
            {project.interview && !project.interview.ready && (
              <button className="btn" disabled={busy} onClick={() => discover(true)} title="Discovery normally waits for the interview to be answered.">
                Force anyway
              </button>
            )}
          </div>
        </Empty>
      </Card>
    );
  }

  const e = discovery.entities;

  return (
    <>
      <Card
        title="Discovery report"
        sub={`${discovery.migrationKind} · run ${new Date(discovery.createdAt).toLocaleString()}`}
        right={
          <div className="row">
            <button className="btn sm" disabled={busy} onClick={() => discover(true)}>↻ Re-run</button>
            <button className="btn sm primary" onClick={() => navigate('agents')}>Review agents →</button>
          </div>
        }
      >
        <div className="grid cols-2" style={{ marginBottom: 14 }}>
          <Profile title="Source" profile={discovery.source} />
          <Profile title="Target" profile={discovery.target} />
        </div>
        <div className="proposal-why">{discovery.summary}</div>
      </Card>

      <div className="grid cols-4" style={{ margin: '14px 0' }}>
        <Stat label="Suites" value={e.suites} sub={`${e.artifacts} artifact(s) read`} />
        <Stat label="Test cases" value={e.tests} tone="accent" sub={`${e.steps} steps parsed`} />
        <Stat label="Assertions" value={e.assertions} sub="Each one must survive" />
        <Stat label="Locators" value={e.locators} sub={`${e.requests} API request(s)`} />
      </div>

      <div className="grid cols-2">
        <Card title="Capabilities required" sub="The join between what the project needs and what the registry provides." right={<Badge mono>{discovery.capabilities.length}</Badge>} tight>
          <table className="table">
            <thead><tr><th>Capability</th><th>Phase</th><th>Why</th></tr></thead>
            <tbody>
              {discovery.capabilities.map((capability) => (
                <tr key={capability.id}>
                  <td className="mono">{capability.id}<div className="tiny faint">{capability.group}</div></td>
                  <td className="mono">{capability.phase}</td>
                  <td className="small muted">{capability.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Risks identified" sub="These drive the guardrail proposals — nothing else does." right={<Badge mono>{discovery.risks.length}</Badge>}>
          {discovery.risks.map((risk) => (
            <div key={risk.id} className="risk">
              <Badge tone={toneForSeverity(risk.severity)}>{risk.severity}</Badge>
              <div className="body">
                <div style={{ fontWeight: 550 }}>{risk.label}</div>
                <div className="small muted">{risk.why}</div>
                {risk.evidence && <div className="tiny faint mono break" style={{ marginTop: 3 }}>evidence: {risk.evidence}</div>}
              </div>
            </div>
          ))}
        </Card>
      </div>

      {discovery.gaps?.length > 0 && (
        <Card title="Capability gaps" sub="What the platform cannot do yet. It says so rather than pretending." right={<Badge tone="fail">{discovery.gaps.length}</Badge>}>
          {discovery.gaps.map((gap) => (
            <div key={gap.capability} className="risk">
              <Badge tone="fail">gap</Badge>
              <div className="body">
                <div className="mono" style={{ fontWeight: 550 }}>{gap.capability}</div>
                <div className="small muted">{gap.reason}</div>
                <div className="small" style={{ color: 'var(--warn)', marginTop: 3 }}>Needs: {gap.needs}</div>
              </div>
            </div>
          ))}
        </Card>
      )}

      {discovery.sourceModel?.unmapped?.length > 0 && (
        <Card title="Constructs with no target equivalent" sub="Surfaced now so they cannot be silently dropped later." tight>
          <table className="table">
            <thead><tr><th>Construct</th><th>File</th><th>Source line</th><th>Why</th></tr></thead>
            <tbody>
              {discovery.sourceModel.unmapped.map((item, index) => (
                <tr key={index}>
                  <td><Badge tone="warn">{item.construct}</Badge></td>
                  <td className="mono tiny">{item.file}</td>
                  <td className="mono tiny break" style={{ maxWidth: 320 }}>{item.raw}</td>
                  <td className="small muted">{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Parsed source model" sub="What the analyzers actually saw. If this looks wrong, the migration will be wrong." tight>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Suite</th><th>Test</th><th>Steps</th><th>Assertions</th><th>File</th></tr></thead>
            <tbody>
              {(discovery.sourceModel?.suites || []).flatMap((suite) =>
                suite.tests.map((test) => (
                  <tr key={test.id}>
                    <td>{suite.name}</td>
                    <td className="mono">{test.name}</td>
                    <td className="mono">{test.steps.length}</td>
                    <td className="mono">{test.assertions.length}</td>
                    <td className="tiny faint mono">{test.file}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function Profile({ title, profile }) {
  return (
    <div className="card" style={{ background: 'var(--bg-sunken)' }}>
      <div className="card-body">
        <div className="tiny faint" style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}>{title}</div>
        <div className="row" style={{ marginTop: 5 }}>
          <strong>{profile.label}</strong>
          <Badge tone={profile.confidence >= 0.6 ? 'pass' : profile.confidence > 0 ? 'warn' : 'fail'}>
            {Math.round((profile.confidence || 0) * 100)}% confident
          </Badge>
        </div>
        <div className="tiny faint mono" style={{ marginTop: 3 }}>{profile.id} · {profile.language} · {profile.kind}</div>
        {(profile.evidence || []).length > 0 && (
          <ul className="tiny muted" style={{ margin: '8px 0 0', paddingLeft: 16 }}>
            {profile.evidence.slice(0, 4).map((line, index) => <li key={index} className="break">{line}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
