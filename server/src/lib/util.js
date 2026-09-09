import crypto from 'node:crypto';

export function id(prefix = 'x') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function now() {
  return new Date().toISOString();
}

export function slug(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

/** PascalCase, used when naming generated classes/specs. */
export function pascal(text = '') {
  return String(text)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

export function camel(text = '') {
  const p = pascal(text);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

export function unique(list) {
  return [...new Set(list)];
}

export function countMatches(text, regex) {
  const matches = String(text).match(regex);
  return matches ? matches.length : 0;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Express 4 does not forward rejected promises to the error middleware, so every async
 * handler is wrapped in this. Without it a failed LLM call would hang the request.
 */
export function asyncH(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
