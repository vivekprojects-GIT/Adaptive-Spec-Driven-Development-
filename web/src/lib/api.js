/** Thin API client. Every call surfaces server errors as thrown Errors the UI can show. */

async function call(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.details = data?.details;
    error.status = response.status;
    throw error;
  }
  return data;
}

export const api = {
  health: () => call('/health'),

  samples: () => call('/samples'),
  sample: (sampleId) => call(`/samples/${sampleId}`),

  projects: () => call('/projects'),
  project: (projectId) => call(`/projects/${projectId}`),
  createProject: (body) => call('/projects', { method: 'POST', body }),
  deleteProject: (projectId) => call(`/projects/${projectId}`, { method: 'DELETE' }),
  saveSpec: (projectId, spec) => call(`/projects/${projectId}/spec`, { method: 'PUT', body: spec }),

  addArtifacts: (projectId, files) => call(`/projects/${projectId}/artifacts`, { method: 'POST', body: files }),
  removeArtifact: (projectId, artifactId) => call(`/projects/${projectId}/artifacts/${artifactId}`, { method: 'DELETE' }),

  assess: (projectId, body = {}) => call(`/projects/${projectId}/interview`, { method: 'POST', body }),
  answer: (projectId, questionId, answer) => call(`/projects/${projectId}/interview/answer`, { method: 'POST', body: { questionId, answer } }),

  discover: (projectId, force = false) => call(`/projects/${projectId}/discover`, { method: 'POST', body: { force } }),

  decide: (projectId, kind, proposalId, action, patch) =>
    call(`/projects/${projectId}/proposals/${kind}/${proposalId}`, { method: 'POST', body: { action, patch } }),
  bulkDecide: (projectId, kind, action, only) =>
    call(`/projects/${projectId}/proposals/${kind}/bulk`, { method: 'POST', body: { action, only } }),
  addProposal: (projectId, kind, body) => call(`/projects/${projectId}/proposals/${kind}`, { method: 'POST', body }),

  compose: (projectId) => call(`/projects/${projectId}/compose`, { method: 'POST' }),
  startRun: (projectId) => call(`/projects/${projectId}/runs`, { method: 'POST' }),
  runs: (projectId) => call(`/projects/${projectId}/runs`),

  run: (runId) => call(`/runs/${runId}`),
  reportUrl: (runId) => `/api/runs/${runId}/report.md`,
  bundleUrl: (runId) => `/api/runs/${runId}/bundle.json`,

  registry: () => call('/registry'),
  addAgent: (body) => call('/registry/agents', { method: 'POST', body }),
  deleteAgent: (agentId) => call(`/registry/agents/${agentId}`, { method: 'DELETE' }),
  addGuardrail: (body) => call('/registry/guardrails', { method: 'POST', body }),
  deleteGuardrail: (guardrailId) => call(`/registry/guardrails/${guardrailId}`, { method: 'DELETE' }),

  settings: () => call('/settings'),
  saveSettings: (body) => call('/settings', { method: 'PUT', body }),
  testLlm: () => call('/settings/test', { method: 'POST' }),
};

/** Subscribes to a run's SSE stream. Returns an unsubscribe function. */
export function streamRun(runId, onEvent) {
  const source = new EventSource(`/api/runs/${runId}/stream`);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch {
      /* ignore keep-alive comments */
    }
  };
  source.onerror = () => source.close();
  return () => source.close();
}
