import React, { useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Badge, Field, Empty, Modal } from '../lib/ui.jsx';

export default function SpecStage({ project, reload, navigate, toast }) {
  const [spec, setSpec] = useState(project.spec);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [pasting, setPasting] = useState(false);
  const fileInput = useRef(null);

  const dirty = JSON.stringify({ ...spec, artifacts: undefined }) !== JSON.stringify({ ...project.spec, artifacts: undefined });

  async function save() {
    setSaving(true);
    try {
      await api.saveSpec(project.id, {
        requirements: spec.requirements,
        sourceStack: spec.sourceStack,
        targetStack: spec.targetStack,
        constraints: spec.constraints,
      });
      await reload();
      toast('Spec saved.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setSaving(false);
    }
  }

  async function onFiles(event) {
    const files = [...(event.target.files || [])];
    if (!files.length) return;
    try {
      const payload = await Promise.all(
        files.map(async (file) => ({ path: file.webkitRelativePath || file.name, content: await file.text() })),
      );
      await api.addArtifacts(project.id, payload);
      await reload();
      toast(`Added ${payload.length} file(s).`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      event.target.value = '';
    }
  }

  async function saveAndContinue() {
    if (dirty) await save();
    navigate('interview');
  }

  return (
    <>
      <div className="grid cols-2">
        <div>
          <Card title="1 · The spec" sub="Requirements, source, target. Everything downstream is derived from this.">
            <div className="grid cols-2">
              <Field label="Source stack" hint="Free text — the platform matches it against its technology profiles.">
                <input type="text" value={spec.sourceStack || ''} onChange={(e) => setSpec({ ...spec, sourceStack: e.target.value })} placeholder="Selenium WebDriver (Java) with TestNG" />
              </Field>
              <Field label="Target stack" hint="Name the language too — Playwright TS and Playwright Python are different emitters.">
                <input type="text" value={spec.targetStack || ''} onChange={(e) => setSpec({ ...spec, targetStack: e.target.value })} placeholder="Playwright (TypeScript)" />
              </Field>
            </div>

            <Field label="Requirements" hint="One per line. IDs like REQ-001 are picked up and used in the traceability matrix.">
              <textarea
                className="mono"
                rows={9}
                value={spec.requirements || ''}
                onChange={(e) => setSpec({ ...spec, requirements: e.target.value })}
                placeholder={'REQ-001 A shopper can log in with valid credentials\nREQ-002 An invalid password shows an inline error'}
              />
            </Field>

            <Field label="Constraints" hint="CI, security, deadlines, anything the migration must respect.">
              <textarea rows={3} value={spec.constraints || ''} onChange={(e) => setSpec({ ...spec, constraints: e.target.value })} />
            </Field>

            <div className="row">
              <button className="btn" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : dirty ? 'Save spec' : 'Saved'}</button>
              <div className="spacer" />
              <button className="btn primary" onClick={saveAndContinue}>Continue to interview →</button>
            </div>
          </Card>
        </div>

        <div>
          <Card
            title="2 · Source artifacts"
            sub="Test classes, specs, collections, fixtures. These are parsed, not just attached."
            right={<Badge mono>{(project.spec.artifacts || []).length}</Badge>}
            tight
          >
            <div style={{ padding: 12, borderBottom: '1px solid var(--line-soft)' }} className="row">
              <button className="btn sm" onClick={() => fileInput.current?.click()}>⬆ Upload files</button>
              <button className="btn sm" onClick={() => setPasting(true)}>✎ Paste code</button>
              <input ref={fileInput} type="file" multiple hidden onChange={onFiles} />
            </div>

            {(project.spec.artifacts || []).length === 0 ? (
              <Empty icon="⌸" title="No artifacts yet">
                <div className="small">Without source files a run can only produce scaffolding.</div>
              </Empty>
            ) : (
              <div style={{ maxHeight: 470, overflowY: 'auto' }}>
                {(project.spec.artifacts || []).map((artifact) => (
                  <div key={artifact.id} className="file-item" onClick={() => setViewing(artifact)}>
                    <div className="row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="p">{artifact.path}</div>
                        <div className="m">{artifact.bytes} bytes · {artifact.content.split('\n').length} lines</div>
                      </div>
                      <button
                        className="btn ghost sm"
                        onClick={async (event) => {
                          event.stopPropagation();
                          await api.removeArtifact(project.id, artifact.id);
                          await reload();
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {viewing && (
        <Modal title={viewing.path} onClose={() => setViewing(null)} wide>
          <pre className="code">{viewing.content}</pre>
        </Modal>
      )}

      {pasting && (
        <PasteModal
          onClose={() => setPasting(false)}
          onAdd={async (path, content) => {
            await api.addArtifacts(project.id, [{ path, content }]);
            await reload();
            setPasting(false);
            toast(`Added ${path}.`, 'ok');
          }}
        />
      )}
    </>
  );
}

function PasteModal({ onClose, onAdd }) {
  const [path, setPath] = useState('src/test/java/ExampleTest.java');
  const [content, setContent] = useState('');
  return (
    <Modal
      title="Paste source code"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!content.trim()} onClick={() => onAdd(path, content)}>Add artifact</button>
        </>
      }
    >
      <Field label="File path" hint="The extension matters — it helps the technology detector.">
        <input className="mono" type="text" value={path} onChange={(e) => setPath(e.target.value)} />
      </Field>
      <Field label="Content">
        <textarea className="mono" rows={16} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste a test class, spec file or collection export…" />
      </Field>
    </Modal>
  );
}
