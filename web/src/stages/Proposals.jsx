import React, { useEffect, useState } from 'react';
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
  const [options, setOptions] = useState({ inputSources: [], onFailureOptions: [] });

  useEffect(() => {
    api.registry().then(setOptions).catch(() => {});
  }, []);

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
            {project.spec?.projectKind === 'build' && (
              <button className="btn sm primary" onClick={() => navigate('workflow')}>See the whole plan →</button>
            )}
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
          accepted={(project.proposals?.agents || []).filter((a) => a.decision === 'accepted')}
          options={options}
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
            <Badge tone={['reuse', 'bmad', 'asdd'].includes(proposal.source) ? 'pass' : proposal.source === 'generated' ? 'warn' : 'accent'}>
              {proposal.source === 'bmad'
                ? `${proposal.icon || ''} your ASDD persona`
                : proposal.source === 'asdd'
                  ? 'built into ASDD'
                  : proposal.source === 'reuse'
                  ? 'reused from registry'
                  : proposal.source === 'generated'
                    ? 'generated for this project'
                    : 'human-added'}
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
        {proposal.authored?.instructions && (
          <details style={{ marginTop: 9 }}>
            <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>
              Instructions this agent will execute
            </summary>
            <pre className="code" style={{ marginTop: 8, maxHeight: 220, whiteSpace: 'pre-wrap' }}>{proposal.authored.instructions}</pre>
            <div className="tiny faint" style={{ marginTop: 6 }}>
              Runs {proposal.authored.runAfterLabel || `in phase ${proposal.phase}`} · reads{' '}
              {(proposal.authored.inputSelections || []).join(', ') || 'nothing selected'}
              {proposal.authored.outputDescription ? ` · returns ${proposal.authored.outputDescription}` : ''}
            </div>
          </details>
        )}
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
        {proposal.rule && (
          <div className="small" style={{ marginTop: 9 }}>
            <span className="faint">rule: </span>“{proposal.rule}”
          </div>
        )}
        <div className="row wrap small faint" style={{ marginTop: 9, gap: 14 }}>
          <span>covers: <span className="mono">{(proposal.risks || []).join(', ')}</span></span>
          <span>
            applies to: <b>{proposal.appliesToLabel || (proposal.appliesTo && proposal.appliesTo !== 'workflow' ? proposal.appliesTo : 'the whole workflow')}</b>
          </span>
          <span>
            on failure:{' '}
            <b style={{ color: proposal.onFailure === 'stop' ? 'var(--fail)' : undefined }}>
              {proposal.onFailure === 'stop' ? 'stop and request review' : proposal.onFailure === 'continue' ? 'record only' : 'flag and carry on'}
            </b>
          </span>
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

/**
 * "Create my own" — the human authors the agent or the guardrail in full: purpose, inputs,
 * output, instructions, and where it runs. An agent with instructions is executed by the
 * instruction agent, not filed as a note.
 */
