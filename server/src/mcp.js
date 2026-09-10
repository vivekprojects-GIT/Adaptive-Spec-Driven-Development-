#!/usr/bin/env node
/**
 * ASDD MCP server.
 *
 * Two jobs, both over stdio to VS Code (or any MCP client):
 *
 *   1. TOOLS — Copilot Chat can drive ASDD: read projects and the approvals inbox, answer interview
 *      questions, run discovery, decide proposals, run workflows, record the human's decision on a
 *      run, export files, and load real BMAD agent personas.
 *
 *   2. MODEL BRIDGE — when the ASDD server needs a model and no API key is configured, it queues
 *      the request. This process picks it up and asks the MCP client to run it through SAMPLING —
 *      on the user's own Copilot subscription. VS Code asks the user to allow that the first time.
 *
 * The ASDD server stays the single brain and the single writer of the data store; this process
 * only talks to it over HTTP. stdout belongs to the MCP protocol — everything else goes to stderr.
 */
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TOKEN_FILE } from './lib/bridge-paths.js';

const API = (process.env.ASDD_API || 'http://127.0.0.1:5174').replace(/\/+$/, '');
const log = (...parts) => process.stderr.write(`[asdd-mcp] ${parts.join(' ')}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ http */

class ToolError extends Error {}

function bridgeToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token || '';
  } catch {
    return '';
  }
}

async function api(pathname, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${API}/api${pathname}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ToolError(`The ASDD server is not running at ${API}. Start it with \`npm run dev\` in the ASDD folder, then try again.`);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!response.ok) {
    const extra = data?.details ? ` ${JSON.stringify(data.details)}` : '';
    throw new ToolError(`${data?.error || `ASDD returned ${response.status}.`}${extra}`);
  }
  return data;
}

/* ---------------------------------------------------------------- tools */

const server = new McpServer(
  { name: 'asdd', version: '1.0.0' },
  {
    instructions:
      'ASDD is an adaptive, spec-driven migration control plane built on the BMAD Method. Humans own every decision: ' +
      'never accept proposals, approve runs, or write files unless the user has explicitly asked for that specific action. ' +
      'Start with asdd_status, then asdd_list_approvals to see what is waiting on the user.',
  },
);

function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      const out = await handler(args || {});
      return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
    } catch (err) {
      if (!(err instanceof ToolError)) log(`${name} failed:`, err.stack || err.message);
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });
}

const readOnly = { readOnlyHint: true, openWorldHint: false };

function summariseRun(run) {
  const results = run.validation?.results || [];
  return {
    runId: run.id,
    project: run.projectName,
    status: run.status,
    verdict: run.validation?.verdict || null,
    approval: run.approval?.state || null,
    guardrails: results.map((r) => `${r.status.toUpperCase()} — ${r.name}: ${r.evidence}`),
    artifacts: (run.ws?.generated || []).map((a) => a.path),
    model: run.modelUsed || 'rule engine',
    next:
      run.approval?.state === 'pending'
        ? 'This run is waiting on a human decision. Ask the user whether to approve it or request changes, then call asdd_decide_run with their answer.'
        : undefined,
  };
}

tool(
  'asdd_status',
  {
    title: 'ASDD status',
    description: 'Whether the ASDD server is up, which model it will use (API key, your editor via sampling, or the offline rule engine), whether the editor bridge is connected, and which BMAD install it found.',
    annotations: readOnly,
  },
  async () => {
    const [health, bridge, bmad] = await Promise.all([api('/health'), api('/llm-bridge/status'), api('/bmad')]);
    return {
      server: `${API} — up`,
      model: health.llm,
      editorBridge: bridge,
      bmad: bmad.found
        ? { root: bmad.root, version: bmad.version, agents: bmad.agents.map((a) => `${a.icon} ${a.name} — ${a.title}`), workflows: bmad.workflows.length }
        : { found: false, searched: bmad.searched },
    };
  },
);

tool(
  'asdd_list_projects',
  { title: 'List projects', description: 'Every ASDD project with its stage, readiness and how many runs it has.', annotations: readOnly },
  async () => api('/projects'),
);

