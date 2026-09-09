import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Modal, Field, Stat, useToast, toneForSeverity } from '../lib/ui.jsx';

export default function Registry() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('agents');
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const load = () => api.registry().then(setData).catch((err) => toast(err.message, 'err'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="page"><span className="muted">Loading registries…</span></div>;

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Registries</b></div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>+ Add {tab === 'agents' ? 'agent' : 'guardrail'}</button>
      </div>

      <div className="page">
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <Stat label="Agents" value={data.agents.length} tone="accent" sub={`${data.agents.filter((a) => a.source === 'user').length} added by you`} />
          <Stat label="Guardrails" value={data.guardrails.length} sub={`${data.guardrails.filter((g) => g.source === 'user').length} added by you`} />
          <Stat label="Technology profiles" value={data.technologies.length} sub="Used to classify a stack" />
          <Stat label="Checks available" value={data.checks.length} sub="Implemented validators" />
        </div>

        <div className="row" style={{ marginBottom: 12 }}>
          {['agents', 'guardrails', 'technologies'].map((key) => (
            <button key={key} className={`btn sm ${tab === key ? 'primary' : ''}`} onClick={() => setTab(key)}>
              {key[0].toUpperCase() + key.slice(1)}
            </button>
          ))}
        </div>

        {tab === 'agents' && (
          <Card
            title="Agent registry"
            sub="The Agent Factory searches here before proposing anything new. Add one and the next discovery can reuse it."
            tight
          >
            <table className="table">
              <thead><tr><th>Agent</th><th>Capability</th><th>Implementation</th><th>Maturity</th><th>Outputs</th><th /></tr></thead>
              <tbody>
                {data.agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{agent.name}</div>
                      <div className="tiny muted" style={{ maxWidth: 460 }}>{agent.description}</div>
                    </td>
                    <td className="mono tiny">{agent.capability}</td>
                    <td className="mono tiny">
                      {agent.impl}
                      {!data.impls.includes(agent.impl) && <div><Badge tone="warn">falls back to generic</Badge></div>}
                    </td>
                    <td><Badge tone={agent.maturity === 'proven' ? 'pass' : agent.maturity === 'beta' ? 'warn' : ''}>{agent.maturity}</Badge></td>
                    <td className="tiny mono">{(agent.outputs || []).join(', ')}</td>
                    <td>
                      {agent.source === 'user' && (
                        <button className="btn ghost sm" onClick={async () => { await api.deleteAgent(agent.id); load(); }}>✕</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {tab === 'guardrails' && (
          <Card title="Guardrail registry" sub="Matched to discovered risks. A guardrail with no implemented check can only warn." tight>
            <table className="table">
              <thead><tr><th>Guardrail</th><th>Covers risks</th><th>Severity</th><th>Check</th><th>Params</th><th /></tr></thead>
              <tbody>
                {data.guardrails.map((guardrail) => (
                  <tr key={guardrail.id}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{guardrail.name}</div>
                      <div className="tiny muted" style={{ maxWidth: 420 }}>{guardrail.description}</div>
                    </td>
                    <td className="tiny mono">{(guardrail.risks || []).join(', ')}</td>
                    <td><Badge tone={toneForSeverity(guardrail.severity)}>{guardrail.severity}</Badge></td>
                    <td className="mono tiny">
                      {guardrail.check}
                      {!data.checks.includes(guardrail.check) && <div><Badge tone="warn">no implementation</Badge></div>}
                    </td>
                    <td className="tiny mono">{JSON.stringify(guardrail.params || {})}</td>
                    <td>
                      {guardrail.source === 'user' && (
                        <button className="btn ghost sm" onClick={async () => { await api.deleteGuardrail(guardrail.id); load(); }}>✕</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {tab === 'technologies' && (
          <Card title="Technology profiles" sub="How a free-text stack description becomes a parser or an emitter." tight>
            <table className="table">
              <thead><tr><th>Profile</th><th>Language</th><th>Kind</th><th>Can analyse</th><th>Can generate</th><th>Recognised by</th></tr></thead>
              <tbody>
                {data.technologies.map((tech) => (
                  <tr key={tech.id}>
                    <td><div style={{ fontWeight: 550 }}>{tech.label}</div><div className="tiny faint mono">{tech.id}</div></td>
                    <td className="mono tiny">{tech.language}</td>
                    <td className="tiny">{tech.kind}</td>
                    <td>{tech.analyzeCapability ? <Badge tone="pass">yes</Badge> : <span className="faint tiny">—</span>}</td>
                    <td>{tech.generateCapability ? <Badge tone="pass">yes</Badge> : <span className="faint tiny">—</span>}</td>
                    <td className="tiny faint">{tech.keywords.slice(0, 3).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {creating && (
        <AddModal
          kind={tab === 'guardrails' ? 'guardrails' : 'agents'}
          impls={data.impls}
          checks={data.checks}
          onClose={() => setCreating(false)}
          onSave={async (body) => {
            try {
              if (tab === 'guardrails') await api.addGuardrail(body);
              else await api.addAgent(body);
              await load();
              setCreating(false);
              toast('Added to the registry.', 'ok');
            } catch (err) {
              toast(err.message, 'err');
            }
          }}
        />
      )}
    </>
  );
}

function AddModal({ kind, impls, checks, onClose, onSave }) {
  const isAgents = kind === 'agents';
  const [form, setForm] = useState(
    isAgents
      ? { name: '', capability: '', description: '', impl: 'genericAdapter', maturity: 'custom' }
      : { name: '', risks: 'risk.custom', description: '', check: 'manualSignOff', severity: 'major' },
  );

  return (
    <Modal
      title={isAgents ? 'Add an agent to the registry' : 'Add a guardrail to the registry'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!form.name.trim() || (isAgents && !form.capability.trim())}
            onClick={() => onSave(isAgents ? form : { ...form, risks: form.risks.split(',').map((r) => r.trim()).filter(Boolean) })}
          >
            Save
          </button>
        </>
      }
    >
      <Field label="Name"><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
      <Field label="Description"><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>

      {isAgents ? (
        <>
          <Field label="Capability" hint="Discovery emits capability ids; this is how the factory finds your agent.">
            <input className="mono" type="text" value={form.capability} onChange={(e) => setForm({ ...form, capability: e.target.value })} placeholder="source.analyze.my-framework" />
          </Field>
          <Field label="Implementation" hint="Pick an implemented function, or leave the generic adapter and build it later.">
            <select value={form.impl} onChange={(e) => setForm({ ...form, impl: e.target.value })}>
              {impls.map((impl) => <option key={impl} value={impl}>{impl}</option>)}
            </select>
          </Field>
        </>
      ) : (
        <>
          <Field label="Risks covered" hint="Comma separated risk ids, e.g. risk.data-loss">
            <input className="mono" type="text" value={form.risks} onChange={(e) => setForm({ ...form, risks: e.target.value })} />
          </Field>
          <div className="grid cols-2">
            <Field label="Severity">
              <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                <option value="blocker">blocker</option><option value="major">major</option><option value="minor">minor</option>
              </select>
            </Field>
            <Field label="Check">
              <select value={form.check} onChange={(e) => setForm({ ...form, check: e.target.value })}>
                {checks.map((check) => <option key={check} value={check}>{check}</option>)}
              </select>
            </Field>
          </div>
        </>
      )}
    </Modal>
  );
}