function CreateModal({ kind, onClose, onCreate, accepted, options }) {
  const isAgents = kind === 'agents';
  const [form, setForm] = useState(
    isAgents
      ? {
          name: '',
          purpose: '',
          inputSelections: ['requirements', 'artifacts'],
          artifactFilter: '',
          outputDescription: '',
          instructions: '',
          runAfter: 'end',
          capability: '',
          saveToRegistry: true,
        }
      : {
          name: '',
          rule: '',
          severity: 'blocker',
          appliesTo: 'workflow',
          onFailure: 'stop',
          saveToRegistry: true,
        },
  );

  const bmadAgents = (options.agents || []).filter((agent) => agent.source === 'bmad');

  const toggleInput = (id) =>
    setForm((prev) => ({
      ...prev,
      inputSelections: prev.inputSelections.includes(id)
        ? prev.inputSelections.filter((x) => x !== id)
        : [...prev.inputSelections, id],
    }));

  const runAfterChoices = [
    { value: 'start', label: 'Before everything else' },
    ...accepted.map((agent) => ({ value: agent.agentId, label: `After ${agent.name}` })),
    { value: 'end', label: 'At the very end' },
  ];

  const canSave = form.name.trim() && (isAgents ? true : form.rule.trim());

  return (
    <Modal
      title={isAgents ? 'Create agent' : 'Create guardrail'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canSave} onClick={() => onCreate({ ...form, appliesToLabel: labelFor(form.appliesTo, accepted) })}>
            {isAgents ? 'Save agent' : 'Save guardrail'}
          </button>
        </>
      }
    >
      {isAgents ? (
        <>
          {bmadAgents.length > 0 && (
            <Field
              label="Start from one of your ASDD personas"
              hint="Runs as that persona — its principles and your team's customisations are loaded from your persona library at run time."
            >
              <div className="chip-row" style={{ gap: 8, marginTop: 4 }}>
                {bmadAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className={`btn sm ${form.agentId === agent.id ? 'primary' : ''}`}
                    onClick={() =>
                      setForm((prev) =>
                        prev.agentId === agent.id
                          ? { ...prev, agentId: undefined, name: '', purpose: '' }
                          : { ...prev, agentId: agent.id, name: agent.name, purpose: agent.description, capability: '' },
                      )
                    }
                  >
                    {agent.icon} {agent.name.split(' — ')[0]}
                  </button>
                ))}
              </div>
            </Field>
          )}

          <Field label="Name">
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Database Validation Agent" autoFocus />
          </Field>

          {form.agentId && (
            <div className="proposal-why" style={{ marginBottom: 12 }}>
              Runs as your ASDD persona. Leave <b>Instructions</b> blank to give it its default review task for this role, or write the task you want done.
            </div>
          )}

          <Field label="Purpose" hint="One line. It becomes the agent's description everywhere it appears.">
            <input type="text" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} placeholder="Validate database checks carried over from Selenium" />
          </Field>

          <Field label="Input" hint="Exactly what this agent gets to read. Nothing else reaches it.">
            <div className="chip-row" style={{ gap: 10, marginTop: 4 }}>
              {(options.inputSources || []).map((source) => (
                <label key={source.id} className="row small" style={{ gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={form.inputSelections.includes(source.id)}
                    onChange={() => toggleInput(source.id)}
                  />
                  {source.label}
                </label>
              ))}
            </div>
          </Field>

          {form.inputSelections.includes('artifacts') && (
            <Field label="Limit source artifacts to these file types" hint="Comma separated, e.g. java, xml, xlsx. Leave blank for every file.">
              <input className="mono" type="text" value={form.artifactFilter} onChange={(e) => setForm({ ...form, artifactFilter: e.target.value })} placeholder="java, xml, csv" />
            </Field>
          )}

          <Field label="Output" hint="What this agent should hand back.">
            <input type="text" value={form.outputDescription} onChange={(e) => setForm({ ...form, outputDescription: e.target.value })} placeholder="DB validation Playwright steps" />
          </Field>

          <Field label="Instructions" hint="Written as you would brief a colleague. With a model configured these are executed; without one the agent writes the resolved brief and says it did not run.">
            <textarea
              rows={6}
              value={form.instructions}
              onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              placeholder="Preserve every database assertion from the source. For each one, emit a Playwright step that queries the same table and asserts the same expected value. If a query cannot be translated, emit a failing test naming the original SQL."
            />
          </Field>

          <div className="grid cols-2">
            <Field label="When should it run?">
              <select value={form.runAfter} onChange={(e) => setForm({ ...form, runAfter: e.target.value })}>
                {runAfterChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            </Field>
            <Field label="Capability id" hint="Optional. Give it one and future projects can reuse this agent by capability.">
              <input className="mono" type="text" value={form.capability} onChange={(e) => setForm({ ...form, capability: e.target.value })} placeholder="custom.db-validation" />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Name">
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Database Assertion Preservation" autoFocus />
          </Field>

          <Field label="Rule" hint="Plain English. With a model configured this is evaluated against the artifacts in scope; without one it becomes a required human sign-off.">
            <textarea
              rows={4}
              value={form.rule}
              onChange={(e) => setForm({ ...form, rule: e.target.value })}
              placeholder="Every DB assertion from the Selenium suite must map to a Playwright validation or be explicitly flagged."
            />
          </Field>

          <div className="grid cols-2">
            <Field label="Severity">
              <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                <option value="blocker">Blocker</option>
                <option value="major">Major</option>
                <option value="minor">Minor</option>
              </select>
            </Field>
            <Field label="Applies to">
              <select value={form.appliesTo} onChange={(e) => setForm({ ...form, appliesTo: e.target.value })}>
                <option value="workflow">The whole workflow</option>
                {accepted.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.name}</option>)}
              </select>
            </Field>
          </div>

          <Field label="On failure" hint="“Stop” halts the run at that agent — later agents are skipped and the run waits for review.">
            <select value={form.onFailure} onChange={(e) => setForm({ ...form, onFailure: e.target.value })}>
              {(options.onFailureOptions || []).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>

          {form.appliesTo !== 'workflow' && form.onFailure === 'stop' && (
            <div className="proposal-why" style={{ marginBottom: 12 }}>
              This rule runs the moment <b>{labelFor(form.appliesTo, accepted)}</b> finishes. If it fails, the
              workflow stops there rather than carrying on and reporting the problem afterwards.
            </div>
          )}
        </>
      )}

      <label className="row small" style={{ gap: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.saveToRegistry} onChange={(e) => setForm({ ...form, saveToRegistry: e.target.checked })} />
        Also save to the registry so future projects can reuse it
      </label>
    </Modal>
  );
}

function labelFor(appliesTo, accepted) {
  if (!appliesTo || appliesTo === 'workflow') return 'The whole workflow';
  return accepted.find((agent) => agent.agentId === appliesTo)?.name || appliesTo;
}
