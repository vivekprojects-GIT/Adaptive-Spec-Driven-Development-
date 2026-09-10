/**
 * Runtime settings, editable from the UI (Settings page) and persisted to server/data/settings.json.
 *
 * The platform is useful with no model at all — the rule engine runs everything. A model only adds
 * assistance: extra interview questions, executing authored and BMAD agents, judging plain-English
 * guardrail rules. That model can come from an Anthropic key, or be BORROWED from the user's editor
 * (Copilot) through the ASDD MCP server's sampling bridge — no key needed.
 */
import { read, write } from './store.js';
import { bridgeConnected, bridgeStatus } from './bridge.js';

export const MODELS = [
  {
    id: 'auto',
    label: 'Auto',
    vendor: 'mixed',
    description:
      "Uses your Anthropic key if one is set (Opus 5 for discovery, Haiku 4.5 for the interview, Sonnet 5 for generation, Fable 5.1 for reports). With no key, borrows your editor's model through the ASDD MCP server. With neither, the rule engine.",
  },
  {
    id: 'copilot',
    label: 'Copilot (via VS Code MCP)',
    vendor: 'github',
    description:
      "Always use the model of the editor connected through the ASDD MCP server — your Copilot subscription, no API key. Needs this folder open in VS Code with the \"asdd\" MCP server running.",
  },
  { id: 'claude-opus-5', label: 'Claude Opus 5', vendor: 'anthropic', description: 'Deepest reasoning. Best for discovery on messy legacy suites. Needs an Anthropic key.' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', vendor: 'anthropic', description: 'Balanced. Good default for generation-heavy runs. Needs an Anthropic key.' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', vendor: 'anthropic', description: 'Fastest and cheapest. Needs an Anthropic key.' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', vendor: 'anthropic', description: 'Long-form writing strength; useful for report narration. Needs an Anthropic key.' },
  { id: 'offline', label: 'Offline (rule engine only)', vendor: 'none', description: 'No model, no network calls at all. Deterministic parsers, mappings and guardrails.' },
];

/** Auto mode routing table for Anthropic: task → model. */
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
  // Where the BMAD install lives. Blank = the folder ASDD is cloned into, then ASDD_BMAD_ROOT.
  bmadRoot: '',
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

/** The key actually used for an Anthropic call: UI-entered key wins, else the environment. */
export function activeApiKey() {
  const settings = getSettings();
  if (settings.apiKey) return settings.apiKey;
  if (settings.useEnvKey && process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return '';
}

/**
 * Which model serves a task right now.
 * @returns {{ kind: 'anthropic', model: string } | { kind: 'bridge', model: string } | null}
 */
export function resolveProvider(task = 'discovery') {
  const settings = getSettings();
  if (settings.model === 'offline' || !settings.llmAssist) return null;
  if (settings.model === 'copilot') return bridgeConnected() ? { kind: 'bridge', model: 'editor' } : null;

  const key = activeApiKey();
  if (settings.model === 'auto') {
    if (key) return { kind: 'anthropic', model: AUTO_ROUTES[task] || AUTO_ROUTES.discovery };
    if (bridgeConnected()) return { kind: 'bridge', model: 'editor' };
    return null;
  }
  return key ? { kind: 'anthropic', model: settings.model } : null;
}

/** A human-readable name for the model a task would use, or null when none is available. */
export function resolveModel(task = 'discovery') {
  const provider = resolveProvider(task);
  if (!provider) return null;
  return provider.kind === 'bridge' ? "your editor's model (MCP sampling)" : provider.model;
}

/** What the UI shows in the engine status pill. */
export function llmStatus() {
  const settings = getSettings();
  const key = activeApiKey();
  const bridge = bridgeStatus();

  if (settings.model === 'offline') return { mode: 'offline', provider: null, ready: true, detail: 'Rule engine only — no network calls.', bridge };
  if (!settings.llmAssist) return { mode: 'rules-fallback', provider: null, ready: true, detail: 'Model assistance is switched off in Settings.', bridge };

  const provider = resolveProvider('generation');
  if (provider?.kind === 'anthropic') {
    return {
      mode: 'llm',
      provider: 'anthropic',
      ready: true,
      detail: `Anthropic, ${settings.model === 'auto' ? 'auto routing per task' : settings.model}, key from ${settings.apiKey ? 'Settings' : 'the environment'}.`,
      bridge,
    };
  }
  if (provider?.kind === 'bridge') {
    return { mode: 'llm', provider: 'editor', ready: true, detail: `Borrowing ${bridge.client?.name || "your editor"}'s model through MCP sampling — no API key.`, bridge };
  }
  if (settings.model === 'copilot') {
    return { mode: 'rules-fallback', provider: null, ready: true, detail: `Set to Copilot, but: ${bridge.detail} Until then the rule engine runs.`, bridge };
  }
  return {
    mode: 'rules-fallback',
    provider: null,
    ready: true,
    detail: key
      ? `A key is set but model "${settings.model}" is not an Anthropic model.`
      : 'No API key and no editor connected, so every stage uses the deterministic rule engine. Open this folder in VS Code and start the "asdd" MCP server to borrow Copilot\'s model.',
    bridge,
  };
}
