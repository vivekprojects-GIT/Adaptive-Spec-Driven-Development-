import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Stat, Empty, Dot, Bar, toneForStatus, toneForVerdict, relTime, shortTime } from '../lib/ui.jsx';

const LEVEL_TONE = { error: 'fail', warn: 'warn', info: 'info', debug: '' };

const STATUS_TONE = { completed: 'pass', 'completed-with-errors': 'fail', halted: 'fail', failed: 'fail', waiting: 'warn', running: '', queued: '' };

const duration = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`);

/** Observability at a glance: how runs end, how long they take, where the time goes, which model ran. */
function RunHealth({ health, runs }) {
  const statuses = Object.entries(health.byStatus).sort((a, b) => b[1] - a[1]);
  const models = Object.entries(health.models).sort((a, b) => b[1] - a[1]);
  const slowest = health.slowestAgents[0]?.avgMs || 1;
  return (
    <Card title="Run health" sub="How runs end, how long they take, where the time goes and which model did the work.">
      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <Stat
          label="Passed its guardrails"
          value={health.successRate == null ? '—' : `${health.successRate}%`}
          tone={health.successRate >= 80 ? 'pass' : health.successRate >= 50 ? 'warn' : 'fail'}
          sub={`of ${runs} run(s) — finished and nothing blocking`}
        />
        <Stat label="Typical run" value={duration(health.medianMs)} sub={`90% finish within ${duration(health.p90Ms)}`} />
        <Stat label="Steps done in VS Code" value={health.handoffs} tone="accent" sub="Handed to the coding assistant" />
        <Stat label="Models used" value={models.length} sub={models.map(([name]) => name).join(' · ')} />
      </div>
      <div className="grid cols-2">
        <div>
          <div className="small" style={{ fontWeight: 650, marginBottom: 8 }}>How runs ended</div>
          {statuses.map(([status, count]) => (
            <div className="meter" key={status}>
              <span>{status}</span>
              <Bar value={count} max={runs} tone={STATUS_TONE[status] ?? ''} />
              <span className="n">{count}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="small" style={{ fontWeight: 650, marginBottom: 8 }}>Where the time goes (average per run)</div>
          {health.slowestAgents.length === 0 && <div className="small faint">No timings yet.</div>}
          {health.slowestAgents.map((agent) => (
            <div className="meter" key={agent.name}>
              <span title={agent.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</span>
              <Bar value={agent.avgMs} max={slowest} />
              <span className="n">{duration(agent.avgMs)}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/**
 * The dashboard exists to answer one question: where did it fail? So it leads with failures —
 * which guardrails, which agents, which requirements never landed — and only then with totals.
 */
export default function Dashboard({ navigate }) {
  const [data, setData] = useState(null);
  const [logs, setLogs] = useState({ entries: [], counts: {} });
  const [filter, setFilter] = useState({ level: 'all', scope: 'all', q: '' });
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [dashboard, logResponse] = await Promise.all([api.dashboard(), api.logs(filter)]);
      setData(dashboard);
      setLogs(logResponse);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!auto) return undefined;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [auto, load]);

  if (error) {
    return (
      <div className="page">
        <Card title="Dashboard"><div className="small" style={{ color: 'var(--fail)' }}>{error}</div></Card>
      </div>
    );
  }
  if (!data) return <div className="page"><span className="muted">Loading dashboard…</span></div>;

  const { totals, checks, failures, recentRuns, blockedProjects, openGaps, orphanRequirements } = data;
  const problemCount =
    failures.agents.length + failures.guardrails.filter((g) => g.fail > 0).length + blockedProjects.length + openGaps.length;

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Dashboard</b></div>
        <div className="spacer" />
        <Badge tone={problemCount ? 'warn' : 'pass'}>{problemCount ? `${problemCount} thing(s) need attention` : 'nothing failing'}</Badge>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          auto-refresh
        </label>
        <button className="btn sm" onClick={load}>↻</button>
      </div>

      <div className="page wide">
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <Stat label="Projects" value={totals.projects} sub={`${blockedProjects.length} blocked at the interview`} tone={blockedProjects.length ? 'warn' : ''} />
          <Stat label="Runs" value={totals.runs} sub={`${totals.artifacts} artifact(s) produced`} tone="accent" />
          <Stat
            label="Guardrail checks"
            value={checks.total}
            tone={checks.fail ? 'fail' : checks.warn ? 'warn' : 'pass'}
            sub={`${checks.pass} pass · ${checks.warn} warn · ${checks.fail} fail`}
          />
          <Stat label="Awaiting approval" value={totals.awaitingApproval} tone={totals.awaitingApproval ? 'warn' : 'pass'} sub="Runs with no human decision" />
        </div>

        {data.health && totals.runs > 0 && <RunHealth health={data.health} runs={totals.runs} />}

        {checks.total > 0 && (
          <Card title="Check outcomes" sub="Across every run on this machine.">
            <div className="row" style={{ gap: 16, alignItems: 'stretch' }}>
              <div style={{ flex: 1 }}>
                <div className="row small" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Passing</span>
                  <span className="mono">{Math.round((checks.pass / checks.total) * 100)}%</span>
                </div>
                <Bar value={checks.pass} max={checks.total} tone="pass" />
              </div>
              <div style={{ flex: 1 }}>
                <div className="row small" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Warnings</span>
                  <span className="mono">{checks.warn}</span>
                </div>
                <Bar value={checks.warn} max={checks.total} tone="warn" />
              </div>
              <div style={{ flex: 1 }}>
                <div className="row small" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Failures</span>
                  <span className="mono">{checks.fail}</span>
                </div>
                <Bar value={checks.fail} max={checks.total} tone="fail" />
              </div>
            </div>
          </Card>
        )}

        <div className="grid cols-2">
          <Card title="Where guardrails are failing" sub="Ranked by failures, then warnings. Click a row to open the run that produced it." right={<Badge tone={failures.guardrails.some((g) => g.fail) ? 'fail' : 'warn'}>{failures.guardrails.length}</Badge>} tight>
            {failures.guardrails.length === 0 ? (
              <Empty icon="✓" title="No guardrail has failed or warned yet" />
            ) : (
              <table className="table">
                <thead><tr><th style={{ width: 34 }} /><th>Guardrail</th><th>Fail</th><th>Warn</th><th>Last evidence</th></tr></thead>
                <tbody>
                  {failures.guardrails.map((row) => (
                    <tr key={row.guardrailId} style={{ cursor: 'pointer' }} onClick={() => row.lastProjectId && navigate(`/projects/${row.lastProjectId}/run`)}>
                      <td><Dot tone={row.fail ? 'fail' : 'warn'} /></td>
                      <td><div style={{ fontWeight: 550 }}>{row.name}</div><div className="tiny faint">{row.severity}</div></td>
                      <td className="mono" style={{ color: row.fail ? 'var(--fail)' : undefined }}>{row.fail}</td>
                      <td className="mono">{row.warn}</td>
                      <td className="small muted">{row.lastEvidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Where agents are failing" sub="An agent that threw, and the error it threw." right={<Badge tone={failures.agents.length ? 'fail' : 'pass'}>{failures.agents.length}</Badge>} tight>
            {failures.agents.length === 0 && failures.placeholders.length === 0 ? (
              <Empty icon="✓" title="Every agent completed" />
            ) : (
              <table className="table">
                <thead><tr><th style={{ width: 34 }} /><th>Agent</th><th>Count</th><th>Detail</th></tr></thead>
                <tbody>
                  {failures.agents.map((row) => (
                    <tr key={row.agentId} style={{ cursor: 'pointer' }} onClick={() => row.lastProjectId && navigate(`/projects/${row.lastProjectId}/run`)}>
                      <td><Dot tone="fail" /></td>
                      <td><div style={{ fontWeight: 550 }}>{row.name}</div><div className="tiny faint mono">{row.capability}</div></td>
                      <td className="mono">{row.failures}</td>
                      <td className="small" style={{ color: 'var(--fail)' }}>{row.lastError}</td>
                    </tr>
                  ))}
                  {failures.placeholders.map((row) => (
                    <tr key={row.agentId} style={{ cursor: 'pointer' }} onClick={() => row.lastProjectId && navigate(`/projects/${row.lastProjectId}/run`)}>
                      <td><Dot tone="warn" /></td>
                      <td><div style={{ fontWeight: 550 }}>{row.name}</div><div className="tiny faint">produced a placeholder, not real work</div></td>
                      <td className="mono">{row.runs}</td>
                      <td className="small muted">No implementation, or no model configured to execute its instructions.</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="grid cols-2">
          {blockedProjects.length > 0 && (
            <Card title="Projects blocked before fulfilment" sub="Waiting on answers to blocking interview questions." right={<Badge tone="warn">{blockedProjects.length}</Badge>} tight>
              <table className="table">
                <thead><tr><th>Project</th><th style={{ width: 130 }}>Readiness</th><th>Open</th></tr></thead>
                <tbody>
                  {blockedProjects.map((row) => (
                    <tr key={row.projectId} style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${row.projectId}/interview`)}>
                      <td>{row.projectName}</td>
                      <td><Bar value={row.readiness} tone="warn" /><div className="tiny faint mono">{row.readiness}%</div></td>
                      <td className="mono">{row.blockingCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {openGaps.length > 0 && (
            <Card title="Capability gaps still open" sub="Work the platform cannot do until something is built." right={<Badge tone="fail">{openGaps.length}</Badge>} tight>
              <table className="table">
                <thead><tr><th>Capability</th><th>Project</th><th>Needs</th></tr></thead>
                <tbody>
                  {openGaps.map((gap, index) => (
                    <tr key={index} style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${gap.projectId}/discovery`)}>
                      <td className="mono tiny">{gap.capability}</td>
                      <td className="small">{gap.projectName}</td>
                      <td className="small muted">{gap.needs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>

        {orphanRequirements.length > 0 && (
          <Card title="Requirements that never reached an artifact" sub="The failure a green run hides best." right={<Badge tone="fail">{orphanRequirements.length}</Badge>} tight>
            <table className="table">
              <thead><tr><th style={{ width: 110 }}>Requirement</th><th>Text</th><th>Project</th></tr></thead>
              <tbody>
                {orphanRequirements.map((row, index) => (
                  <tr key={index} style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${row.projectId}/trace`)}>
                    <td><Badge tone="fail">{row.id}</Badge></td>
                    <td className="small">{row.text}</td>
                    <td className="small muted">{row.projectName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        <Card title="Recent runs" sub="Newest first. A red row means at least one agent threw." tight>
          {recentRuns.length === 0 ? (
            <Empty icon="▶" title="No runs yet" />
          ) : (
            <table className="table">
              <thead><tr><th style={{ width: 34 }} /><th>Run</th><th>Project</th><th>Verdict</th><th>Approval</th><th>Artifacts</th><th>Started</th></tr></thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${run.projectId}/run`)}>
                    <td><Dot tone={run.failedNodes.length ? 'fail' : toneForStatus(run.status)} /></td>
                    <td className="mono tiny">{run.id}
                      {run.failedNodes.length > 0 && <div style={{ color: 'var(--fail)' }}>failed: {run.failedNodes.join(', ')}</div>}
                    </td>
                    <td className="small">{run.projectName}</td>
                    <td><Badge tone={toneForVerdict(run.verdict)}>{run.verdict || run.status}</Badge></td>
                    <td>{run.approval ? <Badge tone={run.approval === 'approved' ? 'pass' : run.approval === 'pending' ? 'warn' : 'fail'}>{run.approval}</Badge> : <span className="faint tiny">—</span>}</td>
                    <td className="mono">{run.artifacts}</td>
                    <td className="tiny faint">{relTime(run.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title="Activity log"
          sub="Every API call, stage transition, agent step, guardrail verdict and model call."
          right={
            <div className="row">
              <select style={{ width: 120 }} value={filter.level} onChange={(e) => setFilter({ ...filter, level: e.target.value })}>
                <option value="all">All levels</option>
                <option value="error">Errors</option>
                <option value="warn">Warnings</option>
                <option value="info">Info</option>
                <option value="debug">Debug</option>
              </select>
              <select style={{ width: 130 }} value={filter.scope} onChange={(e) => setFilter({ ...filter, scope: e.target.value })}>
                <option value="all">All scopes</option>
                <option value="api">api</option>
                <option value="run">run</option>
                <option value="llm">llm</option>
              </select>
              <input type="text" style={{ width: 180 }} placeholder="Search…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
              <Badge tone={logs.counts.error ? 'fail' : ''} mono>{logs.counts.error || 0} err</Badge>
            </div>
          }
          tight
        >
          <div className="console" style={{ height: 380 }}>
            {logs.entries.length === 0 && <div className="msg dim">No log entries match that filter.</div>}
            {logs.entries.map((entry) => (
              <div className="ln" key={entry.id}>
                <span className="ts">{shortTime(entry.at)}</span>
                <span className={`msg ${LEVEL_TONE[entry.level] === 'fail' ? 'fail' : LEVEL_TONE[entry.level] === 'warn' ? 'warn' : entry.level === 'debug' ? 'dim' : ''}`}>
                  <span style={{ opacity: 0.55 }}>[{entry.scope}]</span> {entry.message}
                  {entry.runId && <span style={{ opacity: 0.45 }}> · {entry.runId}</span>}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
