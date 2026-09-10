import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamRun } from '../lib/api.js';
import { Card, Badge, Stat, Empty, Dot, Spinner, shortTime, toneForStatus, toneForVerdict, copyText } from '../lib/ui.jsx';
import Graph from '../components/Graph.jsx';
import ExportModal from '../components/ExportModal.jsx';

export default function RunStage({ project, reload, navigate, toast }) {
  const [runId, setRunId] = useState(project.runs?.[0]?.id || null);
  const [run, setRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState(null);
  const [approvalNote, setApprovalNote] = useState('');
  const [rerunFrom, setRerunFrom] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportKey, setExportKey] = useState(0);
  // Bumped when a halted run is continued, so the stream reconnects and follows it again.
  const [streamKey, setStreamKey] = useState(0);
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
    setApprovalNote('');
    setRerunFrom('');
  }, [runId]);

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
  }, [runId, streamKey]);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [events]);

  /** Bumping the key remounts the modal, so every open starts from a clean slate. */
  function openExport() {
    setExportKey((n) => n + 1);
    setExporting(true);
  }

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

  /** Every human decision on a run goes through here, so each one reports failure the same way. */
  async function decide(action) {
    setBusy(true);
    try {
      if (action === 'rerun') {
        const result = await api.rerunRun(run.id, { fromNodeId: rerunFrom || run.rerunSuggestion || undefined, note: approvalNote });
        await reload();
        setRunId(result.runId);
        toast(
          result.reused.length
            ? `Re-running from "${result.from}" — ${result.reused.length} unchanged agent(s) reused.`
            : `Re-running every agent. ${result.reasons[0] || ''}`,
          'ok',
        );
        return;
      }
      if (action === 'continue') {
        const result = await api.continueRun(run.id, { note: approvalNote });
        setApprovalNote('');
        setStreamKey((n) => n + 1);
        toast(`Continuing past "${result.overrode}" — ${result.continuing.length} agent(s) left to run.`, 'ok');
      } else {
        await api.approve(run.id, { state: action, note: approvalNote });
        setApprovalNote('');
        toast(action === 'approved' ? 'Run approved.' : 'Changes requested. Make them, then re-run from the agent you changed.', 'ok');
      }
      await load(run.id);
      await reload();
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

  const statuses = Object.fromEntries((run?.nodes || []).map((node) => [node.nodeId, node.reusedFrom && node.status === 'done' ? 'reused' : node.status]));
  const live = run?.status === 'running' || run?.status === 'queued';
  const halted = run?.status === 'halted';
  const artifacts = run?.ws?.generated || [];
  const results = run?.validation?.results || [];
  const duration = run?.finishedAt ? Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 100) / 10 : null;
  const stoppedBy = halted ? results.find((r) => r.guardrailId === run.validation?.haltedBy) : null;
  const skipped = (run?.nodes || []).filter((node) => node.status === 'skipped');
  const approvalState = run?.approval?.state;
  const waitingNode = run?.status === 'waiting' ? (run.nodes || []).find((node) => node.status === 'waiting') : null;

  return (
    <>
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <select style={{ width: 340 }} value={runId || ''} onChange={(e) => setRunId(e.target.value)}>
          {project.runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.rerunOf ? '↻ ' : ''}{r.id} · {r.status}{r.verdict ? ` · ${r.verdict}` : ''} · {new Date(r.startedAt).toLocaleString()}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button className="btn" disabled={busy || live} onClick={start}>▶ New run</button>
        {/* Getting the files out is the point of the run, so it belongs here rather than only at
            the bottom of the page next to the artifact list. */}
        {artifacts.length > 0 && (
          <button className="btn" disabled={live} onClick={() => openExport()} title={`Write ${artifacts.length} file(s) into a folder`}>
            ⤓ Export {artifacts.length} file(s)
          </button>
        )}
        {run?.report && <button className="btn primary" onClick={() => navigate('report')}>Report →</button>}
      </div>

      {run?.rerunOf && (
        <div className="proposal-why" style={{ marginBottom: 14 }}>
          ↻ Re-run of{' '}
          <button className="btn sm" onClick={() => setRunId(run.rerunOf.runId)}>{run.rerunOf.runId}</button>
          {run.rerunOf.from ? <> from <b>{run.rerunOf.from}</b></> : null}
          {run.rerunOf.reused.length ? ` — ${run.rerunOf.reused.length} agent(s) reused unchanged: ${run.rerunOf.reused.join(', ')}.` : ' — every agent ran again.'}
          {run.rerunOf.reasons.map((reason) => (
            <div key={reason} className="small muted" style={{ marginTop: 4 }}>{reason}</div>
          ))}
        </div>
      )}

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Stat
          label="Status"
          value={live ? 'running' : run?.status || '—'}
          tone={live ? 'accent' : waitingNode ? 'warn' : halted || run?.status?.includes('error') || run?.status === 'failed' ? 'fail' : 'pass'}
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
        <Graph graph={run?.graph || project.graph} statuses={statuses} />
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
                    <td>
                      <Badge tone={toneForStatus(node.status)}>{node.status}</Badge>
                      {node.reusedFrom && (
                        <div style={{ marginTop: 4 }} title={`Unchanged since ${node.reusedFrom}; its output was carried over, not produced again.`}>
                          <Badge tone="info">reused</Badge>
                        </div>
                      )}
                    </td>
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

      {waitingNode && (
        <Card
          title="Waiting on your coding assistant"
          sub="This agent step needs a model. In VS Code, Copilot does it with your files; the run carries on when it hands the work back."
          right={<Badge tone="warn">waiting</Badge>}
        >
          <div className="proposal-why" style={{ marginBottom: 10 }}>
            <b>{waitingNode.name}</b>
            {waitingNode.handoff?.bmad ? ` — your BMAD agent ${waitingNode.handoff.bmad.icon} ${waitingNode.handoff.bmad.name}` : ''}. In Copilot Chat run{' '}
            <span className="mono">/asdd-run</span>, or <span className="mono">node _asdd/asdd.mjs task</span> in the project's terminal, to see the
            task. The files come back with <span className="mono">node _asdd/asdd.mjs submit</span>.
          </div>
          {waitingNode.handoff?.task && (
            <details>
              <summary className="small">The task it was given</summary>
              <pre className="code" style={{ maxHeight: 360, marginTop: 8 }}>{waitingNode.handoff.task}</pre>
            </details>
          )}
        </Card>
      )}

      {run && (run.approval || run.decisions?.length > 0) && (
        <Card
          title="Human decision"
          sub="The last gate. AI proposed the architecture; you own the decision on what it produced."
          right={
            approvalState ? (
              <Badge tone={approvalState === 'approved' ? 'pass' : approvalState === 'pending' ? 'warn' : 'fail'}>{approvalState}</Badge>
            ) : live ? (
              <Badge tone="info">continuing</Badge>
            ) : null
          }
        >
          {approvalState === 'pending' && halted && (
            <>
              <div className="proposal-why" style={{ marginBottom: 10 }}>
                <b>{stoppedBy?.name || 'A guardrail'}</b> stopped the run. {skipped.length} agent(s) did not run: {skipped.map((node) => node.name).join(', ')}.
              </div>
              {stoppedBy?.evidence && <div className="small muted" style={{ marginBottom: 12 }}>Evidence: {stoppedBy.evidence}</div>}
              <textarea
                rows={2}
                placeholder="Why you are continuing, or what needs changing — recorded with your decision."
                value={approvalNote}
                onChange={(e) => setApprovalNote(e.target.value)}
              />
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn pass" disabled={busy} onClick={() => decide('continue')}>▶ Approve and continue</button>
                <button className="btn danger" disabled={busy} onClick={() => decide('changes-requested')}>↩ Request changes</button>
              </div>
              <div className="tiny faint" style={{ marginTop: 8 }}>
                Continuing keeps everything already produced and runs the {skipped.length} skipped agent(s) in this same run. It records that you
                overrode “{stoppedBy?.name}” — that check still counts as failed, and the verdict and report say so. The run then comes back here for
                your final approval.
              </div>
            </>
          )}

          {approvalState === 'pending' && !halted && (
            <>
              <div className="proposal-why" style={{ marginBottom: 12 }}>{run.approval.reason}</div>
              <textarea
                rows={2}
                placeholder="Optional note — what you checked, or what needs changing."
                value={approvalNote}
                onChange={(e) => setApprovalNote(e.target.value)}
              />
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn pass" disabled={busy} onClick={() => decide('approved')}>✓ Approve this run</button>
                <button className="btn danger" disabled={busy} onClick={() => decide('changes-requested')}>↩ Request changes</button>
              </div>
            </>
          )}

          {(approvalState === 'approved' || approvalState === 'changes-requested') && (
            <div className="kv">
              <div className="k">Decision</div>
              <div className="v">{approvalState === 'approved' ? 'Approved' : 'Changes requested'}</div>
              <div className="k">By</div>
              <div className="v">{run.approval.by}</div>
              <div className="k">When</div>
              <div className="v">{new Date(run.approval.at).toLocaleString()}</div>
              {run.approval.note && (<><div className="k">Note</div><div className="v">{run.approval.note}</div></>)}
            </div>
          )}

          {approvalState === 'changes-requested' && run.supersededBy && (
            <div className="row" style={{ marginTop: 12 }}>
              <span className="small">Re-run as</span>
              <button className="btn sm primary" onClick={() => setRunId(run.supersededBy)}>{run.supersededBy} →</button>
            </div>
          )}

          {approvalState === 'changes-requested' && !run.supersededBy && (
            <>
              <div className="proposal-why" style={{ margin: '12px 0' }}>
                Make the change first — edit the agent on the{' '}
                <button className="btn sm" onClick={() => navigate('agents')}>Agents</button> step, then recompose on{' '}
                <button className="btn sm" onClick={() => navigate('workflow')}>Workflow</button>. The re-run reuses every agent before the one you pick
                if it has not changed, and runs that agent and everything after it again. If something earlier changed, it starts there instead and
                tells you why.
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <span className="small">Re-run from</span>
                <select style={{ width: 340 }} value={rerunFrom || run.rerunSuggestion || run.nodes[0]?.nodeId} onChange={(e) => setRerunFrom(e.target.value)}>
                  {run.nodes.map((node, index) => (
                    <option key={node.nodeId} value={node.nodeId}>
                      {index + 1}. {node.name} — {node.status}
                    </option>
                  ))}
                </select>
                <button className="btn primary" disabled={busy} onClick={() => decide('rerun')}>↻ Re-run from here</button>
              </div>
            </>
          )}

          {!approvalState && live && (
            <div className="row"><Spinner /> <span className="small muted">Continuing — the run comes back here for your decision when it finishes.</span></div>
          )}

          {run.decisions?.length > 0 && <Decisions decisions={run.decisions} onOpenRun={setRunId} />}
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
                  <td className="small">
                    {result.evidence}
                    {result.overridden && (
                      <div style={{ marginTop: 5 }}>
                        <Badge tone="warn">stop overridden by {result.overridden.by}</Badge>
                        {result.overridden.note && <span className="tiny faint"> “{result.overridden.note}”</span>}
                      </div>
                    )}
                  </td>
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
              <button className="btn sm primary" onClick={() => openExport()}>⤓ Export to folder</button>
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

      {exporting && <ExportModal key={exportKey} run={run} projectId={project.id} onClose={() => setExporting(false)} />}

      {live && !events.length && (
        <div className="row" style={{ marginTop: 14 }}><Spinner /> <span className="muted small">Connecting to the run stream…</span></div>
      )}
    </>
  );
}

const DECISION_LABEL = {
  continued: '▶ Continued past a stop',
  approved: '✓ Approved',
  'changes-requested': '↩ Changes requested',
  rerun: '↻ Re-run',
};

/** Every decision a person made on this run, in order — overrides included. */
function Decisions({ decisions, onOpenRun }) {
  return (
    <div className="timeline" style={{ marginTop: 16 }}>
      {decisions.map((decision, index) => (
        <div key={index} className="tl-item human">
          <div className="head">
            <span className="what">
              {DECISION_LABEL[decision.type] || decision.type}
              {decision.guardrail ? ` — overrode “${decision.guardrail}”, ${decision.agents?.length || 0} skipped agent(s) then ran` : ''}
              {decision.type === 'rerun' && (
                <>
                  {' '}as <button className="btn sm" onClick={() => onOpenRun(decision.runId)}>{decision.runId}</button>
                  {decision.from ? ` from “${decision.from}”` : ''}
                </>
              )}
            </span>
            <span className="when">{new Date(decision.at).toLocaleString()} · {decision.by}</span>
          </div>
          {decision.note && <div className="small muted">{decision.note}</div>}
        </div>
      ))}
    </div>
  );
}

function consoleTone(event) {
  if (['run:start', 'run:end', 'validation:start', 'run:resumed', 'run:continued', 'run:rerun', 'approval'].includes(event.type)) return 'head';
  if (event.type === 'guardrail') return event.status === 'pass' ? 'pass' : event.status === 'warn' ? 'warn' : 'fail';
  if (event.type === 'node:done' || event.type === 'node:reused') return 'pass';
  if (event.type === 'node:failed' || event.type === 'run:halted') return 'fail';
  if (event.type === 'node:skipped' || event.type === 'node:waiting' || event.type === 'run:waiting') return 'warn';
  if (event.type === 'node:submitted') return 'pass';
  if (event.type === 'node:log') return 'dim';
  return '';
}
