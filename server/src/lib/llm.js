/**
 * Optional model assist.
 *
 * Every caller must work without this. `assist()` returns `null` when no model is available, and
 * `{ __error }` when a call fails — callers then keep their deterministic result. That is what makes
 * the clone-and-run promise true offline.
 *
 * Two providers, chosen by settings.resolveProvider():
 *   - anthropic — a direct HTTPS call with the user's key
 *   - bridge    — the model of the user's editor (Copilot), reached through the ASDD MCP server
 *                 via MCP sampling; no key involved
 */
import { activeApiKey, resolveProvider, getSettings } from './settings.js';
import { requestCompletion } from './bridge.js';
import { logger } from './logger.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_TIMEOUT_MS = 45_000;

export function llmAvailable(task = 'generation') {
  return Boolean(resolveProvider(task));
}

async function anthropicComplete({ model, system, prompt, maxTokens, temperature }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': activeApiKey(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic call failed (${response.status}): ${body.slice(0, 300)}`);
    }
    const data = await response.json();
    const text = (data.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    return { text, model };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Anthropic call timed out after ${ANTHROPIC_TIMEOUT_MS / 1000}s.`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function bridgeComplete({ system, prompt, maxTokens, task }) {
  const result = await requestCompletion({ system, prompt, maxTokens, task });
  return { text: result.text.trim(), model: `${result.model} (via your editor)` };
}

/**
 * @param {object} opts
 * @param {string} opts.task     discovery | interview | rationale | generation | report
 * @param {string} opts.system   system prompt
 * @param {string} opts.prompt   user prompt
 * @param {boolean} [opts.json]  ask for, and parse, a single JSON object
 * @returns {Promise<object|null>} parsed JSON (with __model) / { text, model } / { __error } / null
 */
export async function assist({ task = 'discovery', system, prompt, json = true, maxTokens = 2000 }) {
  const provider = resolveProvider(task);
  if (!provider) return null;

  const fullSystem = json ? `${system}\n\nRespond with a single JSON object and nothing else.` : system;
  let text;
  let model;
  try {
    ({ text, model } =
      provider.kind === 'bridge'
        ? await bridgeComplete({ system: fullSystem, prompt, maxTokens, task })
        : await anthropicComplete({ model: provider.model, system: fullSystem, prompt, maxTokens, temperature: getSettings().temperature ?? 0 }));
    logger.debug('llm', `${task} call succeeded on ${model}`, { task, model, provider: provider.kind });
  } catch (err) {
    logger.error('llm', `${task} call failed: ${err.message}`, { task, provider: provider.kind });
    return { __error: err.message };
  }

  if (!json) return { text, model, __model: model };

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return { __error: `${model} returned no JSON object.` };
  try {
    return { ...JSON.parse(text.slice(start, end + 1)), __model: model };
  } catch (err) {
    return { __error: `${model} returned unparseable JSON: ${err.message}` };
  }
}

/** Connection test for the Settings page — exercises whichever provider is active. */
export async function testConnection() {
  const provider = resolveProvider('interview');
  if (!provider) {
    return {
      ok: false,
      detail: activeApiKey()
        ? 'Model assistance is switched off or set to offline.'
        : 'No API key, and no editor is connected through the ASDD MCP server.',
    };
  }
  const result = await assist({ task: 'interview', system: 'You are a connectivity probe.', prompt: 'Reply with {"ok":true}.', maxTokens: 64 });
  if (!result) return { ok: false, detail: 'No model became available.' };
  if (result.__error) return { ok: false, detail: result.__error };
  return { ok: true, detail: `Reached ${result.__model}.`, provider: provider.kind };
}