tool(
  'asdd_project_summary',
  {
    title: 'Project summary',
    description: 'One project in detail: stage, the interview questions still open, proposals awaiting a decision, whether a workflow is composed, and the latest run.',
    inputSchema: { projectId: z.string().describe('Project id, e.g. prj_1a2b3c') },
    annotations: readOnly,
  },
  async ({ projectId }) => {
    const p = await api(`/projects/${projectId}`);
    const pending = (kind) => (p.proposals?.[kind] || []).filter((x) => x.decision === 'proposed');
    const lastRun = p.runs?.[0];
    return {
      id: p.id,
      name: p.name,
      stage: p.stage,
      kind: p.spec?.projectKind || 'migration',
      source: p.spec?.sourceStack || null,
      target: p.spec?.targetStack || null,
      requirements: (p.spec?.requirements || '').split('\n').filter(Boolean).length,
      readiness: p.interview?.readiness ?? null,
      openQuestions: (p.interview?.questions || [])
        .filter((q) => !q.answered)
        .map((q) => ({ id: q.id, blocking: q.required, question: q.question, why: q.why, options: q.options?.length ? q.options : undefined })),
      proposalsAwaitingDecision: {
        agents: pending('agents').map((x) => ({ proposalId: x.proposalId, name: x.name, source: x.source })),
        guardrails: pending('guardrails').map((x) => ({ proposalId: x.proposalId, name: x.name, severity: x.severity })),
      },
      workflowComposed: Boolean(p.graph?.order?.length),
      lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, verdict: lastRun.verdict, artifacts: lastRun.artifacts } : null,
    };
  },
);

tool(
  'asdd_list_approvals',
  {
    title: 'What is waiting on the user',
    description: 'The approvals inbox: blocking questions, undecided proposals, halted runs and finished runs awaiting sign-off, across every project. Blockers first.',
    annotations: readOnly,
  },
  async () => {
    const inbox = await api('/approvals');
    return {
      total: inbox.total,
      blocking: inbox.blocking,
      items: inbox.items.map((i) => ({ severity: i.severity, kind: i.kind, project: i.projectName, projectId: i.projectId, runId: i.runId, title: i.title, detail: i.detail })),
    };
  },
);

tool(
  'asdd_answer_question',
  {
    title: 'Answer an interview question',
    description: "Records the USER'S answer to one of the project's interview questions. Use the user's own words — never invent an answer on their behalf.",
    inputSchema: {
      projectId: z.string(),
      questionId: z.string().describe('Question id from asdd_project_summary'),
      answer: z.string().describe("The user's answer"),
    },
  },
  async ({ projectId, questionId, answer }) => {
    const p = await api(`/projects/${projectId}/interview/answer`, { method: 'POST', body: { questionId, answer } });
    return {
      readiness: p.interview.readiness,
      ready: p.interview.ready,
      stillBlocking: p.interview.questions.filter((q) => q.required && !q.answered).map((q) => q.question),
    };
  },
);

tool(
  'asdd_run_discovery',
  {
    title: 'Run discovery',
    description: 'Assesses the spec and runs discovery: technologies, capabilities, risks, capability gaps — then the Agent Factory and Guardrail Designer propose agents and guardrails for the user to review.',
    inputSchema: { projectId: z.string(), force: z.boolean().optional().describe('Run even if blocking interview questions remain') },
  },
  async ({ projectId, force }) => {
    const existing = await api(`/projects/${projectId}`);
    if (!existing.interview) await api(`/projects/${projectId}/interview`, { method: 'POST', body: { withLlm: true } });
    const p = await api(`/projects/${projectId}/discover`, { method: 'POST', body: { force: Boolean(force) } });
    const d = p.discovery;
    return {
      summary: d.summary,
      source: d.source.label,
      target: d.target.label,
      risks: d.risks.map((r) => `${r.severity}: ${r.label}`),
      gaps: d.gaps.map((g) => `${g.capability} — needs ${g.needs}`),
      proposedAgents: p.proposals.agents.map((a) => `${a.name} (${a.source})`),
      proposedGuardrails: p.proposals.guardrails.map((g) => `${g.name} (${g.severity})`),
      next: 'Show the user these proposals. Accept or reject them only as the user directs (asdd_decide_proposal).',
    };
  },
);

tool(
  'asdd_decide_proposal',
  {
    title: 'Accept or reject a proposal',
    description: 'Records the USER\'S decision on an agent or guardrail proposal — one by id, or all undecided at once. Only call this when the user has said which way to decide.',
    inputSchema: {
      projectId: z.string(),
      kind: z.enum(['agents', 'guardrails']),
      action: z.enum(['accept', 'reject']),
      proposalId: z.string().optional().describe('Omit together with all=true to decide every undecided proposal'),
      all: z.boolean().optional(),
    },
  },
  async ({ projectId, kind, action, proposalId, all }) => {
    if (!all && !proposalId) throw new ToolError('Give a proposalId, or set all=true to decide every undecided proposal.');
    const p = all
      ? await api(`/projects/${projectId}/proposals/${kind}/bulk`, { method: 'POST', body: { action } })
      : await api(`/projects/${projectId}/proposals/${kind}/${proposalId}`, { method: 'POST', body: { action } });
    const list = p.proposals[kind];
    return {
      accepted: list.filter((x) => x.decision === 'accepted').map((x) => x.name),
      rejected: list.filter((x) => x.decision === 'rejected').map((x) => x.name),
      stillUndecided: list.filter((x) => x.decision === 'proposed').map((x) => x.name),
    };
  },
);

