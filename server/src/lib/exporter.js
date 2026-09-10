/**
 * Export a run's artifacts to a folder on disk.
 *
 * This is the only part of the platform that writes outside its own data directory, so it is
 * deliberately cautious:
 *
 *   - every artifact path is re-sanitised, then the resolved absolute path is checked to be inside
 *     the chosen folder — a generator (or a model-written path) cannot escape it;
 *   - an existing file is never overwritten unless the caller explicitly asks;
 *   - every write is planned first and the plan is returned, so a person can look before anything
 *     touches their repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

/** Artifact kinds a user can choose to export. */
export const EXPORTABLE_KINDS = [
  { id: 'code', label: 'Generated code', hint: 'tests, page objects, config' },
  { id: 'spec', label: 'Specs & documents', hint: 'features/*.feature, docs/*.md' },
  { id: 'data', label: 'Migrated test data', hint: 'data/*.json' },
  { id: 'config', label: 'Framework config', hint: 'playwright.config.ts, conftest.py' },
  { id: 'analysis', label: 'Analysis output', hint: 'source model, traceability, structure report' },
];

const DEFAULT_KINDS = ['code', 'spec', 'data', 'config'];

/** Strips anything that could escape the target folder. Returns null if nothing safe remains. */
export function safeRelative(rawPath) {
  const cleaned = String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..' && segment !== '.git');
  return cleaned.length ? cleaned.join('/') : null;
}

export class ExportError extends Error {
  constructor(message, details) {
    super(message);
    this.status = 400;
    this.details = details;
  }
}

function resolveRoot(targetDir) {
  const trimmed = String(targetDir || '').trim();
  if (!trimmed) throw new ExportError('A target folder is required.');
  if (!path.isAbsolute(trimmed)) {
    throw new ExportError('Give an absolute path, so there is no doubt where the files land.', { example: process.platform === 'win32' ? 'D:\\work\\my-playwright-repo' : '/home/you/my-playwright-repo' });
  }

  const root = path.resolve(trimmed);
  const dataDir = path.resolve(DATA_DIR);
  if (root === dataDir || root.startsWith(dataDir + path.sep)) {
    throw new ExportError('That folder is the platform\'s own data directory. Pick somewhere else.');
  }
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
    throw new ExportError(`${root} exists and is a file, not a folder.`);
  }
  return root;
}

/**
 * Works out exactly what would be written, without writing anything.
 * @returns {{ root, exists, files: Array<{path, absolute, bytes, kind, status}>, summary }}
 */
export function planExport(run, { targetDir, include = DEFAULT_KINDS, overwrite = false } = {}) {
  const root = resolveRoot(targetDir);
  const kinds = new Set(include.length ? include : DEFAULT_KINDS);
  const artifacts = (run.ws?.generated || []).filter((artifact) => kinds.has(artifact.kind));

  const files = artifacts.map((artifact) => {
    const relative = safeRelative(artifact.path);
    if (!relative) {
      return { path: artifact.path, absolute: null, bytes: artifact.bytes, kind: artifact.kind, status: 'blocked', reason: 'The path resolves to nothing safe to write.' };
    }

    const absolute = path.resolve(root, relative);
    // Belt and braces: even after sanitising, the resolved path must sit inside the target.
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      return { path: artifact.path, absolute, bytes: artifact.bytes, kind: artifact.kind, status: 'blocked', reason: 'The path would escape the target folder.' };
    }

    const exists = fs.existsSync(absolute);
    return {
      path: relative,
      absolute,
      bytes: artifact.bytes,
      kind: artifact.kind,
      artifactId: artifact.id,
      status: exists ? (overwrite ? 'overwrite' : 'skip-exists') : 'create',
    };
  });

  const count = (status) => files.filter((file) => file.status === status).length;
  return {
    root,
    exists: fs.existsSync(root),
    files,
    summary: {
      total: files.length,
      create: count('create'),
      overwrite: count('overwrite'),
      skipExists: count('skip-exists'),
      blocked: count('blocked'),
    },
  };
}

/** Performs a plan. Only `create` and `overwrite` entries are written. */
export function performExport(run, options) {
  const plan = planExport(run, options);
  const byId = new Map((run.ws?.generated || []).map((artifact) => [artifact.id, artifact]));
  const written = [];
  const errors = [];

  if (!plan.exists) fs.mkdirSync(plan.root, { recursive: true });

  for (const file of plan.files) {
    if (file.status !== 'create' && file.status !== 'overwrite') continue;
    const artifact = byId.get(file.artifactId);
    if (!artifact) {
      errors.push({ path: file.path, error: 'Artifact vanished between planning and writing.' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(file.absolute), { recursive: true });
      fs.writeFileSync(file.absolute, artifact.content, 'utf8');
      written.push({ path: file.path, absolute: file.absolute, bytes: artifact.bytes, status: file.status });
    } catch (err) {
      errors.push({ path: file.path, error: err.message });
    }
  }

  return {
    root: plan.root,
    createdFolder: !plan.exists,
    written,
    skipped: plan.files.filter((file) => file.status === 'skip-exists'),
    blocked: plan.files.filter((file) => file.status === 'blocked'),
    errors,
    summary: { ...plan.summary, written: written.length, failed: errors.length },
  };
}
