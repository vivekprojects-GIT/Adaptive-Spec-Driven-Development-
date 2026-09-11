import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Stat, Empty, toneForVerdict, shortTime, relTime } from '../lib/ui.jsx';

const CATEGORY = {
  approval: { label: 'Approval', tone: 'pass' },
  override: { label: 'Override', tone: 'fail' },
  change: { label: 'Change requested', tone: 'warn' },
  proposal: { label: 'Proposal decision', tone: 'accent' },
  input: { label: 'Input', tone: 'info' },
  assistant: { label: 'Coding assistant', tone: 'purple' },
  system: { label: 'ASDD', tone: '' },
  other: { label: 'Other', tone: '' },
};

const ACTOR = { human: 'Person', assistant: 'Coding assistant', 'control-plane': 'ASDD', seed: 'ASDD' };

/**
 * Governance: who decided what, when, and under which rules — across every project. It answers
 * the questions an auditor asks: what was approved, what was overridden, what was the work held to.
 */
export default function Governance({ navigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({ project: 'all', who: 'all', category: 'all', q: '' });

  const load = useCallback(async () => {
    try {
      setData(await api.governance());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 6000);
    return () => clearInterval(timer);
  }, [load]);

  const decisions = useMemo(() => {
    if (!data) return [];
    const query = filter.q.trim().toLowerCase();
    return data.decisions.filter(
      (entry) =>
        (filter.project === 'all' || entry.projectId === filter.project) &&
        (filter.who === 'all' || (ACTOR[entry.actor] || entry.actor) === filter.who) &&
        (filter.category === 'all' || entry.category === filter.category) &&
        (!query || `${entry.detail} ${entry.action} ${entry.projectName}`.toLowerCase().includes(query)),
    );
  }, [data, filter]);

  if (error) {
    return (
      <div className="page">
        <Card title="Governance"><div className="small" style={{ color: 'var(--fail)' }}>{error}</div></Card>
      </div>
    );
  }
  if (!data) return <div className="page"><span className="muted">Loading governance…</span></div>;

  const { totals, overrides, policies } = data;
  const projectOptions = [...new Map(data.decisions.map((d) => [d.projectId, d.projectName])).entries()];

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Governance</b></div>
        <div className="spacer" />
        <Badge tone={totals.overrides ? 'fail' : 'pass'}>{totals.overrides ? `${totals.overrides} override(s) on record` : 'no overrides'}</Badge>
        <button className="btn sm" onClick={load}>↻</button>
      </div>

      <div className="page wide">
        <div className="grid cols-4">
          <Stat label="Decisions by people" value={totals.decisions} tone="accent" sub={`${totals.approvals} approval(s) · ${totals.changes} change request(s)`} />
          <Stat label="Overrides" value={totals.overrides} tone={totals.overrides ? 'fail' : 'pass'} sub="Runs let past a guardrail set to stop" />
          <Stat label="Runs approved" value={totals.runsApproved} tone="pass" sub={`${totals.runsAwaiting} still waiting for a decision`} />
          <Stat label="Coding-assistant actions" value={totals.assistant} sub="Steps done and rules judged in VS Code" />
        </div>

        <Card
          title="Overrides"
          sub="Every time a person let a run continue past a guardrail set to stop — who, when and why. The check itself still counts as failed."
          right={<Badge tone={overrides.length ? 'fail' : 'pass'}>{overrides.length}</Badge>}
          tight
        >
          {overrides.length === 0 ? (
            <Empty icon="✓" title="Nobody has overridden a stop" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Guardrail</th><th>Project</th><th>By</th><th>Why</th><th>Evidence it failed on</th><th>When</th></tr></thead>
                <tbody>
                  {overrides.map((row, index) => (
                    <tr key={`${row.runId}-${index}`} style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${row.projectId}/run`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{row.guardrail}</div>
                        <div className="tiny faint">{row.severity}{row.carriedFrom ? ` · carried over from ${row.carriedFrom}` : ''}</div>
                      </td>
                      <td className="small">{row.projectName}<div className="tiny faint mono">{row.runId}</div></td>
                      <td className="small">{row.by}</td>
                      <td className="small">{row.note || <span className="faint">no reason given</span>}</td>
                      <td className="small muted">{row.evidence}</td>
                      <td className="tiny faint nowrap">{relTime(row.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Policies in force" sub="What each project is held to right now: its guardrails, which of them stop the run, and how its latest run ended." tight>
          {policies.length === 0 ? (
            <Empty icon="◈" title="No projects yet" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Project</th><th>Kind</th><th>Guardrails</th><th>Stop the run</th><th>Judged in plain English</th><th>Latest run</th></tr></thead>
                <tbody>
                  {policies.map((row) => (
                    <tr key={row.projectId} style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${row.projectId}/guardrails`)}>
                      <td style={{ fontWeight: 600 }}>{row.projectName}</td>
                      <td><Badge>{row.kind}</Badge></td>
                      <td className="mono">{row.guardrails}</td>
                      <td className="small">{row.stops.length ? row.stops.join(' · ') : <span className="faint">none</span>}</td>
                      <td className="mono">{row.plainEnglish}</td>
                      <td>
                        {row.lastRun ? (
                          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            <Badge tone={toneForVerdict(row.lastRun.verdict)}>{row.lastRun.verdict || row.lastRun.status}</Badge>
                            {row.lastRun.approval && (
                              <Badge tone={row.lastRun.approval === 'approved' ? 'pass' : row.lastRun.approval === 'pending' ? 'warn' : 'fail'}>{row.lastRun.approval}</Badge>
                            )}
                            <span className="tiny faint">{row.lastRun.model || 'rule engine'}</span>
                          </div>
                        ) : (
                          <span className="faint tiny">not run yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Decision log"
          sub="Every action on every project, newest first — people, the coding assistant and ASDD itself told apart."
          right={
            <div className="filters">
              <select value={filter.project} onChange={(e) => setFilter({ ...filter, project: e.target.value })}>
                <option value="all">All projects</option>
                {projectOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <select value={filter.who} onChange={(e) => setFilter({ ...filter, who: e.target.value })}>
                <option value="all">Everyone</option>
                <option value="Person">People</option>
                <option value="Coding assistant">Coding assistant</option>
                <option value="ASDD">ASDD</option>
              </select>
              <select value={filter.category} onChange={(e) => setFilter({ ...filter, category: e.target.value })}>
                <option value="all">All kinds</option>
                {Object.entries(CATEGORY).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
              </select>
              <input type="text" placeholder="Search…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
            </div>
          }
        >
          {decisions.length === 0 ? (
            <Empty icon="◈" title="Nothing matches" />
          ) : (
            <div className="timeline">
              {decisions.slice(0, 250).map((entry) => (
                <div key={`${entry.projectId}-${entry.id}`} className={`tl-item ${entry.actor}`}>
                  <div className="head">
                    <Badge tone={CATEGORY[entry.category]?.tone}>{CATEGORY[entry.category]?.label || entry.category}</Badge>
                    <span className="small" style={{ fontWeight: 600 }}>{ACTOR[entry.actor] || entry.actor}</span>
                    <span className="small muted" style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${entry.projectId}/trace`)}>
                      {entry.projectName}
                    </span>
                    <span className="when">{shortTime(entry.at)} · {relTime(entry.at)}</span>
                  </div>
                  <div className="what">{entry.detail}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
