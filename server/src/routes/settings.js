import { Router } from 'express';
import { getSettings, saveSettings, MODELS, AUTO_ROUTES, llmStatus } from '../lib/settings.js';
import { testConnection } from '../lib/llm.js';
import { asyncH } from '../lib/util.js';

const router = Router();

router.get('/', (req, res) => {
  const settings = getSettings();
  res.json({
    settings: { ...settings, apiKey: settings.apiKey ? '••••••••' : '' },
    models: MODELS,
    autoRoutes: AUTO_ROUTES,
    status: llmStatus(),
    envKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

router.put('/', (req, res) => {
  const patch = { ...(req.body || {}) };
  // A masked key coming back from the UI must not overwrite the stored one.
  if (patch.apiKey === '••••••••') delete patch.apiKey;
  const settings = saveSettings(patch);
  res.json({
    settings: { ...settings, apiKey: settings.apiKey ? '••••••••' : '' },
    status: llmStatus(),
  });
});

router.post('/test', asyncH(async (req, res) => {
  res.json(await testConnection());
}));

export default router;
