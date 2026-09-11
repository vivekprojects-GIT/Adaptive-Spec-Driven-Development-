import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

/* --------------------------------------------------------------- toasts */

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list, { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === 'err' ? 7000 : 3800);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>{toast.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------------------------------------------------------- atoms */

export function Card({ title, sub, right, children, tight, className = '' }) {
  return (
    <div className={`card ${className}`}>
      {(title || right) && (
        <div className="card-head">
          {title && (
            <div>
              <h3>{title}</h3>
              {sub && <div className="card-sub">{sub}</div>}
            </div>
          )}
          <div className="spacer" />
          {right}
        </div>
      )}
      <div className={`card-body ${tight ? 'tight' : ''}`}>{children}</div>
    </div>
  );
}

export function Badge({ tone = '', mono, children }) {
  return <span className={`badge ${tone} ${mono ? 'mono' : ''}`}>{children}</span>;
}

export function Dot({ tone = '', pulse }) {
  return <span className={`dot ${tone} ${pulse ? 'pulse' : ''}`} />;
}

export function Stat({ label, value, sub, tone = '' }) {
  return (
    <div className={`stat ${tone}`}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

export function Bar({ value, max = 100, tone = '' }) {
  const pct = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`bar ${tone}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ icon = '◇', title, children }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div style={{ color: 'var(--text-dim)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      {label && <span className="lbl">{label}</span>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 'min(940px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

/* --------------------------------------------------------------- helpers */

export const toneForStatus = (status) =>
  ({
    pass: 'pass', warn: 'warn', fail: 'fail', done: 'pass', running: 'info', queued: 'info', failed: 'fail', pending: '',
    reused: 'info', skipped: 'warn', halted: 'fail', completed: 'pass', 'completed-with-errors': 'fail', waiting: 'warn', submitted: 'info',
    migrated: 'pass', orphan: 'fail', partial: 'warn', 'not-migrated': 'fail',
    built: 'pass', planned: 'warn', specified: 'warn', missing: 'fail',
  }[status] || '');

export const toneForVerdict = (verdict) =>
  ({ passed: 'pass', 'passed-with-warnings': 'warn', 'failed-checks': 'fail', blocked: 'fail' }[verdict] || '');

export const toneForSeverity = (severity) => ({ blocker: 'fail', major: 'warn', minor: 'info' }[severity] || '');

export function shortTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function relTime(iso) {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Copy helper used by artifact and report views. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
