/**
 * Optional LLM assist.
 *
 * Every caller must work without this. `assist()` returns `null` when no key/model is configured
 * or when the call fails — callers then keep their deterministic result. That is what makes the
 * clone-and-run promise true offline.
 */
import { activeApiKey, resolveModel, getSettings } from './settings.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

export function llmAvailable() {
  const settings = getSettings();
  return Boolean(settings.llmAssist && settings.model !== 'offline' && activeApiKey());
}

/**
 * @param {object} opts
 * @param {string} opts.task     one of discovery | interview | rationale | generation | report
 * @param {string} opts.system   system prompt
 * @param {string} opts.prompt   user prompt
 * @param {boolean} [opts.json]  ask for and parse a JSON object response
 * @returns {Promise<any|null>}  parsed JSON / text, or null when unavailable
 */
export async function assist({ task = 'discovery', system, prompt, json = true, maxTokens = 2000 }) {
  if (!llmAvailable()) return null;
  const model = resolveModel(task);
  if (!model) return null;

  const settings = getSettings();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': activeApiKey(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: settings.temperature ?? 0,
        system: json ? `${system}\n\nRespond with a single JSON object and nothing else.` : system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { __error: `LLM call failed (${response.status}): ${body.slice(0, 300)}` };
    }

    const data = await response.json();
    const text = (data.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    if (!json) return { text, model };

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return { __error: 'LLM returned no JSON object.' };
    try {
      return { ...JSON.parse(text.slice(start, end + 1)), __model: model };
    } catch (err) {
      return { __error: `LLM returned unparseable JSON: ${err.message}` };
    }
  } catch (err) {
    return { __error: err.name === 'AbortError' ? 'LLM call timed out after 45s.' : err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/** Connection test for the Settings page. */
export async function testConnection() {
  if (!activeApiKey()) return { ok: false, detail: 'No API key configured (Settings field or ANTHROPIC_API_KEY).' };
  const result = await assist({
    task: 'interview',
    system: 'You are a connectivity probe.',
    prompt: 'Reply with {"ok":true}.',
    maxTokens: 64,
  });
  if (!result) return { ok: false, detail: 'LLM assist is disabled or the model is set to offline.' };
  if (result.__error) return { ok: false, detail: result.__error };
  return { ok: true, detail: `Reached ${result.__model}.` };
}
