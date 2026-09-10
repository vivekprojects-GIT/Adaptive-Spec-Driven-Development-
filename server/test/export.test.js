/**
 * Export to folder.
 *
 * This is the only code that writes outside the platform's own data directory, so the tests are
 * mostly about what it REFUSES to do: escape the target folder, clobber existing work, or write
 * somewhere the user did not name precisely.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { planExport, performExport, safeRelative } from '../src/lib/exporter.js';
import { DATA_DIR } from '../src/lib/store.js';

function tempDir(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asdd-export-')), name);
}

function fakeRun(artifacts) {
  return {
    id: 'run_test',
    projectId: 'prj_test',
    ws: {
      generated: artifacts.map((artifact, index) => ({
        id: `art_${index}`,
        bytes: Buffer.byteLength(artifact.content, 'utf8'),
        kind: 'code',
        ...artifact,
      })),
    },
  };
}

test('a path cannot escape the target folder', () => {
  assert.equal(safeRelative('../../etc/passwd'), 'etc/passwd', 'parent segments are stripped');
  assert.equal(safeRelative('/etc/passwd'), 'etc/passwd', 'a leading slash does not make it absolute');
  assert.equal(safeRelative('C:\\Windows\\System32\\x.dll'), 'Windows/System32/x.dll', 'a drive letter is stripped');
  assert.equal(safeRelative('.git/config'), 'config', 'the git directory is never a target');
  assert.equal(safeRelative('../..'), null, 'nothing safe left means nothing is written');

  const root = tempDir('escape');
  const plan = planExport(fakeRun([{ path: '../../../evil.ts', content: 'boom' }]), { targetDir: root });
  assert.equal(plan.files[0].status, 'create');
  assert.ok(plan.files[0].absolute.startsWith(path.resolve(root) + path.sep), 'it lands inside the target');
  assert.ok(!plan.files[0].absolute.includes('..'));
});

test('it insists on an absolute path and refuses its own data directory', () => {
  assert.throws(() => planExport(fakeRun([]), { targetDir: '' }), /target folder is required/i);
  assert.throws(() => planExport(fakeRun([]), { targetDir: './somewhere' }), /absolute path/i);
  assert.throws(() => planExport(fakeRun([]), { targetDir: path.join(DATA_DIR, 'x') }), /own data directory/i);
});

test('planning writes nothing and reports exactly what would happen', () => {
  const root = tempDir('plan');
  const run = fakeRun([
    { path: 'tests/login.spec.ts', content: 'test one' },
    { path: 'docs/prd.md', content: '# PRD', kind: 'spec' },
  ]);

  const plan = planExport(run, { targetDir: root, include: ['code', 'spec'] });
  assert.equal(plan.summary.total, 2);
  assert.equal(plan.summary.create, 2);
  assert.equal(plan.exists, false, 'the folder does not exist yet');
  assert.ok(!fs.existsSync(root), 'planning created nothing on disk');
});

test('include filters what is exported', () => {
  const root = tempDir('filter');
  const run = fakeRun([
    { path: 'tests/login.spec.ts', content: 'code', kind: 'code' },
    { path: 'analysis/source-model.json', content: '{}', kind: 'analysis' },
  ]);

  const codeOnly = planExport(run, { targetDir: root, include: ['code'] });
  assert.equal(codeOnly.summary.total, 1);
  assert.equal(codeOnly.files[0].path, 'tests/login.spec.ts');
});

test('existing files are never overwritten unless asked', () => {
  const root = tempDir('overwrite');
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'login.spec.ts'), 'MY OWN WORK', 'utf8');

  const run = fakeRun([
    { path: 'tests/login.spec.ts', content: 'generated' },
    { path: 'tests/checkout.spec.ts', content: 'generated too' },
  ]);

  const cautious = performExport(run, { targetDir: root, include: ['code'] });
  assert.equal(cautious.written.length, 1, 'only the new file is written');
  assert.equal(cautious.skipped.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'tests', 'login.spec.ts'), 'utf8'), 'MY OWN WORK', 'existing work is untouched');
  assert.equal(fs.readFileSync(path.join(root, 'tests', 'checkout.spec.ts'), 'utf8'), 'generated too');

  const forced = performExport(run, { targetDir: root, include: ['code'], overwrite: true });
  assert.equal(forced.written.length, 2);
  assert.equal(fs.readFileSync(path.join(root, 'tests', 'login.spec.ts'), 'utf8'), 'generated', 'overwritten only when asked');
});

test('writing creates the folder tree and reports what landed where', () => {
  const root = tempDir('write');
  const run = fakeRun([
    { path: 'tests/api/orders.spec.ts', content: 'api test' },
    { path: 'docs/architecture.md', content: '# Architecture', kind: 'spec' },
    { path: 'data/users.json', content: '[]', kind: 'data' },
  ]);

  const result = performExport(run, { targetDir: root, include: ['code', 'spec', 'data'] });

  assert.equal(result.createdFolder, true);
  assert.equal(result.written.length, 3);
  assert.equal(result.errors.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'tests', 'api', 'orders.spec.ts'), 'utf8'), 'api test');
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'architecture.md'), 'utf8'), '# Architecture');
  assert.equal(fs.readFileSync(path.join(root, 'data', 'users.json'), 'utf8'), '[]');
  for (const file of result.written) {
    assert.ok(path.isAbsolute(file.absolute), 'each result names the absolute path it wrote');
  }
});