tool(
  'asdd_run_workflow',
  {
    title: 'Compose and run the workflow',
    description: 'Composes the accepted agents into a workflow and runs it, waiting up to two minutes for the result. The run then waits for the user\'s approval.',
    inputSchema: { projectId: z.string() },
  },
  async ({ projectId }) => {
    const composed = await api(`/projects/${projectId}/compose`, { method: 'POST' });
    if (!composed.graph?.order?.length) throw new ToolError(`Nothing to run: ${(composed.graph?.errors || []).join(' ') || 'no accepted agents.'}`);
    const { runId } = await api(`/projects/${projectId}/runs`, { method: 'POST' });
    for (let waited = 0; waited < 120_000; waited += 1000) {
      await sleep(1000);
      const run = await api(`/runs/${runId}`);
      if (!['running', 'queued'].includes(run.status)) return summariseRun(run);
    }
    return { runId, status: 'still running', next: 'Check again with asdd_run_summary.' };
  },
);

tool(
  'asdd_run_summary',
  { title: 'Run summary', description: 'Verdict, every guardrail result with its evidence, and the files a run produced.', inputSchema: { runId: z.string() }, annotations: readOnly },
  async ({ runId }) => summariseRun(await api(`/runs/${runId}`)),
);

tool(
  'asdd_decide_run',
  {
    title: "Record the user's decision on a run",
    description:
      "Approves a run or requests changes — the platform's final human gate. ONLY call this after the user has explicitly told you their decision in this conversation. Never decide on the user's behalf. The decision is recorded as made by a human through Copilot Chat.",
    inputSchema: {
      runId: z.string(),
      decision: z.enum(['approved', 'changes-requested']),
      note: z.string().optional().describe("The user's reason, in their words"),
    },
  },
  async ({ runId, decision, note }) => {
    const approval = await api(`/runs/${runId}/approval`, { method: 'POST', body: { state: decision, note: note || '', by: 'human via Copilot Chat' } });
    return { recorded: approval.state, by: approval.by, at: approval.at, note: approval.note };
  },
);

tool(
  'asdd_export_run',
  {
    title: 'Export a run to a folder',
    description:
      'Writes a run\'s generated files into a folder on disk. Without confirm=true this only PREVIEWS what would be written. Existing files are never overwritten unless overwrite=true. Show the preview to the user and get their go-ahead before writing.',
    inputSchema: {
      runId: z.string(),
      targetDir: z.string().describe('Absolute path to the destination folder'),
      confirm: z.boolean().optional().describe('true to actually write, after the user has seen the preview'),
      overwrite: z.boolean().optional().describe('true to overwrite files that already exist'),
    },
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ runId, targetDir, confirm, overwrite }) => {
    const result = await api(`/runs/${runId}/export`, { method: 'POST', body: { targetDir, overwrite: Boolean(overwrite), dryRun: !confirm } });
    if (!confirm) {
      return {
        preview: true,
        folder: result.root,
        willCreateFolder: !result.exists,
        summary: result.summary,
        files: result.files.map((f) => `${f.status.padEnd(11)} ${f.path}`),
        next: result.summary.skipExists
          ? 'Some files already exist and will be skipped. Ask the user whether to overwrite them before writing.'
          : 'Ask the user to confirm, then call again with confirm=true.',
      };
    }
    return { written: result.written.map((f) => f.path), skipped: result.skipped.map((f) => f.path), failed: result.errors, folder: result.root };
  },
);

tool(
  'asdd_bmad_agents',
  {
    title: 'BMAD agents and workflows',
    description: "The BMAD install ASDD runs on: its persona agents (Mary, John, Winston, Sally, Amelia — with the team's customisations applied) and its workflows.",
    annotations: readOnly,
  },
  async () => {
    const bmad = await api('/bmad');
    if (!bmad.found) return { found: false, searched: bmad.searched, fix: 'Set the BMAD folder in ASDD Settings, or start the server with ASDD_BMAD_ROOT set.' };
    return {
      root: bmad.root,
      version: bmad.version,
      agents: bmad.agents.map((a) => ({ id: a.id, persona: `${a.icon} ${a.name} — ${a.title}`, customisedBy: a.overrides.filter((o) => o !== 'base'), menu: a.persona.menu.map((m) => `${m.code}: ${m.description}`) })),
      workflows: bmad.workflows.map((w) => ({ id: w.id, group: w.group, description: w.description })),
      problems: bmad.problems,
    };
  },
);

