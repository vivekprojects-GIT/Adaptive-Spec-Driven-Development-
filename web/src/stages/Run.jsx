import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamRun } from '../lib/api.js';
import { Card, Badge, Stat, Empty, Dot, Spinner, shortTime, toneForStatus, toneForVerdict, copyText } from '../lib/ui.jsx';
import Graph from '../components/Graph.jsx';

export default function RunStage({ project, reload, navigate, toast }) {
  const [runId, setRunId] = useState(project.runs?.[0]?.id || null);
  const [run, setRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState(null);
  const [approvalNote, setApprovalNote] = useState('');
  const consoleRef = useRef(null);

  const load = useCallback(async (targetId) => {
    if (!targetId) return;
    try {
      setRun(await api.run(targetId));
    } catch (err) {
      toast(err.message, 'err');
    }
  }, [toast]);

  useEffect(() => {
    if (!runId && project.runs?.length) setRunId(project.runs[0].id);
  }, [project.runs, runId]);

  useEffect(() => {
    if (!runId) return undefined;
    setEvents([]);
    load(runId);

    const stop = streamRun(runId, (event) => {
      if (event.type === 'stream:end') {
        load(runId);
        reload();
        return;
      }
      setEvents((list) => [...list, event]);
      if (event.type === 'run:end') {
        setTimeout(() => {
          load(runId);
          reload();
        }, 250);
      }
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [events]);

  async function start() {
    setBusy(true);
    try {
      const { runId: newId } = await api.startRun(project.id);
      await reload();
      setRunId(newId);
      toast('Run started.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  if (!project.graph?.order?.length) {
    return (
      <Card title="Run">
        <Empty icon="▶" title="Compose a workflow before running">
          <button className="btn primary" style={{ marginTop: 10 }} onClick={() => navigate('workflow')}>Go to the workflow →</button>
        </Empty>
      </Card>
    );
  }

  if (!project.runs?.length) {
    return (
      <Card title="Run">
        <Empty icon="▶" title="No runs yet">
          <div className="small" style={{ marginBottom: 12 }}>
            {project.graph.nodes.length} agent(s) and {(project.proposals?.guardrails || []).filter((g) => g.decision === 'accepted').length} guardrail(s) are armed.
          </div>
          <button className="btn primary" disabled={busy} onClick={start}>▶ Run migration</button>
        </Empty>
      </Card>
    );
  }

  const statuses = Object.fromEntries((run?.nodes || []).map((node) => [node.nodeId, node.status]));
  const live = run?.status === 'running' || run?.status === 'queued';
  const artifacts = run?.ws?.generated || [];
  const results = run?.validation?.results || [];
  const duration = run?.finishedAt ? Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 100) / 10 : null;

  return (
    <>
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <select style={{ width: 320 }} value={runId || ''} onChange={(e) => setRunId(e.target.value)}>
          {project.runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} · {r.status}{r.verdict ? ` · ${r.verdict}` : ''} · {new Date(r.startedAt).toLocaleString()}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button className="btn" disabled={busy || live} onClick={start}>▶ New run</button>
        {run?.report && <button className="btn primary" onClick={() => navigate('report')}>Report →</button>}
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Stat
          label="Status"
          value={live ? 'running' : run?.status || '—'}
          tone={live ? 'accent' : run?.status?.includes('error') ? 'fail' : 'pass'}
          sub={duration ? `${duration}s` : 'in progress'}
        />
        <Stat label="Verdict" value={run?.validation?.verdict || '—'} tone={toneForVerdict(run?.validation?.verdict)} sub={`${results.length} guardrail(s)`} />
        <Stat label="Artifacts" value={artifacts.length} tone="accent" sub={`${artifacts.reduce((sum, a) => sum + a.lines, 0)} lines generated`} />
        <Stat label="Model" value={run?.modelUsed ? 'LLM' : 'rules'} sub={run?.modelUsed || 'deterministic engine'} />
      </div>

      <Card
        title="Execution"
        sub="Each node lights up as it runs. Nothing here is a mock — the artifacts below are what the agents actually produced."
        right={live ? <div className="row"><Dot tone="info" pulse /> <span className="small">live</span></div> : <Badge tone={toneForStatus(run?.status)}>{run?.status}</Badge>}
        tight
      >
        <Graph graph={project.graph} statuses={statuses} />
      </Card>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Card title="Live console" sub={`${events.length} event(s)`} tight>
          <div className="console" ref={consoleRef}>
            {events.length === 0 && <div className="msg dim">Waiting for events…</div>}
            {events.map((event, index) => (
              <div className="ln" key={index}>
                <span className="ts">{shortTime(event.at)}</span>
                <span className={`msg ${consoleTone(event)}`}>{event.message || event.type}</span>
              </div>
            ))}
            {live && <div className="ln"><span className="ts">—</span><span className="msg dim">…</span></div>}
          </div>
        </Card>

        <Card title="Agents" sub="What each one did, and what it produced." tight>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Agent</th><th>Status</th><th>ms</th><th>Output</th></tr></thead>
              <tbody>
                {(run?.nodes || []).map((node) => (
                  <tr key={node.nodeId}>
                    <td>
                      <div>{node.name}</div>
                      <div className="tiny faint mono">{node.capability}</div>
                    </td>
                    <td><Badge tone={toneForStatus(node.status)}>{node.status}</Badge></td>
                    <td className="mono">{node.ms ?? '—'}</td>
                    <td className="tiny mono">
                      {(node.outputs || []).map((output) => <div key={output.id}>{output.path}</div>)}
                      {node.notes?.length > 0 && <div className="faint" style={{ marginTop: 3 }}>{node.notes.length} note(s)</div>}
                      {node.error && <div style={{ color: 'var(--fail)' }}>{node.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {run?.approval && (
        <Card
          title="Human approval"
          sub="The last gate. AI proposed the architecture; you own the decision on what it produced."
          right={
            <Badge tone={run.approval.state === 'approved' ? 'pass' : run.approval.state === 'pending' ? 'warn' : 'fail'}>
              {run.approval.state}
            </Badge>
          }
        >
          {run.approval.state === 'pending' ? (
            <>
              <div className="proposal-why" style={{ marginBottom: 12 }}>{run.approval.reason}</div>
              <textarea
                rows={2}
                placeholder="Optional note — what you checked, or what needs changing."
                value={approvalNote}
                onChange={(e) => setApprovalNote(e.target.value)}
              />
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="btn pass"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.approve(run.id, { state: 'approved', note: approvalNote });
                      await load(run.id);
                      await reload();
                      toast('Run approved.', 'ok');
                    } catch (err) {
                      toast(err.message, 'err');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  ✓ Approve this run
                </button>
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.approve(run.id, { state: 'changes-requested', note: approvalNote });
                      await load(run.id);
                      await reload();
                      toast('Changes requested.', 'ok');
                    } catch (err) {
                      toast(err.message, 'err');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  ↩ Request changes
                </button>
              </div>
            </>
          ) : (
            <div className="kv">
              <div className="k">Decision</div>
              <div className="v">{run.approval.state === 'approved' ? 'Approved' : 'Changes requested'}</div>
              <div className="k">By</div>
              <div className="v">{run.approval.by}</div>
              <div className="k">When</div>
              <div className="v">{new Date(run.approval.at).toLocaleString()}</div>
              {run.approval.note && (<><div className="k">Note</div><div className="v">{run.approval.note}</div></>)}
            </div>
          )}
        </Card>
      )}

      {results.length > 0 && (
        <Card
          title="Guardrail verdicts"
          sub="Each verdict is computed from the artifacts above. A check that could not be evaluated says warn, never pass."
          right={<Badge tone={toneForVerdict(run.validation.verdict)}>{run.validation.verdict}</Badge>}
          tight
        >
          <table className="table">
            <thead><tr><th style={{ width: 40 }} /><th>Guardrail</th><th>Severity</th><th>Evidence</th></tr></thead>
            <tbody>
              {results.map((result) => (
                <tr key={result.guardrailId}>
                  <td><Dot tone={toneForStatus(result.status)} /></td>
                  <td>
                    <div style={{ fontWeight: 550 }}>{result.name}</div>
                    <div className="tiny faint mono">{result.check}</div>
                  </td>
                  <td><Badge tone={result.severity === 'blocker' ? 'fail' : 'warn'}>{result.severity}</Badge></td>
                  <td className="small">{result.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {artifacts.length > 0 && (
        <Card
          title="Generated artifacts"
          sub="Real files. Copy them straight into the target repository."
          right={
            <div className="row">
              <a className="btn sm" href={api.bundleUrl(run.id)} download={`${run.id}-bundle.json`}>⬇ Download bundle</a>
            </div>
          }
          tight
        >
          <div className="split">
            <div className="left">
              {artifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  className={`file-item ${selectedArtifact?.id === artifact.id ? 'active' : ''}`}
                  onClick={() => setSelectedArtifact(artifact)}
                >
                  <div className="p">{artifact.path}</div>
                  <div className="m">
                    {artifact.kind} · {artifact.lines} lines
                    {artifact.traces?.length ? ` · traces ${artifact.traces.length} test(s)` : ''}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ minWidth: 0 }}>
              {selectedArtifact ? (
                <div>
                  <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)' }}>
                    <span className="mono small">{selectedArtifact.path}</span>
                    <div className="spacer" />
                    <button
                      className="btn sm"
                      onClick={async () => toast((await copyText(selectedArtifact.content)) ? 'Copied.' : 'Copy failed.', 'ok')}
                    >
                      ⧉ Copy
                    </button>
                  </div>
                  <pre className="code" style={{ border: 'none', borderRadius: 0, maxHeight: 520 }}>{selectedArtifact.content}</pre>
                </div>
              ) : (
                <Empty icon="⌸" title="Select a file to view it" />
              )}
            </div>
          </div>
        </Card>
      )}

      {live && !events.length && (
        <div className="row" style={{ marginTop: 14 }}><Spinner /> <span className="muted small">Connecting to the run stream…</span></div>
      )}
    </>
  );
}

function consoleTone(event) {
  if (event.type === 'run:start' || event.type === 'run:end' || event.type === 'validation:start') return 'head';
  if (event.type === 'guardrail') return event.status === 'pass' ? 'pass' : event.status === 'warn' ? 'warn' : 'fail';
  if (event.type === 'node:done') return 'pass';
  if (event.type === 'node:failed') return 'fail';
  if (event.type === 'node:log') return 'dim';
  return '';
}
