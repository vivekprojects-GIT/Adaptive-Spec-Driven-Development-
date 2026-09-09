import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Bar, Stat, Empty, Spinner, toneForSeverity } from '../lib/ui.jsx';

/**
 * The readiness gate. The platform asks what it does not know; the developer answers; only then
 * does fulfilment unlock. Blocking questions are the ones that would make the run meaningless.
 */
export default function InterviewStage({ project, reload, navigate, toast }) {
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState(null);
  const [drafts, setDrafts] = useState({});
  const interview = project.interview;

  useEffect(() => {
    if (!interview) assess(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function assess(withLlm) {
    setBusy(true);
    try {
      await api.assess(project.id, { withLlm });
      await reload();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function submit(question, value) {
    if (!value?.toString().trim()) return;
    setAnswering(question.id);
    try {
      await api.answer(project.id, question.id, value);
      await reload();
      toast('Answer recorded — the spec was updated with it.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setAnswering(null);
    }
  }

  if (!interview) {
    return (
      <Card title="Requirements interview">
        <div className="row"><Spinner /> <span className="muted">Assessing the spec…</span></div>
      </Card>
    );
  }

  const open = interview.questions.filter((q) => !q.answered);
  const blocking = open.filter((q) => q.required);
  const optional = open.filter((q) => !q.required);
  const answered = Object.entries(interview.answers || {});

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Stat label="Readiness" value={`${interview.readiness}%`} tone={interview.ready ? 'pass' : 'warn'} sub={interview.ready ? 'Ready for fulfilment' : 'Blocked'} />
        <Stat label="Blocking questions" value={blocking.length} tone={blocking.length ? 'fail' : 'pass'} sub="Must be answered" />
        <Stat label="Optional questions" value={optional.length} sub="Improve the output" />
        <Stat label="Answers on record" value={answered.length} sub="Folded back into the spec" />
      </div>

      <Card
        title="Readiness"
        sub={interview.llm?.used ? `Rule engine + model — ${interview.llm.detail}` : interview.llm?.detail || 'Rule engine only.'}
        right={
          <div className="row">
            <button className="btn sm" disabled={busy} onClick={() => assess(true)}>{busy ? 'Assessing…' : '↻ Re-assess'}</button>
            <button className="btn sm primary" disabled={!interview.ready} onClick={() => navigate('discovery')} title={interview.ready ? '' : 'Answer the blocking questions first'}>
              Fulfilment →
            </button>
          </div>
        }
      >
        <Bar value={interview.readiness} tone={interview.ready ? 'pass' : 'warn'} />
        <div className="row small muted" style={{ marginTop: 10, gap: 16, flexWrap: 'wrap' }}>
          <span>Source: <b>{interview.context.source}</b></span>
          <span>Target: <b>{interview.context.target}</b></span>
          <span>Artifacts: <b>{interview.context.artifacts}</b></span>
          <span>Recognised tests: <b>{interview.context.parsedTests}</b></span>
          <span>Requirements: <b>{interview.context.requirements}</b></span>
          <span>Fixtures: <b>{interview.context.dataFiles}</b></span>
        </div>
        {!interview.ready && (
          <div className="proposal-why" style={{ marginTop: 12 }}>
            Fulfilment stays locked until every blocking question is answered. That is deliberate: a
            migration run against an under-specified spec produces confident output nobody can trust.
          </div>
        )}
      </Card>

      {blocking.length > 0 && (
        <Card title="Questions that block fulfilment" sub="Answer these and the platform moves on by itself." right={<Badge tone="fail">{blocking.length}</Badge>}>
          <div className="stack">
            {blocking.map((question) => (
              <Question key={question.id} question={question} draft={drafts[question.id]} setDraft={(v) => setDrafts({ ...drafts, [question.id]: v })} onSubmit={submit} busy={answering === question.id} />
            ))}
          </div>
        </Card>
      )}

      {optional.length > 0 && (
        <Card title="Questions that shape the output" sub="Optional — but each one changes what the generators emit." right={<Badge tone="warn">{optional.length}</Badge>}>
          <div className="stack">
            {optional.map((question) => (
              <Question key={question.id} question={question} draft={drafts[question.id]} setDraft={(v) => setDrafts({ ...drafts, [question.id]: v })} onSubmit={submit} busy={answering === question.id} />
            ))}
          </div>
        </Card>
      )}

      {open.length === 0 && (
        <Card title="Nothing left to ask">
          <Empty icon="✓" title="The spec answers everything the platform needs">
            <button className="btn primary" style={{ marginTop: 10 }} onClick={() => navigate('discovery')}>Run discovery →</button>
          </Empty>
        </Card>
      )}

      {answered.length > 0 && (
        <Card title="Answers on record" sub="These were merged into the spec and travel into the run report." tight>
          <table className="table">
            <thead><tr><th style={{ width: '46%' }}>Question</th><th>Answer</th></tr></thead>
            <tbody>
              {answered.map(([key, value]) => {
                const question = interview.questions.find((q) => q.id === key);
                return (
                  <tr key={key}>
                    <td>{question?.question || <span className="mono faint">{key}</span>}</td>
                    <td className="small">{String(value)}</td>
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

function Question({ question, draft, setDraft, onSubmit, busy }) {
  const value = draft ?? question.answer ?? '';
  const isOther = question.kind === 'choice' && value === '__other__';

  return (
    <div className="proposal">
      <div className="proposal-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 6, marginBottom: 5 }}>
            <Badge tone={toneForSeverity(question.severity)}>{question.severity}</Badge>
            {question.required && <Badge tone="fail">blocking</Badge>}
            <Badge tone={question.origin === 'llm' ? 'purple' : ''}>{question.origin === 'llm' ? 'from the model' : 'rule engine'}</Badge>
          </div>
          <div style={{ fontWeight: 550, fontSize: 13.5 }}>{question.question}</div>
        </div>
      </div>
      <div className="proposal-body">
        <div className="proposal-why">{question.why}</div>

        {question.kind === 'action' ? (
          <div className="small muted" style={{ marginTop: 10 }}>
            Add files on the <b>Spec</b> step, then re-assess. This one cannot be answered with text.
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            {question.kind === 'choice' && !isOther ? (
              <div className="stack">
                <select value={value} onChange={(e) => setDraft(e.target.value)}>
                  <option value="">Choose an answer…</option>
                  {question.options.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                  <option value="__other__">Other — let me type it</option>
                </select>
              </div>
            ) : (
              <textarea
                rows={question.kind === 'text' ? 4 : 2}
                value={isOther ? '' : value}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type your answer…"
              />
            )}
          </div>
        )}
      </div>
      {question.kind !== 'action' && (
        <div className="proposal-actions">
          <button className="btn sm primary" disabled={busy || !value || value === '__other__'} onClick={() => onSubmit(question, value)}>
            {busy ? 'Saving…' : 'Answer'}
          </button>
        </div>
      )}
    </div>
  );
}
