/**
 * The BMAD loader, against a fixture laid out exactly like a real BMAD v6 install.
 *
 * ASDD runs ON TOP of the user's existing BMAD, so what matters is fidelity: the right agents,
 * found where BMAD actually installs them, with the team's and user's customisations merged the way
 * BMAD itself merges them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBmad, findBmadAgent, findBmadRoot, isBmadRoot, personaPrompt, resolveFacts, parseCsv, parseFrontmatter, bmadMerge } from '../src/bmad/loader.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bmad');

test('the manifest parser handles descriptions with commas and doubled quotes', () => {
  const rows = parseCsv('a,b\n"x, y","say ""hi"""\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"' }]);
});

test('frontmatter values may be quoted, including BMAD-style single quotes', () => {
  const { meta, body } = parseFrontmatter("---\nname: x\ndescription: 'It''s the \"spine\".'\n---\n# Body");
  assert.equal(meta.name, 'x');
  assert.equal(meta.description, 'It\'s the "spine".');
  assert.equal(body.trim(), '# Body');
});

test('an explicit BMAD folder is used; a folder without a manifest is not BMAD', () => {
  assert.equal(isBmadRoot(FIXTURE), true);
  assert.equal(findBmadRoot(FIXTURE), path.resolve(FIXTURE));
  assert.equal(isBmadRoot(os.tmpdir()), false);
});

test('agents and workflows load from where BMAD really installs them', () => {
  const bmad = loadBmad({ root: FIXTURE, force: true });
  assert.equal(bmad.found, true);
  assert.equal(bmad.version, '6.11.0');
  assert.equal(bmad.config.user_name, 'Tester');

  assert.equal(bmad.agents.length, 1);
  const [agent] = bmad.agents;
  assert.equal(agent.name, 'Winston');
  assert.equal(agent.title, 'System Architect');
  assert.equal(agent.role, 'testarchitect');
  assert.match(agent.skillFile, /_bmad\/bmm\/agents\//, 'found at the manifest path');

  assert.equal(bmad.workflows.length, 1);
  assert.match(bmad.workflows[0].skillFile, /^\.claude\/skills\//, 'found where Claude Code installs skills, when the manifest path is empty');

  assert.deepEqual(bmad.deprecated, ['bmad-testshim'], 'deprecated shims are skipped, not loaded');
  assert.ok(bmad.problems.some((p) => p.includes('bmad-testmissing')), 'a manifest entry with no SKILL.md is reported');
});

test("customisations merge exactly the way BMAD's resolver merges them", () => {
  const [agent] = loadBmad({ root: FIXTURE, force: true }).agents;
  assert.deepEqual(agent.overrides, ['base', 'team', 'user']);
  assert.equal(agent.persona.communication_style, 'Blunt and brief.', 'scalars: the personal override wins');
  assert.deepEqual(agent.persona.principles, ['Boring technology for stability.', 'Every claim traces to a source.'], 'arrays append');
  assert.equal(agent.persona.persistent_facts.length, 3, 'base fact plus two team facts');
  assert.deepEqual(agent.persona.menu.map((m) => m.code), ['CA', 'IR', 'TR'], 'keyed tables replace in place and append new codes');
  assert.equal(agent.persona.menu[0].description, 'Team-customised architecture spine');
});

test('bmadMerge follows the documented structural rules', () => {
  assert.equal(bmadMerge('a', 'b'), 'b');
  assert.deepEqual(bmadMerge(['x'], ['y']), ['x', 'y']);
  assert.deepEqual(bmadMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
  assert.deepEqual(
    bmadMerge([{ code: 'A', v: 1 }, { code: 'B', v: 1 }], [{ code: 'B', v: 2 }, { code: 'C', v: 1 }]),
    [{ code: 'A', v: 1 }, { code: 'B', v: 2 }, { code: 'C', v: 1 }],
  );
});

test('standing facts load referenced files and globs, and report the missing ones', () => {
  const [agent] = loadBmad({ root: FIXTURE, force: true }).agents;
  const facts = resolveFacts(agent.persona.persistent_facts, FIXTURE);

  const glob = facts.find((f) => f.entry.includes('**/project-context.md'));
  assert.deepEqual(glob.files, ['sub/project-context.md']);
  assert.match(glob.text, /found by a \*\* glob/);

  const file = facts.find((f) => f.entry.includes('docs/constraints.md'));
  assert.match(file.text, /no automated decision path/i);

  const literal = facts.find((f) => f.kind === 'literal');
  assert.equal(literal.text, 'The system recommends; a human decides.');

  const [missing] = resolveFacts(['file:{project-root}/does-not-exist.md'], FIXTURE);
  assert.equal(missing.missing, true, 'a missing file is reported, not silently dropped');
});

test("the persona prompt is built from BMAD's own definitions", () => {
  const bmad = loadBmad({ root: FIXTURE, force: true });
  const [agent] = bmad.agents;
  const prompt = personaPrompt(agent, { facts: resolveFacts(agent.persona.persistent_facts, FIXTURE), config: bmad.config });

  assert.match(prompt, /You are Winston, System Architect/);
  assert.match(prompt, /turn requirements into architecture that ships/, 'the SKILL.md overview');
  assert.match(prompt, /Blunt and brief/, 'the merged communication style');
  assert.match(prompt, /Every claim traces to a source/, 'the team principle');
  assert.match(prompt, /no automated decision path/i, 'the team standing fact, loaded from its file');
  assert.match(prompt, /Communicate in English/);
  assert.match(prompt, /do not ask the user questions/, 'it knows it is a single step, not a chat');
});

test('agents are found by id, short role, or persona name', () => {
  const bmad = loadBmad({ root: FIXTURE, force: true });
  for (const query of ['bmad-agent-testarchitect', 'testarchitect', 'winston', 'WINSTON']) {
    assert.equal(findBmadAgent(query, bmad)?.id, 'bmad-agent-testarchitect', query);
  }
  assert.equal(findBmadAgent('nobody', bmad), null);
});
