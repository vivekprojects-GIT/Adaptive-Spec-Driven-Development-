/**
 * Tiny JSON-file store. No database, no daemon — NFR-1 says the platform runs offline
 * straight after a clone, so persistence is a directory of JSON files with atomic writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(here, '../../data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const cache = new Map();

function fileFor(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

export function read(name, fallback) {
  if (cache.has(name)) return cache.get(name);
  const file = fileFor(name);
  let value = fallback;
  if (fs.existsSync(file)) {
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // A corrupt file must not take the server down; keep the bad copy for inspection.
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      value = fallback;
    }
  }
  cache.set(name, value);
  return value;
}

export function write(name, value) {
  cache.set(name, value);
  const file = fileFor(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return value;
}

export function collection(name) {
  const load = () => read(name, []);
  return {
    all: () => load(),
    find: (id) => load().find((row) => row.id === id) || null,
    insert(row) {
      const rows = load();
      rows.unshift(row);
      write(name, rows);
      return row;
    },
    update(id, patch) {
      const rows = load();
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return null;
      const next = typeof patch === 'function' ? patch(rows[index]) : { ...rows[index], ...patch };
      next.updatedAt = new Date().toISOString();
      rows[index] = next;
      write(name, rows);
      return next;
    },
    remove(id) {
      const rows = load().filter((row) => row.id !== id);
      write(name, rows);
    },
    replaceAll(rows) {
      write(name, rows);
      return rows;
    },
  };
}

/** Test helper — drops every cached and on-disk collection. */
export function resetStore() {
  cache.clear();
  for (const entry of fs.readdirSync(DATA_DIR)) {
    if (entry.endsWith('.json')) fs.rmSync(path.join(DATA_DIR, entry));
  }
}
