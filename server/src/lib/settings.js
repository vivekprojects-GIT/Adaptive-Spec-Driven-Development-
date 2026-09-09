/**
 * Runtime settings, editable from the UI (Settings page) and persisted to server/data/settings.json.
 *
 * The platform is useful with no key at all — the rule engine runs everything. A key only adds
 * LLM assistance to discovery, the requirements interview and the proposal rationales.
 */
import { read, write } from './store.js';

export const MODELS = [
  {
    id: 'auto',
    label: 'Auto',
    vendor: 'anthropic',
    description: 'Picks a model per task: heavy reasoning → Opus 5, bulk generation → Sonnet 5, classification → Haiku 4.5.',
  },
  { id: 'claude-opus-5', label: 'Claude Opus 5', vendor: 'anthropic', description: 'Deepest reasoning. Best for discovery on messy legacy suites.' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', vendor: 'anthropic', description: 'Balanced. Good default for generation-heavy runs.' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', vendor: 'anthropic', description: 'Fastest and cheapest. Fine for classification and question drafting.' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', vendor: 'anthropic', description: 'Long-form writing strength; useful for report narration.' },
  { id: 'offline', label: 'Offline (rule engine only)', vendor: 'none', description: 'No network calls at all. Deterministic parsers, mappings and guardrails.' },
];

/** Auto mode routing table: task → model. */
export const AUTO_ROUTES = {
  discovery: 'claude-opus-5',
  interview: 'claude-haiku-4-5-20251001',
  rationale: 'claude-sonnet-5',
  generation: 'claude-sonnet-5',
  report: 'claude-fable-5-1',
};

const DEFAULTS = {
  model: 'auto',
  apiKey: '',
  useEnvKey: true,
  temperature: 0,
  llmAssist: true,
  autoApproveReuse: false,
  maxQuestions: 8,
};

export function getSettings() {
  const stored = read('settings', {});
  return { ...DEFAULTS, ...stored };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write('settings', next);
  return next;
}

/** The key actually used for a call: UI-entered key wins, else the environment. */
export function activeApiKey() {
  const settings = getSettings();
  if (settings.apiKey) return settings.apiKey;
  if (settings.useEnvKey && process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return '';
}

export function resolveModel(task = 'discovery') {
  const settings = getSettings();
  if (settings.model === 'offline') return null;
  if (settings.model === 'auto') return AUTO_ROUTES[task] || AUTO_ROUTES.discovery;
  return settings.model;
}

/** What the UI shows in the status pill. */
export function llmStatus() {
  const settings = getSettings();
  const key = activeApiKey();
  if (settings.model === 'offline') return { mode: 'offline', ready: true, detail: 'Rule engine only — no network calls.' };
  if (!key) return { mode: 'rules-fallback', ready: true, detail: 'No API key set, so every stage falls back to the deterministic rule engine.' };
  if (!settings.llmAssist) return { mode: 'rules-fallback', ready: true, detail: 'LLM assist is switched off in Settings.' };
  return {
    mode: 'llm',
    ready: true,
    detail: `LLM assist on, model ${settings.model === 'auto' ? 'auto (per task)' : settings.model}, key from ${settings.apiKey ? 'Settings' : 'environment'}.`,
  };
}
