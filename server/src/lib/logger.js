/**
 * Structured log.
 *
 * Everything that happens gets a line: API calls, stage transitions, agent starts and finishes,
 * guardrail verdicts, model calls, and every error. The dashboard reads this to answer the only
 * question that matters when something breaks — where did it fail, and what was the last thing
 * that worked.
 *
 * Kept in memory and flushed to disk on a short debounce, so logging never sits in the hot path
 * of a run.
 */
import { read, write } from './store.js';

const MAX_ENTRIES = 3000;
const FLUSH_MS = 400;

let entries = null;
let dirty = false;
let timer = null;
let sequence = 0;

function load() {
  if (!entries) {
    entries = read('logs', []);
    sequence = entries.reduce((max, entry) => Math.max(max, entry.seq || 0), 0);
  }
  return entries;
}

function scheduleFlush() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (!dirty) return;
    dirty = false;
    write('logs', entries);
  }, FLUSH_MS);
  timer.unref?.();
}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} scope  api | project | run | agent | guardrail | llm | system
 * @param {string} message human-readable, already specific
 * @param {object} [meta]  { projectId, runId, nodeId, agent, guardrailId, event, ...detail }
 */
export function log(level, scope, message, meta = {}) {
  const list = load();
  sequence += 1;
  const { projectId = null, runId = null, nodeId = null, event = null, ...detail } = meta;
  list.unshift({
    id: `log_${sequence}`,
    seq: sequence,
    at: new Date().toISOString(),
    level,
    scope,
    message,
    projectId,
    runId,
    nodeId,
    event,
    detail: Object.keys(detail).length ? detail : null,
  });
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  scheduleFlush();
  if (level === 'error') console.error(`[${scope}] ${message}`);
  return list[0];
}

export const logger = {
  debug: (scope, message, meta) => log('debug', scope, message, meta),
  info: (scope, message, meta) => log('info', scope, message, meta),
  warn: (scope, message, meta) => log('warn', scope, message, meta),
  error: (scope, message, meta) => log('error', scope, message, meta),
};

export function queryLogs({ level, scope, projectId, runId, q, limit = 200, since } = {}) {
  const list = load();
  const needle = q?.trim().toLowerCase();
  return list
    .filter((entry) => {
      if (level && level !== 'all' && entry.level !== level) return false;
      if (scope && scope !== 'all' && entry.scope !== scope) return false;
      if (projectId && entry.projectId !== projectId) return false;
      if (runId && entry.runId !== runId) return false;
      if (since && entry.at <= since) return false;
      if (needle && !`${entry.message} ${entry.scope} ${JSON.stringify(entry.detail || '')}`.toLowerCase().includes(needle)) return false;
      return true;
    })
    .slice(0, Math.min(Number(limit) || 200, 1000));
}

export function logCounts() {
  const list = load();
  const counts = { total: list.length, debug: 0, info: 0, warn: 0, error: 0 };
  for (const entry of list) counts[entry.level] = (counts[entry.level] || 0) + 1;
  return counts;
}

export function clearLogs() {
  entries = [];
  sequence = 0;
  write('logs', entries);
}
