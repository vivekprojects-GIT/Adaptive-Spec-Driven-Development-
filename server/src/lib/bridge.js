/**
 * Model bridge — lets the ASDD server use the model inside the user's editor.
 *
 * The ASDD server cannot reach Copilot's model by itself: that model lives behind the MCP client
 * (VS Code). So when a step needs a model and no API key is configured, the request is queued
 * here. The ASDD MCP process long-polls for it, runs it through MCP SAMPLING on the user's own
 * subscription, and posts the answer back.
 *
 * Only a process that knows the bridge token (written to the git-ignored data directory) can take
 * or answer requests, so nothing else on the network can pose as the model.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, TOKEN_FILE } from './bridge-paths.js';

const CONNECTED_WINDOW_MS = 40_000;
const REQUEST_TIMEOUT_MS = 120_000;
export { TOKEN_FILE };

const queue = [];
const waiters = [];
const inflight = new Map();
const stats = { served: 0, failed: 0, timedOut: 0 };
let presence = { lastSeen: 0, sampling: false, client: null };
let sequence = 0;

/* ---------------------------------------------------------------- token */

let token = null;

/** A fresh token per server start, readable only by processes that can read the data directory. */
export function bridgeToken() {
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, createdAt: new Date().toISOString() }), 'utf8');
  }
  return token;
}

export function tokenMatches(candidate) {
  const expected = Buffer.from(bridgeToken());
  const given = Buffer.from(String(candidate || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/* ------------------------------------------------------------- presence */

export function heartbeat({ sampling, client } = {}) {
  presence = {
    lastSeen: Date.now(),
    sampling: sampling ?? presence.sampling,
    client: client ?? presence.client,
  };
}

/** Connected AND able to run model requests. A client without sampling cannot serve the bridge. */
export function bridgeConnected() {
  return presence.sampling && Date.now() - presence.lastSeen < CONNECTED_WINDOW_MS;
}

export function bridgeStatus() {
  const seen = Date.now() - presence.lastSeen < CONNECTED_WINDOW_MS;
  return {
    connected: seen,
    sampling: seen && presence.sampling,
    usable: bridgeConnected(),
    client: seen ? presence.client : null,
    lastSeen: presence.lastSeen ? new Date(presence.lastSeen).toISOString() : null,
    queued: queue.length,
    inflight: inflight.size,
    ...stats,
    detail: !seen
      ? 'No editor is connected. Open this folder in VS Code and start the "asdd" MCP server.'
      : !presence.sampling
        ? `${presence.client?.name || 'The connected client'} does not support MCP sampling, so it cannot lend its model.`
        : `${presence.client?.name || 'Your editor'} is lending its model through MCP sampling.`,
  };
}

/* -------------------------------------------------------------- requests */

function dispatch(entry) {
  entry.takenAt = Date.now();
  inflight.set(entry.id, entry);
  return entry.request;
}

/**
 * Asks the connected editor's model for a completion.
 * @returns {Promise<{ text: string, model: string }>}
 */
export function requestCompletion({ system, prompt, maxTokens = 2000, task = 'generation' }) {
  if (!bridgeConnected()) {
    return Promise.reject(new Error('No editor with MCP sampling is connected, so there is no model to borrow.'));
  }
  sequence += 1;
  const id = `llm_${Date.now().toString(36)}_${sequence}`;

  return new Promise((resolve, reject) => {
    const entry = {
      id,
      request: { id, system, prompt, maxTokens, task, createdAt: new Date().toISOString() },
      resolve,
      reject,
      timer: setTimeout(() => {
        inflight.delete(id);
        const queued = queue.findIndex((e) => e.id === id);
        if (queued >= 0) queue.splice(queued, 1);
        stats.timedOut += 1;
        reject(new Error(`The editor did not answer within ${REQUEST_TIMEOUT_MS / 1000}s. If VS Code asked for permission, it may still be waiting on you.`));
      }, REQUEST_TIMEOUT_MS),
    };

    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(dispatch(entry));
    } else {
      queue.push(entry);
    }
  });
}

/**
 * Long-poll: resolves with the next request, or null after `waitMs`. The signal lets the route
 * withdraw a waiter whose HTTP connection has gone away, so no request is handed to a dead socket.
 */
export function takeNext(waitMs = 25_000, signal) {
  heartbeat();
  if (queue.length) return Promise.resolve(dispatch(queue.shift()));

  return new Promise((resolve) => {
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        resolve(null);
      }, Math.min(Math.max(Number(waitMs) || 0, 0), 55_000)),
    };
    waiters.push(waiter);
    signal?.addEventListener('abort', () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        resolve(null);
      }
    });
  });
}

/** Puts a request back at the head of the queue when it could not be delivered. */
export function requeue(id) {
  const entry = inflight.get(id);
  if (!entry) return false;
  inflight.delete(id);
  queue.unshift(entry);
  return true;
}

export function complete(id, { text, model, error } = {}) {
  const entry = inflight.get(id);
  if (!entry) return false;
  inflight.delete(id);
  clearTimeout(entry.timer);
  if (error) {
    stats.failed += 1;
    entry.reject(new Error(error));
  } else {
    stats.served += 1;
    entry.resolve({ text: String(text || ''), model: model || 'editor model' });
  }
  return true;
}

/** Test helper. */
export function resetBridge() {
  for (const entry of inflight.values()) clearTimeout(entry.timer);
  for (const entry of queue) clearTimeout(entry.timer);
  for (const waiter of waiters) clearTimeout(waiter.timer);
  queue.length = 0;
  waiters.length = 0;
  inflight.clear();
  presence = { lastSeen: 0, sampling: false, client: null };
  Object.assign(stats, { served: 0, failed: 0, timedOut: 0 });
}
