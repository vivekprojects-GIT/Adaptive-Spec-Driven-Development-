import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Stat, Empty, Dot, toneForStatus, toneForVerdict, copyText, useToast } from '../lib/ui.jsx';

export default function ReportStage({ project, navigate }) {
  const [run, setRun] = useState(null);
  const [runId, setRunId] = useState(project.runs?.find((r) => r.verdict)?.id || project.runs?.[0]?.id || null);
  const toast = useToast();

  useEffect(() => {
    if (!runId) return;
    api.run(runId).then(setRun).catch((err) => toast(err.message, 'err'));
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project.runs?.length) {
    return (
      <Card title="Report">
        <Empty icon="⎘" title="No run to report on yet">
          <button className="btn primary" style={{ marginTop: 10 }} onClick={() => navigate('run')}>Go to the run →</button>
        </Empty>
      </Card>
    );
  }

  const results = run?.validation?.results || [];
  const passed = results.filter((r) => r.status === 'pass').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const failed = results.filter((r) => r.status === 'fail').length;

  return (
    <>
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <select style={{ width: 320 }} value={runId || ''} onChange={(e) => setRunId(e.target.value)}>
          {project.runs.map((r) => (
            <option key={r.id} value={r.id}>{r.id} · {r.verdict || r.status} · {new Date(r.startedAt).toLocaleString()}</option>
          ))}
        </select>
        <div className="spacer" />
        {run && (
          <>
            <a className="btn" href={api.reportUrl(run.id)} download={`${run.id}-report.md`}>⬇ Markdown</a>
            <a className="btn" href={api.bundleUrl(run.id)} download={`${run.id}-bundle.json`}>⬇ JSON bundle</a>
            <button className="btn" onClick={async () => toast((await copyText(run.report || '')) ? 'Report copied.' : 'Copy failed.', 'ok')}>⧉ Copy report</button>
          </>
        )}
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Stat label="Verdict" value={run?.validation?.verdict || '—'} tone={toneForVerdict(run?.validation?.verdict)} />
        <Stat label="Passed" value={passed} tone="pass" sub="Computed from artifacts" />
        <Stat label="Warnings" value={warned} tone="warn" sub="Needs a human look" />
        <Stat label="Failures" value={failed} tone={failed ? 'fail' : ''} sub={failed ? 'Blocks acceptance' : 'none'} />
      </div>

      {run?.discovery?.gaps?.length > 0 && (
        <Card title="Capability gaps carried into this run" right={<Badge tone="fail">{run.discovery.gaps.length}</Badge>}>
          {run.discovery.gaps.map((gap) => (
            <div key={gap.capability} className="risk">
              <Badge tone="fail">gap</Badge>
              <div className="body">
                <div className="mono" style={{ fontWeight: 550 }}>{gap.capability}</div>
                <div className="small muted">{gap.reason}</div>
                <div className="small" style={{ color: 'var(--warn)' }}>Needs: {gap.needs}</div>
              </div>
            </div>
          ))}
        </Card>
      )}

      {results.length > 0 && (
        <Card title="Acceptance summary" sub="What a reviewer signs off on." tight>
          <table className="table">
            <thead><tr><th style={{ width: 40 }} /><th>Guardrail</th><th>Covers risk</th><th>Evidence</th></tr></thead>
            <tbody>
              {results.map((result) => (
                <tr key={result.guardrailId}>
                  <td><Dot tone={toneForStatus(result.status)} /></td>
                  <td><div style={{ fontWeight: 550 }}>{result.name}</div><div className="tiny faint">{result.severity}</div></td>
                  <td className="tiny mono">{(result.risks || []).join(', ')}</td>
                  <td className="small">{result.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Full report" sub="The same Markdown the download gives you." tight>
        <pre className="code" style={{ maxHeight: 640, whiteSpace: 'pre-wrap' }}>{run?.report || 'This run has not produced a report yet.'}</pre>
      </Card>
    </>
  );
}
