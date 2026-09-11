import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Stat, Empty, Dot, toneForStatus, shortTime, relTime } from '../lib/ui.jsx';

const COLUMNS = [
  { type: 'requirement', label: 'Requirements', icon: '§' },
  { type: 'sourceTest', label: 'Source tests', icon: '⌘' },
  { type: 'agent', label: 'Agents', icon: '⬡' },
  { type: 'artifact', label: 'Artifacts', icon: '⌸' },
  { type: 'guardrail', label: 'Guardrails', icon: '⛊' },
];

/**
 * Lineage view. Click anything and the whole chain it belongs to lights up:
 * requirement → source test → agent → artifact → guardrail.
 */
export default function TraceStage({ project, navigate, toast }) {
  const [run, setRun] = useState(null);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('');

  const completed = (project.runs || []).find((r) => r.status?.startsWith('completed')) || project.runs?.[0];

  useEffect(() => {
    if (!completed) return;
    api.run(completed.id).then(setRun).catch((err) => toast(err.message, 'err'));
  }, [completed?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const trace = run?.trace;

  const connected = useMemo(() => {
    if (!trace || !selected) return null;
    const adjacency = new Map();
    const add = (a, b) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      adjacency.get(a).add(b);
    };
    for (const link of trace.links) {
      add(link.from, link.to);
      add(link.to, link.from);
    }
    const seen = new Set([selected]);
    const queue = [selected];
    while (queue.length) {
      const current = queue.shift();
      for (const next of adjacency.get(current) || []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }, [trace, selected]);

  if (!project.runs?.length) {
    return (
      <Card title="Trace">
        <Empty icon="⇄" title="Nothing to trace yet">
          <div className="small" style={{ marginBottom: 12 }}>Run the migration and every artifact becomes traceable back to a requirement.</div>
          <button className="btn primary" onClick={() => navigate('run')}>Go to the run →</button>
        </Empty>
      </Card>
    );
  }

  const rows = run?.ws?.traceability?.rows || [];
  const orphans = run?.ws?.traceability?.orphanRequirements || [];
  const query = filter.trim().toLowerCase();

  const plan = run?.planTrace;

  return (
    <>
      {plan && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 18 }}>
            <Stat label="Requirements built" value={`${plan.counts.built}/${plan.counts.requirements}`} tone={plan.counts.built === plan.counts.requirements ? 'pass' : 'warn'} sub="Traced all the way to code" />
            <Stat label="Planned, not built" value={plan.counts.planned} tone={plan.counts.planned ? 'warn' : 'pass'} sub="Have a story, no code names it" />
            <Stat label="Lost along the way" value={plan.counts.specified + plan.counts.missing} tone={plan.counts.specified + plan.counts.missing ? 'fail' : 'pass'} sub="No story, or not even in the PRD" />
            <Stat label="Stories · code files" value={`${plan.stories} · ${plan.codeFiles}`} tone="accent" />
          </div>
          <Card
            title="Plan trace"
            sub="Each requirement followed through the plan: is it in the PRD, which stories carry it, which code files name those stories. Read from what the phases wrote, not typed in."
            tight
          >
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Requirement</th><th>In the PRD</th><th>Stories</th><th>Code</th><th>Status</th></tr></thead>
                <tbody>
                  {plan.rows.map((row) => (
                    <tr key={row.requirementId}>
                      <td>
                        <Badge tone="accent">{row.requirementId}</Badge>
                        <div className="tiny faint" style={{ marginTop: 4 }}>{row.text}</div>
                      </td>
                      <td>{row.inPrd ? <Badge tone="pass">yes</Badge> : <Badge tone="fail">no</Badge>}</td>
                      <td className="mono small">{row.stories.join(', ') || <span className="faint">none</span>}</td>
                      <td className="mono tiny">{row.files.length ? row.files.map((file) => <div key={file}>{file}</div>) : <span className="faint">none</span>}</td>
                      <td><Badge tone={toneForStatus(row.status)}>{row.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {trace && (
        <div className="grid cols-4" style={{ marginBottom: 18, marginTop: plan ? 18 : 0 }}>
          <Stat label="Trace links" value={trace.counts.links} tone="accent" sub="Every one is derived, not typed" />
          <Stat
            label="Requirements covered"
            value={`${(run.ws.traceability?.coveredRequirements ?? 0)}/${trace.counts.requirements}`}
            tone={orphans.length ? 'warn' : 'pass'}
            sub={orphans.length ? `${orphans.length} orphan(s)` : 'no orphans'}
          />
          <Stat label="Source tests migrated" value={`${rows.filter((r) => r.status === 'migrated').length}/${rows.length}`} tone="pass" />
          <Stat label="Artifacts" value={trace.counts.artifacts} sub={`from ${trace.counts.agents} agent(s)`} />
        </div>
      )}

      {trace && (
        <Card
          title="Lineage"
          sub="Click any node — the full chain it belongs to stays lit and everything unrelated dims."
          right={
            <div className="row">
              <input type="text" placeholder="Filter nodes…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 190 }} />
              {selected && <button className="btn sm" onClick={() => setSelected(null)}>Clear selection</button>}
            </div>
          }
          tight
        >
          <div className="trace-cols">
            {COLUMNS.map((column) => {
              const nodes = trace.nodes.filter((n) => n.type === column.type && (!query || `${n.label} ${n.detail}`.toLowerCase().includes(query)));
              return (
                <div className="trace-col" key={column.type}>
                  <div className="trace-col-head">
                    <span>{column.icon}</span> {column.label}
                    <div className="spacer" style={{ flex: 1 }} />
                    <span className="mono">{nodes.length}</span>
                  </div>
                  <div className="trace-col-body">
                    {nodes.length === 0 && <div className="tiny faint" style={{ padding: '6px 4px' }}>none</div>}
                    {nodes.map((node) => {
                      const isSelected = selected === node.id;
                      const isLinked = connected?.has(node.id);
                      const dimmed = connected && !isLinked;
                      return (
                        <div
                          key={node.id}
                          className={`tnode ${isSelected ? 'selected' : ''} ${isLinked && !isSelected ? 'linked' : ''} ${dimmed ? 'dimmed' : ''}`}
                          onClick={() => setSelected(isSelected ? null : node.id)}
                          title={node.detail}
                        >
                          <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                            <Dot tone={toneForStatus(node.status)} />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div className="t">{node.label}</div>
                              <div className="d">{node.detail}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {selected && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line-soft)' }} className="small muted">
              {connected.size - 1} connected node(s) across the chain. Links: {trace.links.filter((l) => connected.has(l.from) && connected.has(l.to)).map((l) => l.kind).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
            </div>
          )}
        </Card>
      )}

      {rows.length > 0 && (
        <Card title="Traceability matrix" sub="Requirement → source test → generated artifact, with assertion counts carried across." tight>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Requirement</th><th>Source test</th><th>File</th><th>Steps</th><th>Assertions</th><th>Generated</th><th>Status</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.testId}>
                    <td>{row.requirementId ? <Badge tone="accent">{row.requirementId}</Badge> : <span className="faint tiny">unmatched</span>}
                      {row.requirementText && <div className="tiny faint" style={{ marginTop: 3 }}>{row.requirementText}</div>}
                    </td>
                    <td className="mono">{row.sourceTest}</td>
                    <td className="tiny faint mono break">{row.sourceFile}</td>
                    <td className="mono">{row.steps}</td>
                    <td className="mono">{row.assertions}</td>
                    <td className="tiny mono">{row.artifacts.join(', ') || '—'}</td>
                    <td><Badge tone={toneForStatus(row.status)}>{row.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {orphans.length > 0 && (
        <Card title="Requirements with no migrated test" sub="These are the gaps a green run would otherwise hide." right={<Badge tone="fail">{orphans.length}</Badge>}>
          {orphans.map((orphan) => (
            <div key={orphan.id} className="risk">
              <Badge tone="fail">{orphan.id}</Badge>
              <div className="body small">{orphan.text}</div>
            </div>
          ))}
        </Card>
      )}

      <Card
        title="Decision trail"
        sub="Every action on this project, in order — who did it, when, and what changed."
        right={<Badge mono>{(project.trail || []).length}</Badge>}
      >
        <div className="timeline">
          {(project.trail || []).map((entry) => (
            <div key={entry.id} className={`tl-item ${entry.actor}`}>
              <div className="head">
                <Badge tone={entry.actor === 'control-plane' ? 'purple' : entry.actor === 'seed' ? '' : 'accent'}>{entry.actor}</Badge>
                <span className="mono tiny faint">{entry.action}</span>
                <span className="when">{shortTime(entry.at)} · {relTime(entry.at)}</span>
              </div>
              <div className="what">{entry.detail}</div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
