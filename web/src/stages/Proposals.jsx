import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Stat, Empty, Modal, Field, toneForSeverity } from '../lib/ui.jsx';

/**
 * The human gate. Agent Factory and Guardrail Designer only ever propose; nothing enters the graph
 * without an explicit accept, an edit, or a hand-written addition.
 */
export default function ProposalsStage({ project, reload, navigate, toast, kind }) {
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);

  const isAgents = kind === 'agents';
  const list = project.proposals?.[kind] || [];
  const accepted = list.filter((p) => p.decision === 'accepted');
  const rejected = list.filter((p) => p.decision === 'rejected');
  const pending = list.filter((p) => p.decision === 'proposed');

  if (!project.discovery) {
    return (
      <Card title={isAgents ? 'Agent Factory' : 'Guardrail Designer'}>
        <Empty icon="⌕" title="Run discovery first">
          <button className="btn primary" style={{ marginTop: 10 }} onClick={() => navigate('discovery')}>Go to discovery →</button>
        </Empty>
      </Card>
    );
  }

  async function decide(proposal, action, patch) {
    setBusy(proposal.proposalId);
    try {
      await api.decide(project.id, kind, proposal.proposalId, action, patch);
      await reload();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(null);
      setEditing(null);
    }
  }

  async function bulk(action, only) {
    try {
      await api.bulkDecide(project.id, kind, action, only);
      await reload();
      toast(`Bulk ${action} applied.`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Stat label="Proposed" value={list.length} sub={isAgents ? 'From capabilities' : 'From risks'} />
        <Stat label="Accepted" value={accepted.length} tone="pass" sub="Will be in the graph" />
        <Stat label="Awaiting you" value={pending.length} tone={pending.length ? 'warn' : ''} sub="Nothing runs until decided" />
        <Stat label="Rejected" value={rejected.length} sub="Left out on purpose" />
      </div>

      <Card
        title={isAgents ? 'Agent Factory proposals' : 'Guardrail Designer proposals'}
        sub={
          isAgents
            ? 'Registry-first: existing agents are reused, gaps are synthesised, and anything needing a real implementation is refused.'
            : 'Every guardrail here exists because discovery found a specific risk. The risk it covers is printed on it.'
        }
        right={
          <div className="row">
            {isAgents && <button className="btn sm" onClick={() => bulk('accept', 'reuse')}>Accept registry hits</button>}
            <button className="btn sm" onClick={() => bulk('accept')}>Accept all</button>
            <button className="btn sm" onClick={() => setCreating(true)}>+ Create your own</button>
            <button className="btn sm primary" disabled={!accepted.length} onClick={() => navigate(isAgents ? 'guardrails' : 'workflow')}>
              {isAgents ? 'Guardrails →' : 'Compose workflow →'}
            </button>
          </div>
        }
      >
        {list.length === 0 ? (
          <Empty icon="◇" title="Nothing proposed" />
        ) : (
          <div className="stack">
            {list.map((proposal) =>
              isAgents ? (
                <AgentCard key={proposal.proposalId} proposal={proposal} busy={busy === proposal.proposalId} onDecide={decide} onEdit={() => setEditing(proposal)} />
              ) : (
                <GuardrailCard key={proposal.proposalId} proposal={proposal} busy={busy === proposal.proposalId} onDecide={decide} onEdit={() => setEditing(proposal)} />
              ),
            )}
          </div>
        )}
      </Card>

      {editing && (
        <EditModal
          kind={kind}
          proposal={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => decide(editing, 'edit', patch)}
        />
      )}

      {creating && (
        <CreateModal
          kind={kind}
          onClose={() => setCreating(false)}
          onCreate={async (body) => {
            try {
              await api.addProposal(project.id, kind, body);
              await reload();
              setCreating(false);
              toast(`Added "${body.name}".`, 'ok');
            } catch (err) {
              toast(err.message, 'err');
            }
          }}
        />
      )}
    </>
  );
}

function Decision({ proposal, busy, onDecide, onEdit }) {
  return (
    <div className="proposal-actions">
      <button className="btn sm pass" disabled={busy || proposal.decision === 'accepted'} onClick={() => onDecide(proposal, 'accept')}>
        ✓ Accept
      </button>
      <button className="btn sm danger" disabled={busy || proposal.decision === 'rejected'} onClick={() => onDecide(proposal, 'reject')}>
        ✕ Reject
      </button>
      <button className="btn sm" disabled={busy} onClick={onEdit}>✎ Edit</button>
      <div className="spacer" />
      <Badge tone={proposal.decision === 'accepted' ? 'pass' : proposal.decision === 'rejected' ? 'fail' : 'warn'}>
        {proposal.decision}{proposal.edited ? ' · edited' : ''}
      </Badge>
    </div>
  );
}

function AgentCard({ proposal, busy, onDecide, onEdit }) {
  return (
    <div className={`proposal ${proposal.decision}`}>
      <div className="proposal-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 6, marginBottom: 5 }}>
            <strong style={{ fontSize: 13.5 }}>{proposal.name}</strong>
            <Badge tone={proposal.source === 'reuse' ? 'pass' : proposal.source === 'generated' ? 'warn' : 'accent'}>
              {proposal.source === 'reuse' ? 'reused from registry' : proposal.source === 'generated' ? 'generated for this project' : 'human-added'}
            </Badge>
            <Badge mono>{proposal.capability}</Badge>
            <Badge>{proposal.group}</Badge>
            {proposal.maturity && <Badge tone={proposal.maturity === 'proven' ? 'pass' : ''}>{proposal.maturity}</Badge>}
          </div>
          <div className="small muted">{proposal.description}</div>
        </div>
      </div>
      <div className="proposal-body">
        <div className="proposal-why">{proposal.rationale}</div>
        {proposal.warning && (
          <div className="small" style={{ color: 'var(--warn)', marginTop: 8 }}>▲ {proposal.warning}</div>
        )}
        <div className="row wrap small faint" style={{ marginTop: 9, gap: 14 }}>
          <span>in: <span className="mono">{(proposal.inputs || []).join(', ') || '—'}</span></span>
          <span>out: <span className="mono">{(proposal.outputs || []).join(', ') || '—'}</span></span>
          <span>impl: <span className="mono">{proposal.impl}</span></span>
        </div>
        {proposal.alternatives?.length > 0 && (
          <div className="tiny faint" style={{ marginTop: 6 }}>
            Alternatives in the registry: {proposal.alternatives.map((a) => a.name).join(', ')}
          </div>
        )}
      </div>
      <Decision proposal={proposal} busy={busy} onDecide={onDecide} onEdit={onEdit} />
    </div>
  );
}

function GuardrailCard({ proposal, busy, onDecide, onEdit }) {
  return (
    <div className={`proposal ${proposal.decision}`}>
      <div className="proposal-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 6, marginBottom: 5 }}>
            <strong style={{ fontSize: 13.5 }}>{proposal.name}</strong>
            <Badge tone={toneForSeverity(proposal.severity)}>{proposal.severity}</Badge>
            <Badge mono>{proposal.check}</Badge>
            {proposal.source === 'generated' && <Badge tone="warn">no automated check</Badge>}
          </div>
          <div className="small muted">{proposal.description}</div>
        </div>
      </div>
      <div className="proposal-body">
        <div className="proposal-why">{proposal.rationale}</div>
        <div className="row wrap small faint" style={{ marginTop: 9, gap: 14 }}>
          <span>covers: <span className="mono">{(proposal.risks || []).join(', ')}</span></span>
          {Object.keys(proposal.params || {}).length > 0 && (
            <span>params: <span className="mono">{JSON.stringify(proposal.params)}</span></span>
          )}
        </div>
      </div>
      <Decision proposal={proposal} busy={busy} onDecide={onDecide} onEdit={onEdit} />
    </div>
  );
}

function EditModal({ kind, proposal, onClose, onSave }) {
  const [form, setForm] = useState({
    name: proposal.name,
    description: proposal.description,
    params: JSON.stringify(proposal.params || {}, null, 2),
    severity: proposal.severity,
    impl: proposal.impl,
  });
  const isAgents = kind === 'agents';

  return (
    <Modal
      title={`Edit "${proposal.name}"`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            onClick={() => {
              const patch = { name: form.name, description: form.description };
              if (isAgents) patch.impl = form.impl;
              else {
                patch.severity = form.severity;
                try {
                  patch.params = JSON.parse(form.params);
                } catch {
                  patch.params = proposal.params;
                }
              }
              onSave(patch);
            }}
          >
            Save &amp; accept
          </button>
        </>
      }
    >
      <Field label="Name"><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <Field label="Description"><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      {isAgents ? (
        <Field label="Implementation" hint="An unknown name falls back to the generic adapter, and the run report says so.">
          <input className="mono" type="text" value={form.impl} onChange={(e) => setForm({ ...form, impl: e.target.value })} />
        </Field>
      ) : (
        <>
          <Field label="Severity">
            <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
              <option value="blocker">blocker</option>
              <option value="major">major</option>
              <option value="minor">minor</option>
            </select>
          </Field>
          <Field label="Params (JSON)" hint="e.g. thresholds and tolerances used by the check.">
            <textarea className="mono" rows={5} value={form.params} onChange={(e) => setForm({ ...form, params: e.target.value })} />
          </Field>
        </>
      )}
      <div className="small faint">Editing marks the proposal accepted and records the change on the project trail.</div>
    </Modal>
  );
}

function CreateModal({ kind, onClose, onCreate }) {
  const isAgents = kind === 'agents';
  const [form, setForm] = useState(
    isAgents
      ? { name: '', capability: '', description: '', impl: 'genericAdapter', phase: 25, saveToRegistry: true }
      : { name: '', description: '', severity: 'major', check: 'manualSignOff', saveToRegistry: true },
  );

  return (
    <Modal
      title={isAgents ? 'Create your own agent' : 'Create your own guardrail'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!form.name.trim()} onClick={() => onCreate(form)}>Add</button>
        </>
      }
    >
      <Field label="Name"><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
      <Field label="Description"><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>

      {isAgents ? (
        <div className="grid cols-2">
          <Field label="Capability" hint="e.g. mapping.command.custom">
            <input className="mono" type="text" value={form.capability} onChange={(e) => setForm({ ...form, capability: e.target.value })} />
          </Field>
          <Field label="Phase" hint="10 analyse · 20 prepare · 30 generate · 40 trace · 50 validate">
            <input type="number" value={form.phase} onChange={(e) => setForm({ ...form, phase: Number(e.target.value) })} />
          </Field>
        </div>
      ) : (
        <div className="grid cols-2">
          <Field label="Severity">
            <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
              <option value="blocker">blocker</option>
              <option value="major">major</option>
              <option value="minor">minor</option>
            </select>
          </Field>
          <Field label="Check" hint="manualSignOff forces a human decision.">
            <input className="mono" type="text" value={form.check} onChange={(e) => setForm({ ...form, check: e.target.value })} />
          </Field>
        </div>
      )}

      <label className="row small" style={{ gap: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.saveToRegistry} onChange={(e) => setForm({ ...form, saveToRegistry: e.target.checked })} />
        Also save to the registry so future projects can reuse it
      </label>
    </Modal>
  );
}
