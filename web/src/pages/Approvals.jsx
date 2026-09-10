import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Stat, Empty, Dot, relTime } from '../lib/ui.jsx';

const KIND_LABEL = {
  interview: 'Blocking question',
  'agent-proposals': 'Agent proposals',
  'guardrail-proposals': 'Guardrail proposals',
  'halted-run': 'Halted run',
  'assistant-task': 'Assistant step',
  'run-approval': 'Run approval',
  'sign-off': 'Guardrail sign-off',
};

const KIND_ICON = {
  interview: '?',
  'agent-proposals': '⬡',
  'guardrail-proposals': '⛊',
  'halted-run': '■',
  'assistant-task': '⧗',
  'run-approval': '✓',
  'sign-off': '✎',
};

/**
 * Everything waiting on a person, in one list. The platform gates on humans deliberately, so a
 * human has to be able to see what it is waiting for without opening each project to find out.
 */
export default function Approvals({ navigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.approvals());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) {
    return <div className="page"><Card title="Approvals"><div className="small" style={{ color: 'var(--fail)' }}>{error}</div></Card></div>;
  }
  if (!data) return <div className="page"><span className="muted">Loading…</span></div>;

  const blocking = data.items.filter((item) => item.severity === 'blocker');
  const rest = data.items.filter((item) => item.severity !== 'blocker');

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Approvals</b></div>
        <div className="spacer" />
        <Badge tone={data.total ? 'warn' : 'pass'}>{data.total ? `${data.total} waiting on you` : 'nothing waiting'}</Badge>
        <button className="btn sm" onClick={load}>↻</button>
      </div>

      <div className="page">
        <div className="grid cols-3" style={{ marginBottom: 14 }}>
          <Stat label="Waiting on you" value={data.total} tone={data.total ? 'warn' : 'pass'} sub="Across every project" />
          <Stat label="Blocking" value={blocking.length} tone={blocking.length ? 'fail' : 'pass'} sub="Nothing proceeds until these are answered" />
          <Stat label="Projects involved" value={Object.keys(data.byProject).length} sub="Click any row to go straight there" />
        </div>

        {data.items.length === 0 ? (
          <Card title="Approvals">
            <Empty icon="✓" title="Nothing is waiting on a human">
              <div className="small">Every proposal has been decided, every question answered, and every run signed off.</div>
            </Empty>
          </Card>
        ) : (
          <>
            {blocking.length > 0 && (
              <Card
                title="Blocking — nothing moves until you decide"
                sub="The platform has stopped here on purpose."
                right={<Badge tone="fail">{blocking.length}</Badge>}
                tight
              >
                <ApprovalList items={blocking} navigate={navigate} />
              </Card>
            )}

            {rest.length > 0 && (
              <Card
                title="Waiting on you"
                sub="Decisions the platform will not make on your behalf."
                right={<Badge tone="warn">{rest.length}</Badge>}
                tight
              >
                <ApprovalList items={rest} navigate={navigate} />
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ApprovalList({ items, navigate }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 36 }} />
          <th style={{ width: 170 }}>Type</th>
          <th>What is waiting</th>
          <th style={{ width: 190 }}>Project</th>
          <th style={{ width: 110 }}>Since</th>
          <th style={{ width: 190 }} />
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/projects/${item.projectId}/${item.stage}`)}>
            <td style={{ fontSize: 14, opacity: 0.7 }}>{KIND_ICON[item.kind] || '•'}</td>
            <td>
              <div className="row" style={{ gap: 6 }}>
                <Dot tone={item.severity === 'blocker' ? 'fail' : 'warn'} />
                <span className="small">{KIND_LABEL[item.kind] || item.kind}</span>
              </div>
            </td>
            <td>
              <div style={{ fontWeight: 550 }}>{item.title}</div>
              <div className="small muted">{item.detail}</div>
            </td>
            <td className="small">{item.projectName}</td>
            <td className="tiny faint">{relTime(item.since)}</td>
            <td>
              <button
                className="btn sm primary"
                onClick={(event) => {
                  event.stopPropagation();
                  navigate(`/projects/${item.projectId}/${item.stage}`);
                }}
              >
                {item.action} →
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