tool(
  'asdd_bmad_persona',
  {
    title: 'Load a BMAD persona',
    description:
      'Returns the fully resolved BMAD persona for an agent — overview, role, identity, communication style, principles and the team\'s standing facts — optionally with an ASDD project\'s context. Adopt it to work as that agent in this chat, e.g. "review this migration as Winston".',
    inputSchema: {
      agent: z.string().describe('Agent id, role or name — "bmad-agent-architect", "architect" or "Winston"'),
      projectId: z.string().optional().describe('Include this ASDD project as context'),
    },
    annotations: readOnly,
  },
  async ({ agent, projectId }) => {
    const brief = await api(`/bmad/agents/${encodeURIComponent(agent)}/brief${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
    const missing = brief.facts.filter((f) => f.missing).map((f) => f.entry);
    return [
      `Adopt the following BMAD persona for the rest of this task. ${brief.agent.icon} ${brief.agent.name} — ${brief.agent.title}`,
      `Customised by: ${brief.agent.overrides.filter((o) => o !== 'base').join(', ') || 'no overrides'}.`,
      '',
      brief.system,
      brief.context ? `\nASDD project context:\n${JSON.stringify(brief.context, null, 2)}` : '',
      missing.length ? `\nNote: these standing facts reference files that do not exist: ${missing.join(', ')}` : '',
    ].join('\n');
  },
);

/* --------------------------------------------------------- model bridge */

function contentText(content) {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
}

async function serveSampling(request, token) {
  let payload;
  try {
    const result = await server.server.createMessage(
      {
        messages: [{ role: 'user', content: { type: 'text', text: request.prompt } }],
        systemPrompt: request.system,
        maxTokens: request.maxTokens || 2000,
        includeContext: 'none',
      },
      { timeout: 110_000 },
    );
    payload = { text: contentText(result.content), model: result.model };
    log(`served ${request.task} request on ${result.model}`);
  } catch (err) {
    payload = { error: `The editor declined or failed the model request: ${err.message}` };
    log(`sampling failed: ${err.message}`);
  }
  await fetch(`${API}/api/llm-bridge/${request.id}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asdd-bridge-token': token },
    body: JSON.stringify(payload),
  }).catch(() => log('could not post a result back — the ASDD server may have restarted'));
}

async function runBridge() {
  const sampling = Boolean(server.server.getClientCapabilities()?.sampling);
  const client = server.server.getClientVersion() || null;
  log(sampling ? `${client?.name || 'client'} supports sampling — lending its model to ASDD` : `${client?.name || 'client'} does not support sampling — tools only`);

  let announcedDown = false;
  for (;;) {
    const token = bridgeToken();
    try {
      const hello = await fetch(`${API}/api/llm-bridge/hello`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-asdd-bridge-token': token },
        body: JSON.stringify({ sampling, client }),
      });
      if (hello.status === 401) {
        log('bridge token rejected — is this MCP server using the same data folder as the ASDD server?');
        await sleep(10_000);
        continue;
      }
      if (announcedDown) log(`ASDD server is back at ${API}`);
      announcedDown = false;

      if (!sampling) {
        await sleep(25_000);
        continue;
      }

      const next = await fetch(`${API}/api/llm-bridge/next?wait=25000`, { headers: { 'x-asdd-bridge-token': token } });
      if (next.status === 204) continue;
      if (!next.ok) {
        await sleep(3000);
        continue;
      }
      await serveSampling(await next.json(), token);
    } catch {
      if (!announcedDown) log(`ASDD server not reachable at ${API}; will keep trying`);
      announcedDown = true;
      await sleep(5000);
    }
  }
}

server.server.oninitialized = () => {
  runBridge().catch((err) => log('bridge stopped:', err.message));
};

// When the client goes away, go with it. The bridge loop keeps timers and a long-poll open, so
// without this the process would outlive VS Code stopping it — an orphan still holding the bridge.
server.server.onclose = () => process.exit(0);
process.stdin.on('end', () => process.exit(0));

await server.connect(new StdioServerTransport());
log(`ready — talking to ASDD at ${API}`);
