import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Empty, Stat } from '../lib/ui.jsx';
import Graph from '../components/Graph.jsx';

export default function WorkflowStage({ project, reload, navigate, toast }) {
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const graph = project.graph;
  const agents = project.proposals?.agents || [];
  const guardrails = project.proposals?.guardrails || [];
  const accepted = agents.filter((a) => a.decision === 'accepted');
  const acceptedGuardrails = guardrails.filter((g) => g.decision === 'accepted');
  const awaiting = [...agents, ...guardrails].filter((p) => p.decision === 'proposed' && !p.authorRequired);
  const planFirst = project.spec?.projectKind === 'build';

  async function compose() {
    setBusy(true);
    try {
      await api.compose(project.id);
      await reload();
      toast('Workflow composed.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    try {
      await api.startRun(project.id);
      await reload();
      navigate('run');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  /** The one approval: everything still proposed is accepted, composed and run. */
  async function approvePlan() {
    setBusy(true);
    try {
      const { runId } = await api.approvePlan(project.id);
      await reload();
      toast(`Plan approved — ${runId} is running.`, 'ok');
      navigate('run');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  const proposedPlan =
    awaiting.length > 0 ? (
      <ProposedPlan
        agents={agents}
        guardrails={guardrails}
        planFirst={planFirst}
        busy={busy}
        onApprove={approvePlan}
        onReview={() => navigate('agents')}
        onSettings={() => { window.location.hash = '#/settings'; }}
      />
    ) : null;

  if (!accepted.length) {
    return (
      proposedPlan || (
        <Card title="Workflow composer">
          <Empty icon="⌗" title="No agents accepted yet">
            <button className="btn primary" style={{ marginTop: 10 }} onClick={() => navigate('agents')}>Review agent proposals →</button>
          </Empty>
        </Card>
      )
    );
  }

  const node = graph?.nodes?.find((n) => n.nodeId === selected);

  return (
    <>
      {proposedPlan}

      <div className="grid cols-4" style={{ marginBottom: 14, marginTop: proposedPlan ? 14 : 0 }}>
        <Stat label="Agents in graph" value={accepted.length} tone="accent" />
        <Stat label="Layers" value={graph?.layers?.length ?? '—'} sub="Derived from capability phases" />
        <Stat label="Edges" value={graph?.edges?.length ?? '—'} sub="Dependencies, not hand-written" />
        <Stat label="Guardrails armed" value={acceptedGuardrails.length} tone={acceptedGuardrails.length ? 'pass' : 'warn'} />
      </div>

      <Card
        title="Composed workflow"
        sub="Built from the accepted agents. Change an acceptance and this rebuilds — the graph is never hand-maintained."
        right={
          <div className="row">
            <button className="btn sm" disabled={busy} onClick={compose}>{graph ? '↻ Recompose' : 'Compose'}</button>
            <button className="btn sm primary" disabled={busy || !graph?.order?.length} onClick={start}>▶ Run</button>
          </div>
        }
        tight
      >
        {!graph ? (
          <Empty icon="⌗" title="Not composed yet">
            <button className="btn primary" style={{ marginTop: 10 }} disabled={busy} onClick={compose}>Compose workflow</button>
          </Empty>
        ) : (
          <>
            {graph.errors?.length > 0 && (
              <div style={{ padding: '11px 15px', borderBottom: '1px solid var(--line-soft)' }}>
                {graph.errors.map((error, index) => (
                  <div key={index} className="row small" style={{ color: 'var(--warn)' }}>▲ {error}</div>
                ))}
              </div>
            )}
            <Graph graph={graph} selected={selected} onSelect={(nodeId) => setSelected(nodeId === selected ? null : nodeId)} />
          </>
        )}
      </Card>

      {node && (
        <Card title={node.name} sub={node.capability} right={<Badge tone={node.source === 'reuse' ? 'pass' : 'warn'}>{node.source}</Badge>}>
          <div className="kv">
            <div className="k">Node</div><div className="v mono">{node.nodeId}</div>
            <div className="k">Agent id</div><div className="v mono">{node.agentId}</div>
            <div className="k">Implementation</div><div className="v mono">{node.impl}</div>
            <div className="k">Phase</div><div className="v mono">{node.phase} · {node.group}</div>
            <div className="k">Inputs</div><div className="v mono">{(node.inputs || []).join(', ') || '—'}</div>
            <div className="k">Outputs</div><div className="v mono">{(node.outputs || []).join(', ') || '—'}</div>
            <div className="k">Depends on</div>
            <div className="v mono">
              {graph.edges.filter((e) => e.to === node.nodeId).map((e) => graph.nodes.find((n) => n.nodeId === e.from)?.name).join(', ') || 'nothing — it starts the run'}
            </div>
          </div>
        </Card>
      )}

      {graph?.order?.length > 0 && (
        <Card title="Execution order" sub="Topological order the orchestrator will follow." tight>
          <table className="table">
            <thead><tr><th style={{ width: 50 }}>#</th><th>Agent</th><th>Capability</th><th>Source</th><th>Implementation</th></tr></thead>
            <tbody>
              {graph.order.map((nodeId, index) => {
                const row = graph.nodes.find((n) => n.nodeId === nodeId);
                return (
                  <tr key={nodeId}>
                    <td className="mono">{index + 1}</td>
                    <td>{row.name}</td>
                    <td className="mono">{row.capability}</td>
                    <td><Badge tone={row.source === 'reuse' ? 'pass' : row.source === 'generated' ? 'warn' : 'accent'}>{row.source}</Badge></td>
                    <td className="mono tiny">{row.impl}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

/**
 * What ASDD proposes, laid out as the structure it will follow: each step, who does it, what it
 * writes, and the guardrails that check it. One button approves it all and starts the run.
 */
function ProposedPlan({ agents, guardrails, planFirst, busy, onApprove, onReview, onSettings }) {
  const [engine, setEngine] = useState(null);
  useEffect(() => {
    api.health().then((health) => setEngine(health.llm)).catch(() => {});
  }, []);
  // Steps that need thinking only really run with a model; say so before the click, not after.
  const needsModel = agents.some((a) => ['instructionAgent', 'bmadPersonaAgent'].includes(a.impl) && a.decision !== 'rejected');
  const noModel = needsModel && engine && !['llm', 'assistant'].includes(engine.mode);
  const steps = agents.filter((a) => a.decision !== 'rejected' && !a.authorRequired).sort((a, b) => a.phase - b.phase);
  const checks = guardrails.filter((g) => g.decision !== 'rejected');
  const on = (agent) => checks.filter((g) => g.appliesTo && g.appliesTo !== 'workflow' && g.appliesTo === agent.agentId);
  const everywhere = checks.filter((g) => !g.appliesTo || g.appliesTo === 'workflow');

  return (
    <Card
      title={planFirst ? 'The proposed plan' : 'The proposed workflow'}
      sub="ASDD proposes the steps, who does each, and the guardrails that hold every step to the one before it. Approve it once and it runs by itself — it stops only when a guardrail set to stop fails, when a step is waiting for your coding assistant, and at the end for your approval."
      right={<Badge tone="warn">awaiting your approval</Badge>}
      tight
    >
      <table className="table">
        <thead>
          <tr><th style={{ width: 40 }}>#</th><th>Step</th><th>Who does it</th><th>Writes</th><th>Checked by</th></tr>
        </thead>
        <tbody>
          {steps.map((agent, index) => (
            <tr key={agent.proposalId}>
              <td className="mono">{index + 1}</td>
              <td>{agent.group}</td>
              <td>
                {agent.icon ? `${agent.icon} ` : ''}
                {agent.name}
                {agent.decision !== 'proposed' && <span className="tiny faint"> · {agent.decision}</span>}
              </td>
              <td className="tiny mono">{(agent.outputs || []).join(', ') || '—'}</td>
              <td className="small">
                {on(agent).map((g) => `${g.name}${g.onFailure === 'stop' ? ' (stops the run)' : ''}`).join(' · ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {everywhere.length > 0 && (
        <div className="small" style={{ padding: '10px 15px', borderTop: '1px solid var(--line-soft)' }}>
          <b>Across the whole workflow:</b> {everywhere.map((g) => g.name).join(' · ')}
        </div>
      )}
      {noModel && (
        <div className="small" style={{ padding: '10px 15px', borderTop: '1px solid var(--line-soft)', color: 'var(--warn)' }}>
          ▲ No model is connected, so the steps above would only write their briefs, not do the work. Connect Copilot (open this project in VS
          Code and use the ASDD skills) or add an API key in <button className="btn sm" onClick={onSettings}>Settings</button> first.
        </div>
      )}
      <div className="row" style={{ padding: '12px 15px', borderTop: '1px solid var(--line-soft)' }}>
        <button className="btn primary" disabled={busy} onClick={onApprove}>✓ Approve this plan and run</button>
        <button className="btn" disabled={busy} onClick={onReview}>Change something first →</button>
      </div>
    </Card>
  );
}
