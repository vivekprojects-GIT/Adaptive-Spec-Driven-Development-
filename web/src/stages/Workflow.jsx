import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Empty, Stat } from '../lib/ui.jsx';
import Graph from '../components/Graph.jsx';

export default function WorkflowStage({ project, reload, navigate, toast }) {
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const graph = project.graph;
  const accepted = (project.proposals?.agents || []).filter((a) => a.decision === 'accepted');
  const acceptedGuardrails = (project.proposals?.guardrails || []).filter((g) => g.decision === 'accepted');

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

  if (!accepted.length) {
    return (
      <Card title="Workflow composer">
        <Empty icon="⌗" title="No agents accepted yet">
          <button className="btn primary" style={{ marginTop: 10 }} onClick={() => navigate('agents')}>Review agent proposals →</button>
        </Empty>
      </Card>
    );
  }

  const node = graph?.nodes?.find((n) => n.nodeId === selected);

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
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
            <button className="btn sm primary" disabled={busy || !graph?.order?.length} onClick={start}>▶ Run migration</button>
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
