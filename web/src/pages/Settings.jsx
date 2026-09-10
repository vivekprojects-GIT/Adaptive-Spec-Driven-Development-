import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Field, useToast, Spinner } from '../lib/ui.jsx';

export default function Settings({ onSaved }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const toast = useToast();

  useEffect(() => {
    api.settings().then((next) => {
      setData(next);
      setForm(next.settings);
    }).catch((err) => toast(err.message, 'err'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [bmad, setBmad] = useState(null);
  const [bmadRoot, setBmadRoot] = useState('');
  const [bridge, setBridge] = useState(null);

  const loadBmadInfo = async (reload = false) => {
    try {
      setBmad(await api.bmad(reload));
    } catch (err) {
      setBmad({ found: false, error: err.message, searched: [] });
    }
  };

  useEffect(() => {
    loadBmadInfo();
  }, []);

  // The editor bridge comes and goes as VS Code starts and stops the MCP server — keep it live.
  useEffect(() => {
    let alive = true;
    const tick = () => api.bridgeStatus().then((next) => alive && setBridge(next)).catch(() => {});
    tick();
    const timer = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (form) setBmadRoot(form.bmadRoot || '');
  }, [form?.bmadRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form) return <div className="page"><span className="muted">Loading settings…</span></div>;

  async function save(patch) {
    const next = { ...form, ...patch };
    setForm(next);
    try {
      const saved = await api.saveSettings(patch);
      setData({ ...data, settings: saved.settings, status: saved.status });
      setForm(saved.settings);
      onSaved?.();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function testConnection() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.testLlm());
    } catch (err) {
      setResult({ ok: false, detail: err.message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Settings</b></div>
        <div className="spacer" />
        <Badge tone={data.status.mode === 'llm' ? 'accent' : data.status.mode === 'offline' ? '' : 'info'}>{data.status.mode}</Badge>
      </div>

      <div className="page">
        <div className="grid cols-2">
          <Card title="Model" sub="Everything works with no model at all. A model only adds assistance on top of the rule engine.">
            <Field label="Model selection">
              <select value={form.model} onChange={(e) => save({ model: e.target.value })}>
                {data.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
            </Field>
            <div className="small muted" style={{ marginBottom: 14 }}>
              {data.models.find((m) => m.id === form.model)?.description}
            </div>

            {form.model === 'auto' && (
              <div className="card" style={{ background: 'var(--bg-sunken)' }}>
                <div className="card-body">
                  <div className="tiny faint" style={{ letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Auto routing</div>
                  <div className="kv">
                    {Object.entries(data.autoRoutes).map(([task, model]) => (
                      <React.Fragment key={task}>
                        <div className="k mono">{task}</div>
                        <div className="v mono">{model}</div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <label className="row small" style={{ gap: 8, marginTop: 14 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.llmAssist} onChange={(e) => save({ llmAssist: e.target.checked })} />
              Use the model to add project-specific interview questions and richer rationales
            </label>
          </Card>

          <Card title="API key" sub="Stored in server/data/settings.json on this machine. It is never sent anywhere except Anthropic.">
            <Field label="Anthropic API key" hint={data.envKeyPresent ? 'ANTHROPIC_API_KEY is set in the environment and will be used if this is blank.' : 'No ANTHROPIC_API_KEY in the environment.'}>
              <input
                type="password"
                value={form.apiKey || ''}
                placeholder={data.envKeyPresent ? 'using the environment variable' : 'sk-ant-…'}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                onBlur={(e) => e.target.value !== '••••••••' && save({ apiKey: e.target.value })}
              />
            </Field>

            <label className="row small" style={{ gap: 8, marginBottom: 14 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.useEnvKey} onChange={(e) => save({ useEnvKey: e.target.checked })} />
              Fall back to ANTHROPIC_API_KEY from the environment
            </label>

            <div className="row">
              <button className="btn" disabled={testing} onClick={testConnection}>{testing ? <><Spinner /> Testing…</> : 'Test connection'}</button>
              {result && <Badge tone={result.ok ? 'pass' : 'fail'}>{result.ok ? 'reachable' : 'failed'}</Badge>}
            </div>
            {result && <div className="small muted break" style={{ marginTop: 8 }}>{result.detail}</div>}

            <div className="proposal-why" style={{ marginTop: 14 }}>
              {data.status.detail}
            </div>
          </Card>
        </div>

        <div className="grid cols-2" style={{ marginTop: 14, marginBottom: 14 }}>
          <Card
            title="Your BMAD install"
            sub="ASDD runs on your existing BMAD agents and workflows — read in place, with your team's customisations."
            right={bmad ? <Badge tone={bmad.found ? 'pass' : 'warn'}>{bmad.found ? `v${bmad.version}` : 'not found'}</Badge> : <Badge>reading…</Badge>}
          >
            {!bmad ? (
              <div className="small muted" style={{ marginBottom: 12 }}>Reading your BMAD install…</div>
            ) : bmad.found ? (
              <>
                <div className="kv" style={{ marginBottom: 12 }}>
                  <div className="k">Folder</div>
                  <div className="v mono tiny">{bmad.root}</div>
                  <div className="k">Agents</div>
                  <div className="v">{bmad.agents.map((a) => `${a.icon} ${a.name}`).join('  ·  ')}</div>
                  <div className="k">Workflows</div>
                  <div className="v">{bmad.workflows.length} ({bmad.deprecated} deprecated shims skipped)</div>
                  {bmad.user && (
                    <>
                      <div className="k">BMAD user</div>
                      <div className="v">{bmad.user}</div>
                    </>
                  )}
                </div>
                {bmad.agents.some((a) => a.overrides.length > 1) && (
                  <div className="small muted" style={{ marginBottom: 10 }}>
                    Customised:{' '}
                    {bmad.agents
                      .filter((a) => a.overrides.length > 1)
                      .map((a) => `${a.name} (${a.overrides.filter((o) => o !== 'base').join(' + ')})`)
                      .join(', ')}
                  </div>
                )}
                {bmad.problems?.length > 0 && (
                  <div className="small" style={{ color: 'var(--warn)', marginBottom: 10 }}>{bmad.problems.join(' · ')}</div>
                )}
              </>
            ) : (
              <div className="small muted" style={{ marginBottom: 12 }}>
                No BMAD install found{bmad?.searched?.length ? ` — looked in ${bmad.searched.join(', ')}` : ''}. Point this at the folder that contains{' '}
                <span className="mono">_bmad/</span>.
              </div>
            )}
            <Field label="BMAD folder" hint="Blank = the folder ASDD is cloned into. It must contain _bmad/_config/skill-manifest.csv.">
              <input className="mono" type="text" value={bmadRoot} placeholder={'D:\\Vivek\\Desktop\\BMAD_AGENTS'} onChange={(e) => setBmadRoot(e.target.value)} />
            </Field>
            <div className="row">
              <button
                className="btn"
                onClick={async () => {
                  await save({ bmadRoot: bmadRoot.trim() });
                  await loadBmadInfo(true);
                }}
              >
                Save &amp; reload
              </button>
              <button className="btn ghost" onClick={() => loadBmadInfo(true)}>↻ Re-read install</button>
            </div>
          </Card>

          <Card
            title="Copilot through VS Code"
            sub="No API key: ASDD borrows your editor's model through its MCP server, using MCP sampling."
            right={
              <Badge tone={bridge?.usable ? 'pass' : bridge?.connected ? 'warn' : ''}>
                {bridge?.usable ? 'connected' : bridge?.connected ? 'no sampling' : 'not connected'}
              </Badge>
            }
          >
            <div className="proposal-why" style={{ marginBottom: 12 }}>{bridge?.detail || 'Checking…'}</div>
            {bridge?.usable && (
              <div className="kv" style={{ marginBottom: 12 }}>
                <div className="k">Client</div>
                <div className="v">{bridge.client?.name} {bridge.client?.version}</div>
                <div className="k">Requests</div>
                <div className="v mono">
                  {bridge.served} served · {bridge.failed} failed · {bridge.timedOut} timed out
                </div>
              </div>
            )}
            <ol className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
              <li>
                Keep <span className="mono">npm run dev</span> running.
              </li>
              <li>
                Open this folder in VS Code — <span className="mono">.vscode/mcp.json</span> registers the <b>asdd</b> server.
              </li>
              <li>Start it from the MCP servers view, and allow it to use your models when VS Code asks.</li>
              <li>
                Set the model above to <b>Auto</b> or <b>Copilot</b>.
              </li>
            </ol>
          </Card>
        </div>

        <Card title="Behaviour" sub="How much the control plane does before it asks you.">
          <div className="grid cols-2">
            <Field label="Maximum interview questions" hint="Caps how many questions a single assessment can put in front of you.">
              <input type="number" min={3} max={20} value={form.maxQuestions} onChange={(e) => save({ maxQuestions: Number(e.target.value) })} />
            </Field>
            <Field label="Temperature" hint="0 keeps model-assisted output reproducible. Only used when a model is selected.">
              <input type="number" min={0} max={1} step={0.1} value={form.temperature} onChange={(e) => save({ temperature: Number(e.target.value) })} />
            </Field>
          </div>
        </Card>

        <Card title="How offline mode behaves" sub="What you still get with no key at all.">
          <ul className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
            <li>Source parsing, code generation, data migration and every guardrail check are deterministic — they never call a model.</li>
            <li>The requirements interview still runs; it asks the rule-engine questions and skips the model-authored extras.</li>
            <li>Discovery still classifies technologies, counts entities and raises risks and gaps.</li>
            <li>Adding a key changes nothing about correctness — it adds project-specific questions and richer explanations.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
