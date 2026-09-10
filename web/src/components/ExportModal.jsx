import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { Modal, Field, Badge, Dot, useToast } from '../lib/ui.jsx';

const STATUS_TONE = { create: 'pass', overwrite: 'warn', 'skip-exists': '', blocked: 'fail' };
const STATUS_LABEL = {
  create: 'new file',
  overwrite: 'will overwrite',
  'skip-exists': 'exists — skipped',
  blocked: 'blocked',
};

/** Remembering the folder is useful; remembering a stale plan is not. Only the path persists. */
const rememberedKey = (projectId) => `asdd:export-folder:${projectId || 'default'}`;

function readRemembered(projectId) {
  try {
    return window.localStorage.getItem(rememberedKey(projectId)) || '';
  } catch {
    return '';
  }
}

function remember(projectId, value) {
  try {
    window.localStorage.setItem(rememberedKey(projectId), value);
  } catch {
    /* private browsing — the convenience is optional */
  }
}

/**
 * Export a run's artifacts into a folder on disk.
 *
 * Always previews first. This is the one place the platform writes outside its own data directory,
 * so the user sees the exact file list — what is new, what already exists, what was blocked — and
 * has to tick a box before anything overwrites work they already have.
 */
export default function ExportModal({ run, projectId, onClose }) {
  // Mounted fresh on every open (RunStage keys it), so plan, result and overwrite always start
  // clean — a stale preview must never be mistaken for the current state of the folder.
  const [targetDir, setTargetDir] = useState(() => readRemembered(projectId));
  const [include, setInclude] = useState(['code', 'spec', 'data', 'config']);
  const [overwrite, setOverwrite] = useState(false);
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const wasRemembered = Boolean(readRemembered(projectId));
  const toast = useToast();

  const kinds = plan?.kinds || [
    { id: 'code', label: 'Generated code', hint: 'tests, page objects' },
    { id: 'spec', label: 'Specs & documents', hint: 'features, docs' },
    { id: 'data', label: 'Migrated test data', hint: 'data/*.json' },
    { id: 'config', label: 'Framework config', hint: 'playwright.config.ts' },
    { id: 'analysis', label: 'Analysis output', hint: 'source model, traceability' },
  ];

  const toggle = (id) => setInclude((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  async function preview() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPlan(await api.exportRun(run.id, { targetDir, include, overwrite, dryRun: true }));
    } catch (err) {
      setError(err.details?.example ? `${err.message} (e.g. ${err.details.example})` : err.message);
      setPlan(null);
    } finally {
      setBusy(false);
    }
  }

  async function write() {
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.exportRun(run.id, { targetDir, include, overwrite, dryRun: false });
      setResult(outcome);
      remember(projectId, targetDir);
      toast(`Wrote ${outcome.written.length} file(s) to ${outcome.root}.`, 'ok');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const blockedCount = plan?.summary.blocked || 0;
  const existing = plan?.summary.skipExists || 0;

  return (
    <Modal
      title="Export to folder"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
          {!result && (
            <>
              <button className="btn" disabled={busy || !targetDir.trim()} onClick={preview}>
                {busy && !plan ? 'Checking…' : 'Preview'}
              </button>
              <button
                className="btn primary"
                disabled={busy || !plan || (plan.summary.create + plan.summary.overwrite === 0)}
                onClick={write}
              >
                Write {plan ? plan.summary.create + plan.summary.overwrite : ''} file(s)
              </button>
            </>
          )}
        </>
      }
    >
      {result ? (
        <>
          <div className="proposal-why" style={{ marginBottom: 14 }}>
            Wrote <b>{result.written.length}</b> file(s) into <span className="mono">{result.root}</span>
            {result.createdFolder ? ' (folder created)' : ''}.
            {result.skipped.length ? ` ${result.skipped.length} existing file(s) were left alone.` : ''}
            {result.errors.length ? ` ${result.errors.length} failed.` : ''}
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>File</th><th style={{ width: 130 }}>Result</th></tr></thead>
              <tbody>
                {result.written.map((file) => (
                  <tr key={file.path}><td className="mono tiny">{file.path}</td><td><Badge tone="pass">{file.status === 'overwrite' ? 'overwritten' : 'written'}</Badge></td></tr>
                ))}
                {result.skipped.map((file) => (
                  <tr key={file.path}><td className="mono tiny">{file.path}</td><td><Badge>existed — skipped</Badge></td></tr>
                ))}
                {result.errors.map((file) => (
                  <tr key={file.path}><td className="mono tiny">{file.path}</td><td><Badge tone="fail">{file.error}</Badge></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small muted" style={{ marginTop: 12 }}>
            Open that folder in your editor — the files are ordinary source files now.
          </div>
        </>
      ) : (
        <>
          <Field
            label="Target folder"
            hint={
              wasRemembered && targetDir
                ? 'Your last export folder for this project. Change it freely — the folder is created if it does not exist.'
                : 'An absolute path, so there is no doubt where the files land. The folder is created if it does not exist.'
            }
          >
            <input
              className="mono"
              type="text"
              value={targetDir}
              onChange={(e) => { setTargetDir(e.target.value); setPlan(null); }}
              placeholder="D:\\work\\my-playwright-repo"
              autoFocus
            />
          </Field>

          <Field label="Include">
            <div className="chip-row" style={{ gap: 12, marginTop: 4 }}>
              {kinds.map((kind) => (
                <label key={kind.id} className="row small" style={{ gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={include.includes(kind.id)} onChange={() => { toggle(kind.id); setPlan(null); }} />
                  <span>{kind.label} <span className="faint tiny">— {kind.hint}</span></span>
                </label>
              ))}
            </div>
          </Field>

          {error && <div className="small" style={{ color: 'var(--fail)', marginBottom: 12 }}>{error}</div>}

          {plan && (
            <>
              <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
                <Badge tone="pass">{plan.summary.create} new</Badge>
                {plan.summary.overwrite > 0 && <Badge tone="warn">{plan.summary.overwrite} overwrite</Badge>}
                {existing > 0 && <Badge>{existing} already exist</Badge>}
                {blockedCount > 0 && <Badge tone="fail">{blockedCount} blocked</Badge>}
                <span className="tiny faint mono">{plan.root}{plan.exists ? '' : ' (will be created)'}</span>
              </div>

              {existing > 0 && !overwrite && (
                <label className="row small" style={{ gap: 8, marginBottom: 12, color: 'var(--warn)' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={overwrite} onChange={(e) => { setOverwrite(e.target.checked); setPlan(null); }} />
                  {existing} file(s) already exist there. Tick to overwrite them — otherwise they are left untouched.
                </label>
              )}

              <div className="table-wrap" style={{ maxHeight: 300 }}>
                <table className="table">
                  <thead><tr><th style={{ width: 30 }} /><th>File</th><th style={{ width: 150 }}>What happens</th></tr></thead>
                  <tbody>
                    {plan.files.map((file) => (
                      <tr key={file.path}>
                        <td><Dot tone={STATUS_TONE[file.status]} /></td>
                        <td className="mono tiny">{file.path}<div className="faint">{file.reason || ''}</div></td>
                        <td><Badge tone={STATUS_TONE[file.status]}>{STATUS_LABEL[file.status]}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!plan && !error && (
            <div className="small faint">Nothing is written until you preview the plan and confirm it.</div>
          )}
        </>
      )}
    </Modal>
  );
}
