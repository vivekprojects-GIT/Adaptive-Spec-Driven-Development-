#!/usr/bin/env node
/**
 * The ASDD command line — how ASDD runs inside VS Code the way BMAD does.
 *
 * Copilot (or any coding assistant), guided by the ASDD skills, runs these commands in the terminal
 * from the project's own folder. Everything lives in that folder:
 *
 *   _asdd/state/    the project's ASDD state — the same store the web dashboard reads
 *   _asdd/handoff/  agent steps handed to the assistant, and the files it hands back
 *   _asdd/reports/  a Markdown report per finished run
 *
 * The first command starts a small ASDD server for the folder in the background (loopback only,
 * a free port). Every command talks to it, so there is exactly one writer, and `asdd ui` shows the
 * very same project the chat is working on.
 *
 * Output is written for the assistant to read and relay: every command ends with a NEXT: line
 * saying what to do — and, where a decision is needed, that the decision is the user's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, '..');
const ASDD_HOME = path.resolve(SERVER_DIR, '..');
const SERVER_ENTRY = path.join(here, 'index.js');
const SKILLS_SOURCE = path.join(ASDD_HOME, 'skills');
const VERSION = JSON.parse(fs.readFileSync(path.join(ASDD_HOME, 'package.json'), 'utf8')).version;
const CMD = 'node _asdd/asdd.mjs';
const SKILL_MARKER = '<!-- installed by ASDD';

class CliError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (...lines) => console.log(lines.join('\n'));
const next = (...lines) => say('', ...lines.map((line, index) => (index === 0 ? `NEXT: ${line}` : `      ${line}`)));
const truncate = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/* ------------------------------------------------------------------ arguments */

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    let value = true;
    if (inline !== undefined) value = inline;
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) value = argv[(index += 1)];
    options[key] = key in options ? [].concat(options[key], value) : value;
  }
  return { positional, options };
}

const list = (value) =>
  (value === undefined || value === true ? [] : [].concat(value))
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);

/* ------------------------------------------------------------------- folders */

const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => Boolean(a && b) && norm(a) === norm(b);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const relPosix = (root, target) => path.relative(root, target).split(path.sep).join('/');

function paths(root) {
  const dir = path.join(root, '_asdd');
  return {
    root,
    dir,
    state: path.join(dir, 'state'),
    portFile: path.join(dir, 'state', 'server.json'),
    log: path.join(dir, 'state', 'server.log'),
    project: path.join(dir, 'project.json'),
    handoff: path.join(dir, 'handoff'),
    reports: path.join(dir, 'reports'),
  };
}

/** The folder BMAD is installed in, if this project (or the folder around it) has one. */
function bmadRootFor(root) {
  for (const dir of [root, path.dirname(root)]) {
    if (fs.existsSync(path.join(dir, '_bmad', '_config', 'skill-manifest.csv'))) return dir;
  }
  return null;
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, visit);
    else if (entry.isFile()) visit(absolute);
  }
}

/* -------------------------------------------------------------------- server */

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** The server already running for this folder, if there is one. */
async function runningServer(p) {
  if (!fs.existsSync(p.portFile)) return null;
  let info;
  try {
    info = JSON.parse(fs.readFileSync(p.portFile, 'utf8'));
  } catch {
    return null;
  }
  const status = await health(info.port);
  return status && samePath(status.workspace, p.root) ? { ...info, base: `http://127.0.0.1:${info.port}` } : null;
}

async function ensureServer(p) {
  const existing = await runningServer(p);
  if (existing) return existing.base;

  if (!fs.existsSync(path.join(ASDD_HOME, 'node_modules', 'express'))) {
    throw new CliError(`ASDD's own dependencies are not installed yet. Run once: cd "${ASDD_HOME}" && npm install`);
  }
  fs.mkdirSync(p.state, { recursive: true });
  fs.rmSync(p.portFile, { force: true });
  const log = fs.openSync(p.log, 'a');
  const bmadRoot = bmadRootFor(p.root);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      ASDD_DATA_DIR: p.state,
      ASDD_PORT_FILE: p.portFile,
      ASDD_WORKSPACE: p.root,
      // From VS Code, agent steps that need a model go to the coding assistant — no API key.
      ASDD_DEFAULT_MODEL: process.env.ASDD_DEFAULT_MODEL || 'assistant',
      // It stops itself when nothing has used it for this long; the next command starts it again.
      ASDD_IDLE_EXIT_MINUTES: process.env.ASDD_IDLE_EXIT_MINUTES || '30',
      ...(bmadRoot ? { ASDD_BMAD_ROOT: bmadRoot } : {}),
    },
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(150);
    const running = await runningServer(p);
    if (running) return running.base;
    if (child.exitCode !== null) break;
  }
  throw new CliError(`The ASDD server for this folder did not start. Its log is ${relPosix(p.root, p.log)}.`);
}

function makeApi(base) {
  return async function api(pathname, { method = 'GET', body } = {}) {
    const response = await fetch(`${base}/api${pathname}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 300) };
    }
    if (!response.ok) throw new CliError(data?.error || `${method} ${pathname} failed (${response.status})`);
    return data;
  };
}

function context(options, positional) {
  const p = paths(path.resolve(String(options.workspace || process.env.ASDD_WORKSPACE_DEFAULT || process.cwd())));
  let api = null;
  return {
    p,
    options,
    positional,
    async api() {
      if (!api) api = makeApi(await ensureServer(p));
      return api;
    },
  };
}

function projectId(p, { required = true } = {}) {
  if (fs.existsSync(p.project)) return JSON.parse(fs.readFileSync(p.project, 'utf8')).projectId;
  if (required) {
    throw new CliError(`There is no ASDD project in this folder yet. Start one with the /asdd-start skill, or: ${CMD} start --name "…" --source <folder> --requirements <file>`);
  }
  return null;
}

async function currentRun(ctx, api) {
  if (ctx.options.run) return api(`/runs/${ctx.options.run}`);
  const project = await api(`/projects/${projectId(ctx.p)}`);
  const latest = project.runs?.[0];
  if (!latest) throw new CliError(`No runs yet. Run the workflow first: ${CMD} run`);
  return api(`/runs/${latest.id}`);
}

async function settle(api, runId, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(300);
  for (;;) {
    const run = await api(`/runs/${runId}`);
    if (!['running', 'queued'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new CliError(`Run ${runId} is still going after ${timeoutMs / 60_000} minutes. Check again with: ${CMD} status`);
    await sleep(400);
  }
}

/* ------------------------------------------------------------- reading files */

const SOURCE_EXTENSIONS = new Set([
  '.java', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.cs', '.rb', '.go', '.kt', '.robot', '.feature',
  '.json', '.csv', '.properties', '.xml', '.yaml', '.yml', '.http', '.sql', '.ini', '.toml', '.txt', '.md',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '_asdd', '_bmad', '_bmad-output', 'dist', 'build', 'target', 'out', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode', '.github', '.claude', '.agents', 'coverage',
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 400;

/** Reads the source material from the folders the user named — never outside the project. */
function collectSources(root, entries) {
  const files = [];
  const skipped = [];
  const visit = (absolute, top) => {
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      if (!top && SKIP_DIRS.has(path.basename(absolute))) return;
      for (const entry of fs.readdirSync(absolute)) visit(path.join(absolute, entry), false);
      return;
    }
    const relative = relPosix(root, absolute);
    if (!SOURCE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) return;
    if (stat.size > MAX_FILE_BYTES) return void skipped.push(`${relative} (larger than 512 KB)`);
    if (files.length >= MAX_FILES) return void skipped.push(`${relative} (over ${MAX_FILES} files)`);
    files.push({ path: relative, content: fs.readFileSync(absolute, 'utf8') });
  };
  for (const entry of entries) {
    const absolute = path.resolve(root, entry);
    if (!inside(root, absolute)) throw new CliError(`${entry} is outside this project folder.`);
    if (!fs.existsSync(absolute)) throw new CliError(`Not found in this project: ${entry}`);
    visit(absolute, true);
  }
  return { files, skipped };
}

function readInside(root, relative) {
  const absolute = path.resolve(root, String(relative));
  if (!inside(root, absolute)) throw new CliError(`${relative} is outside this project folder.`);
  if (!fs.existsSync(absolute)) throw new CliError(`Not found in this project: ${relative}`);
  return fs.readFileSync(absolute, 'utf8');
}

const toArtifact = (file) => ({
  id: `src_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  path: file.path,
  content: file.content,
  bytes: Buffer.byteLength(file.content, 'utf8'),
  addedAt: new Date().toISOString(),
});

/* ------------------------------------------------------------------ printing */

const SOURCE_LABEL = {
  reuse: 'reused from the registry',
  generated: 'generated for this project',
  bmad: 'your BMAD agent',
  custom: 'added by you',
  'author-required': 'placeholder — author your own agent',
  registry: 'from the registry',
};
const NODE_ICON = { done: '✔', failed: '✖', skipped: '⊘', waiting: '⧗', pending: '·', reused: '↺', running: '▶', submitted: '↩' };

function printQuestions(project) {
  const interview = project.interview;
  if (!interview) {
    say('The interview has not run yet.');
    return { blocking: 0 };
  }
  const open = (interview.questions || []).filter((q) => !q.answered);
  const blocking = open.filter((q) => q.required);
  say(`Readiness ${interview.readiness}% · ${blocking.length} blocking question(s), ${open.length - blocking.length} optional.`);
  for (const question of [...blocking, ...open.filter((q) => !q.required)]) {
    say('', `  [${question.required ? 'blocking' : 'optional'}] ${question.id}`, `    ${question.question}`);
    if (question.why) say(`    why it matters: ${truncate(question.why, 240)}`);
    if (question.options?.length) say(`    options: ${question.options.map((o) => (typeof o === 'string' ? o : o.label || o.value)).join(' | ')}`);
  }
  const clarified = (interview.questions || []).filter((q) => q.origin === 'assistant' && q.answered);
  if (clarified.length) say('', 'Clarified in chat:', ...clarified.map((q) => `  • ${q.question} → ${truncate(q.answer, 160)}`));
  return { blocking: blocking.length };
}

function printProposals(project) {
  for (const kind of ['agents', 'guardrails']) {
    const proposals = project.proposals?.[kind] || [];
    const count = (decision) => proposals.filter((p) => p.decision === decision).length;
    say('', `${kind.toUpperCase()} — ${count('proposed')} awaiting a decision, ${count('accepted')} accepted, ${count('rejected')} rejected`);
    for (const proposal of proposals) {
      const what =
        kind === 'agents'
          ? `${proposal.name} — ${SOURCE_LABEL[proposal.source] || proposal.source}${proposal.capability ? ` · ${proposal.capability}` : ''}`
          : `${proposal.name} — ${proposal.severity}, on failure: ${proposal.onFailure || 'flag'}${
              proposal.appliesTo && proposal.appliesTo !== 'workflow' ? `, applies to ${proposal.appliesToLabel || proposal.appliesTo}` : ''
            }`;
      say(`  ${proposal.proposalId}  [${proposal.decision}] ${what}`);
      const why = proposal.rationale || proposal.description;
      if (why) say(`      ${truncate(why, 220)}`);
      if (proposal.warning) say(`      ⚠ ${proposal.warning}`);
    }
  }
}

function printRun(run) {
  say(
    `Run ${run.id}${run.rerunOf ? ` (re-run of ${run.rerunOf.runId}${run.rerunOf.from ? ` from "${run.rerunOf.from}"` : ''})` : ''} — ${run.status}${
      run.validation?.verdict ? ` · verdict ${run.validation.verdict}` : ''
    }`,
  );
  for (const node of run.nodes) {
    const extra = [
      node.reusedFrom ? `reused from ${node.reusedFrom}` : '',
      node.metrics?.handedOff ? 'done by your coding assistant' : '',
      node.metrics?.placeholder ? 'placeholder — did not really run' : '',
    ].filter(Boolean);
    say(`  ${NODE_ICON[node.status] || '·'} ${node.name} — ${node.status}${extra.length ? ` (${extra.join('; ')})` : ''}${node.error ? `: ${node.error}` : ''}`);
  }
  const results = run.validation?.results || [];
  if (results.length) {
    say('', 'Guardrails:');
    for (const result of results) {
      say(`  ${result.status.toUpperCase().padEnd(4)} ${result.name}: ${truncate(result.evidence, 200)}${result.overridden ? ` [stop overridden by ${result.overridden.by}]` : ''}`);
    }
  }
  const files = run.ws?.generated || [];
  if (files.length) {
    say('', `${files.length} file(s) produced: ${files.slice(0, 12).map((a) => a.path).join(', ')}${files.length > 12 ? `, +${files.length - 12} more` : ''}`);
  }
}

/** What happens after any command that moves a run: print it, save its report, say what is next. */
async function afterRun(ctx, run) {
  printRun(run);
  if (run.report && run.status !== 'waiting') {
    fs.mkdirSync(ctx.p.reports, { recursive: true });
    const file = path.join(ctx.p.reports, `${run.id}.md`);
    fs.writeFileSync(file, run.report);
    say('', `Report: ${relPosix(ctx.p.root, file)}`);
  }

  if (run.status === 'waiting') return announceWaiting(ctx, run);
  if (run.status === 'failed') {
    return next(`The run failed: ${run.events?.at(-1)?.message || 'see the log'}. The server log is ${relPosix(ctx.p.root, ctx.p.log)}.`);
  }
  if (run.status === 'halted') {
    const stop = (run.validation?.results || []).find((r) => r.guardrailId === run.validation?.haltedBy);
    return next(
      `A guardrail stopped the run: "${stop?.name}" — ${truncate(stop?.evidence, 200)}`,
      'It cannot be approved as it stands. Ask the user which they want, then act on their answer:',
      `  continue past the stop:  ${CMD} continue --note "<their reason>"`,
      `  send it back:            ${CMD} request-changes --note "<what needs changing>"`,
    );
  }
  if (run.approval?.state === 'pending') {
    return next(
      "The run is waiting for the user's decision. Show them the verdict and the guardrails above, then ask:",
      `  approve:          ${CMD} approve --note "<what they checked>"`,
      `  request changes:  ${CMD} request-changes --note "<what needs changing>"`,
      `To show what would be written into the project first: ${CMD} export   (writes nothing)`,
    );
  }
  if (run.approval?.state === 'approved') return next(`Approved. To put the files into the project: ${CMD} export (preview), then ${CMD} export --yes when the user agrees.`);
  if (run.approval?.state === 'changes-requested' && !run.supersededBy) {
    return next(`Changes were requested. Once they are made: ${CMD} rerun --from "<agent that changed>"`);
  }
  return undefined;
}

function taskMarkdown(ctx, run, node, out) {
  const handoff = node.handoff;
  const outRel = relPosix(ctx.p.root, out);
  const lines = [
    '# ASDD task for your coding assistant',
    '',
    `**Step:** ${node.name} · **Run:** ${run.id} · **Node:** ${node.nodeId}`,
  ];
  if (handoff.bmad) {
    lines.push(`**BMAD agent:** ${handoff.bmad.icon} ${handoff.bmad.name} — ${handoff.bmad.title} (\`${handoff.bmad.id}\`), as customised by ${handoff.bmad.overrides.join(' + ')}`);
  }
  if (handoff.inputs?.length) lines.push(`**Inputs this agent was given:** ${handoff.inputs.join(', ')}`);
  lines.push(
    '',
    'The user approved this workflow. This one step needs thinking rather than rules, so ASDD hands it to you. Do it as described below, with the project open in front of you.',
    '',
    '## Who you are for this step',
    '',
    handoff.system,
    '',
    '## The task',
    '',
    handoff.task,
    '',
    '## Handing the work back',
    '',
    `1. Write every file this step produces under \`${outRel}/\`, at the path it should have in the project — for example \`${outRel}/${handoff.outputDir}/review.md\` becomes \`${handoff.outputDir}/review.md\`. Do not change files anywhere else for this step.`,
    '2. You may read any file in the project to do this well.',
    `3. If something essential is missing, ask the user in chat. If you go ahead on an assumption, write it in \`${outRel}/NOTES.md\` — that is recorded as the agent's notes, not as a project file.`,
    `4. When the files are written, run \`${CMD} submit\`. ASDD records them as this agent's output, runs its guardrails, and carries on with the workflow.`,
    '',
  );
  return lines.join('\n');
}

const ON_FAILURE_TEXT = { stop: 'the run stops here for the user', flag: 'it is flagged and the run carries on', continue: 'it is recorded only' };

function judgeMarkdown(run, items) {
  const lines = [
    '# Rules for your coding assistant to judge',
    '',
    `**Run:** ${run.id}`,
    '',
    'The user wrote these rules in plain English. There is no rule engine for them, so ASDD asks you to judge each one against the files the run produced — those files, nothing else.',
    '',
    '- **pass** only if the files demonstrably satisfy the rule.',
    '- **fail** if they demonstrably break it.',
    '- **warn** if they do not contain enough to decide.',
    '- Quote the specific evidence you used. Do not change any files.',
    '',
  ];
  for (const item of items) {
    lines.push(
      `## ${item.name}  (\`${item.guardrailId}\`)`,
      '',
      `**Rule:** ${item.rule}`,
      `**Applies to:** ${item.scope} · **Severity:** ${item.severity} · **If it fails:** ${ON_FAILURE_TEXT[item.onFailure] || item.onFailure}`,
      '',
    );
    if (item.facts && Object.keys(item.facts).length) lines.push(`**Source facts:** ${JSON.stringify(item.facts)}`, '');
    lines.push('````', item.digest || '(no files)', '````', '', `Record it: \`${CMD} judge ${item.guardrailId} pass|warn|fail "<the evidence you saw>"\``, '');
  }
  return lines.join('\n');
}

function announceJudgement(ctx, run) {
  const items = run.waitingFor.items || [];
  const dir = path.join(ctx.p.handoff, `${run.id}-rules`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'JUDGE.md');
  fs.writeFileSync(file, judgeMarkdown(run, items));
  say(
    '',
    `⚖ WAITING FOR YOU — the coding assistant. Judge ${items.length} rule(s) the user wrote${run.waitingFor.agent ? `, on the work of "${run.waitingFor.agent}"` : ', across the whole workflow'}:`,
    ...items.map((item) => `  • ${item.name} (${item.guardrailId}) — "${truncate(item.rule, 160)}"`),
    `  Evidence:  ${relPosix(ctx.p.root, file)}   ← the rules, and the files they apply to`,
    `  Then, for each rule:  ${CMD} judge <guardrailId> pass|warn|fail "<the evidence you saw>"`,
  );
  return next(
    'Judge each rule strictly on the files in JUDGE.md: pass only if they demonstrably satisfy it, fail if they demonstrably break it, warn if they do not show enough to decide. Quote what you saw.',
    'A fail on a rule set to "stop" stops the run — what happens then is the user\'s decision, not yours.',
  );
}

function announceWaiting(ctx, run) {
  if (run.waitingFor?.kind === 'judgement') return announceJudgement(ctx, run);
  const node = run.nodes.find((n) => n.status === 'waiting');
  if (!node?.handoff) return say('The run is waiting, but no step is marked as handed over yet. Check again in a moment.');
  const dir = path.join(ctx.p.handoff, `${run.id}-${node.nodeId}`);
  const out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });
  const taskFile = path.join(dir, 'TASK.md');
  fs.writeFileSync(taskFile, taskMarkdown(ctx, run, node, out));
  const bmad = node.handoff.bmad ? ` — BMAD ${node.handoff.bmad.icon} ${node.handoff.bmad.name}, ${node.handoff.bmad.title}` : '';
  say(
    '',
    `⧗ WAITING FOR YOU — the coding assistant. This step is yours to do: "${node.name}"${bmad}.`,
    `  Task:         ${relPosix(ctx.p.root, taskFile)}   ← read all of it and follow it`,
    `  Write files:  ${relPosix(ctx.p.root, out)}/   (each at the path it should have in the project, e.g. ${node.handoff.outputDir}/…)`,
    `  Then run:     ${CMD} submit`,
  );
  return next('Do this step yourself now, as the task describes. Ask the user only if something essential is missing.');
}

/* ------------------------------------------------------------------ commands */

async function cmdInstall(ctx) {
  const { p, options } = ctx;
  if (!fs.existsSync(p.root) || !fs.statSync(p.root).isDirectory()) throw new CliError(`${p.root} is not a folder.`);
  if (samePath(p.root, ASDD_HOME)) throw new CliError('Run this from your project folder (or pass --workspace <folder>), not from ASDD\'s own folder.');

  let skillsDir = null;
  if (options.skills && options.skills !== true) {
    skillsDir = path.resolve(p.root, String(options.skills));
    if (!inside(p.root, skillsDir)) throw new CliError('--skills must be a folder inside the project.');
  } else {
    // Next to the project's other skills — BMAD's, if it is installed — so they appear together.
    const existing = ['.github/skills', '.claude/skills', '.agents/skills'].find((dir) => fs.existsSync(path.join(p.root, dir)));
    skillsDir = path.join(p.root, existing || '.github/skills');
  }

  const installed = [];
  const kept = [];
  for (const name of fs.readdirSync(SKILLS_SOURCE)) {
    const source = path.join(SKILLS_SOURCE, name, 'SKILL.md');
    if (!fs.existsSync(source)) continue;
    const target = path.join(skillsDir, name, 'SKILL.md');
    if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes(SKILL_MARKER) && !options.force) {
      kept.push(relPosix(p.root, target));
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    installed.push(relPosix(p.root, target));
  }

  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(path.join(p.dir, 'asdd.mjs'), SHIM_SOURCE);
  fs.writeFileSync(
    path.join(p.dir, 'config.json'),
    `${JSON.stringify({ asddHome: ASDD_HOME, version: VERSION, skillsDir: relPosix(p.root, skillsDir), installedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  const gitignore = path.join(p.dir, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '# Machine state and hand-over scratch. Reports and project.json are worth keeping.\nstate/\nhandoff/\n');

  say(`ASDD ${VERSION} installed in ${p.root}`, '', 'Skills (Copilot Chat lists them when you type /):', ...installed.map((file) => `  + ${file}`));
  if (kept.length) say('Left alone — a skill of yours already has this name:', ...kept.map((file) => `  = ${file}`));
  say(`Command: ${CMD} <command>   (the skills run it for you)`);

  const mcp = options['no-mcp'] ? 'skipped' : installMcpConfig(p.root);
  const entryText = JSON.stringify(MCP_ENTRY);
  say(
    {
      created: 'MCP: created .vscode/mcp.json with the "asdd" server — ASDD\'s tools in Copilot Chat, on this folder\'s server.',
      added: 'MCP: added the "asdd" server to .vscode/mcp.json — ASDD\'s tools in Copilot Chat, on this folder\'s server.',
      present: 'MCP: .vscode/mcp.json already has the "asdd" server.',
      kept: `MCP: .vscode/mcp.json already has a different "asdd" server — left alone. For this folder's tools, use: "asdd": ${entryText}`,
      unreadable: `MCP: .vscode/mcp.json is not plain JSON (comments?) — left alone. Add under "servers": "asdd": ${entryText}`,
      skipped: 'MCP: skipped (--no-mcp).',
    }[mcp],
  );

  const bmadRoot = bmadRootFor(p.root);
  say(bmadRoot ? `BMAD: found in ${bmadRoot} — your BMAD agents can be workflow steps.` : 'BMAD: not installed here. Everything works without it; to add it: npx bmad-method install');
  if (!fs.existsSync(path.join(ASDD_HOME, 'node_modules', 'express'))) say(`⚠ ASDD's dependencies are missing. Run once: cd "${ASDD_HOME}" && npm install`);
  next('Open this folder in VS Code, open Copilot Chat in Agent mode, and type /asdd-start.');
}

async function cmdStart(ctx) {
  const { p, options } = ctx;
  if (projectId(p, { required: false }) && !options.new) {
    throw new CliError(`This folder already has an ASDD project. To re-read its files: ${CMD} sync   To start over: add --new`);
  }
  const sources = list(options.source);
  const { files, skipped } = sources.length ? collectSources(p.root, sources) : { files: [], skipped: [] };
  const requirementsText = options['requirements-text'] && options['requirements-text'] !== true ? String(options['requirements-text']) : '';
  const requirementsFile = options.requirements && options.requirements !== true ? String(options.requirements) : null;
  if (!requirementsFile && !requirementsText) {
    throw new CliError('Where are the requirements? Pass --requirements <file in the project> or --requirements-text "<a few lines>".');
  }
  const requirementsContent = requirementsFile ? readInside(p.root, requirementsFile) : requirementsText;

  const api = await ctx.api();
  const name = options.name && options.name !== true ? String(options.name) : path.basename(p.root);
  const spec = {
    projectKind: options.kind === 'custom' ? 'custom' : 'migration',
    sourceStack: options['source-stack'] && options['source-stack'] !== true ? String(options['source-stack']) : '',
    targetStack: options['target-stack'] && options['target-stack'] !== true ? String(options['target-stack']) : '',
    constraints: options.constraints && options.constraints !== true ? String(options.constraints) : '',
    workspace: { sources, requirements: requirementsFile },
  };
  const project = await api('/projects', { method: 'POST', body: { name, description: `Project folder: ${p.root}`, spec } });
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.project, `${JSON.stringify({ projectId: project.id, name, createdAt: new Date().toISOString() }, null, 2)}\n`);

  if (files.length) await api(`/projects/${project.id}/artifacts`, { method: 'POST', body: files });
  const imported = await api(`/projects/${project.id}/requirements/import`, {
    method: 'POST',
    body: { content: requirementsContent, path: requirementsFile || 'typed in chat', mode: 'replace' },
  });
  const assessed = await api(`/projects/${project.id}/interview`, { method: 'POST', body: { withLlm: false } });

  say(
    `Started "${name}" (${spec.projectKind}) in ${p.root}`,
    `  ${files.length} source file(s) read from ${sources.join(', ') || '(none given)'}`,
    `  ${imported.extracted.length} requirement(s) recognised from ${requirementsFile || 'the typed text'}`,
  );
  if (skipped.length) say(`  skipped: ${skipped.join(', ')}`);
  say('');
  const { blocking } = printQuestions(assessed);
  if (blocking) {
    return next(
      'Ask the user each blocking question above (with its "why it matters"), and record their answer in their words:',
      `  ${CMD} answer <questionId> "<their answer>"`,
    );
  }
  return next(`Nothing blocks. Run discovery and review the proposals with the user: ${CMD} discover   (the /asdd-review skill)`);
}

async function cmdSync(ctx) {
  const api = await ctx.api();
  const id = projectId(ctx.p);
  const project = await api(`/projects/${id}`);
  const workspace = project.spec.workspace || {};
  const sources = list(ctx.options.source).length ? list(ctx.options.source) : workspace.sources || [];
  const requirementsFile = ctx.options.requirements && ctx.options.requirements !== true ? String(ctx.options.requirements) : workspace.requirements;

  const changes = [];
  if (sources.length) {
    const { files, skipped } = collectSources(ctx.p.root, sources);
    const before = new Map((project.spec.artifacts || []).map((a) => [a.path, a.content]));
    const added = files.filter((f) => !before.has(f.path)).map((f) => f.path);
    const changed = files.filter((f) => before.has(f.path) && before.get(f.path) !== f.content).map((f) => f.path);
    const removed = [...before.keys()].filter((p) => !files.some((f) => f.path === p));
    await api(`/projects/${id}/spec`, { method: 'PUT', body: { artifacts: files.map(toArtifact), workspace: { ...workspace, sources, requirements: requirementsFile } } });
    say(`Source files: ${files.length} read — ${added.length} new, ${changed.length} changed, ${removed.length} gone.`);
    for (const [label, items] of [['new', added], ['changed', changed], ['gone', removed]]) if (items.length) say(`  ${label}: ${items.join(', ')}`);
    if (skipped.length) say(`  skipped: ${skipped.join(', ')}`);
    if (added.length || changed.length || removed.length) changes.push('source files');
  }
  if (requirementsFile) {
    const imported = await api(`/projects/${id}/requirements/import`, { method: 'POST', body: { content: readInside(ctx.p.root, requirementsFile), path: requirementsFile, mode: 'replace' } });
    say(`Requirements: ${imported.extracted.length} recognised from ${requirementsFile}.`);
    if (imported.project.spec.requirements !== project.spec.requirements) changes.push('requirements');
  }
  const assessed = await api(`/projects/${id}/interview`, { method: 'POST', body: { withLlm: false } });
  say('');
  printQuestions(assessed);
  if (changes.length && project.discovery) {
    return next(
      `The ${changes.join(' and ')} changed since discovery ran. To refresh the proposals: ${CMD} discover`,
      'Tell the user first: new proposals replace the current ones, so their accept/reject decisions are asked for again.',
    );
  }
  return next(changes.length ? `Carry on with ${CMD} discover when nothing blocks.` : 'Nothing changed.');
}

async function cmdStatus(ctx) {
  const id = projectId(ctx.p, { required: false });
  if (!id) {
    say(`No ASDD project in this folder yet (${ctx.p.root}).`);
    return next(`Start one with the /asdd-start skill, or: ${CMD} start --name "…" --source <folder> --requirements <file>`);
  }
  const api = await ctx.api();
  const [project, inbox, status] = await Promise.all([api(`/projects/${id}`), api('/approvals'), api('/health')]);
  const spec = project.spec;
  const requirements = String(spec.requirements || '').split('\n').filter((line) => line.trim()).length;
  const agents = project.proposals?.agents || [];
  const guardrails = project.proposals?.guardrails || [];
  say(
    `${project.name} — stage: ${project.stage}`,
    `  kind: ${spec.projectKind}${spec.sourceStack ? ` · ${spec.sourceStack} → ${spec.targetStack}` : ''}`,
    `  ${spec.artifacts?.length || 0} source file(s), ${requirements} requirement(s)`,
    `  interview: ${project.interview ? `${project.interview.readiness}% ready, ${project.interview.blockingCount} blocking` : 'not run'}`,
    `  proposals: ${agents.filter((a) => a.decision === 'accepted').length}/${agents.length} agents and ${guardrails.filter((g) => g.decision === 'accepted').length}/${guardrails.length} guardrails accepted`,
    `  model: ${status.llm.detail}`,
  );
  const mine = inbox.items.filter((item) => item.projectId === id);
  if (mine.length) say('', 'Waiting on a person:', ...mine.map((item) => `  • ${item.title} — ${truncate(item.detail, 180)}`));

  const latest = project.runs?.[0];
  if (latest) {
    say('');
    return afterRun(ctx, await api(`/runs/${latest.id}`));
  }
  if (!project.interview || project.interview.blockingCount > 0) return next(`Answer the open questions: ${CMD} interview`);
  if (!project.discovery) return next(`Run discovery: ${CMD} discover`);
  if (agents.some((a) => a.decision === 'proposed')) return next(`Review the proposals with the user: ${CMD} proposals`);
  return next(`Run the workflow when the user is ready: ${CMD} run`);
}

async function cmdInterview(ctx) {
  const api = await ctx.api();
  const { blocking } = printQuestions(await api(`/projects/${projectId(ctx.p)}`));
  return blocking
    ? next('Ask the user each blocking question and record their answer in their words:', `  ${CMD} answer <questionId> "<their answer>"`)
    : next(`Nothing blocks. Next: ${CMD} discover`);
}

async function cmdAnswer(ctx) {
  const [questionId, ...words] = ctx.positional;
  const answer = ctx.options.answer && ctx.options.answer !== true ? String(ctx.options.answer) : words.join(' ');
  if (!questionId || !answer.trim()) throw new CliError(`${CMD} answer <questionId> "<the user's answer>"`);
  const api = await ctx.api();
  const project = await api(`/projects/${projectId(ctx.p)}/interview/answer`, { method: 'POST', body: { questionId, answer } });
  say(`Recorded the answer to ${questionId}.`, '');
  const { blocking } = printQuestions(project);
  return blocking ? next(`${blocking} blocking question(s) left — ask the user.`) : next(`Nothing blocks any more. Next: ${CMD} discover`);
}

async function cmdDiscover(ctx) {
  const api = await ctx.api();
  let project;
  try {
    project = await api(`/projects/${projectId(ctx.p)}/discover`, { method: 'POST', body: { force: Boolean(ctx.options.force) } });
  } catch (err) {
    throw new CliError(err.message.replace('or pass force:true to proceed anyway', `or, only if the user says to go ahead anyway, add --force`));
  }
  const discovery = project.discovery;
  say(discovery.summary);
  if (discovery.risks?.length) say('', 'Risks found:', ...discovery.risks.map((r) => `  ${r.severity}: ${r.label}`));
  if (discovery.gaps?.length) say('', 'Capability gaps — nothing can do these yet:', ...discovery.gaps.map((g) => `  ${g.capability} — needs ${g.needs}`));
  printProposals(project);
  return next(
    'Show the user these proposals and record only their decisions:',
    `  ${CMD} accept <id>   ${CMD} reject <id>   ${CMD} accept all   (every undecided agent and guardrail)`,
    `  ${CMD} edit <id> --set name="…" --set instructions="…"`,
    `  their own agent:  ${CMD} add-agent --name "…" --purpose "…" --instructions "…"   (or --bmad <role> for one of their BMAD agents)`,
    `  their own rule:   ${CMD} add-guardrail --name "…" --rule "…" --on-failure stop|flag|continue`,
    `When they are happy with the list: ${CMD} run`,
  );
}

async function cmdProposals(ctx) {
  const api = await ctx.api();
  const project = await api(`/projects/${projectId(ctx.p)}`);
  if (!project.discovery) throw new CliError(`Discovery has not run yet: ${CMD} discover`);
  printProposals(project);
  return undefined;
}

function kindOf(project, proposalId) {
  for (const kind of ['agents', 'guardrails']) {
    const proposal = (project.proposals?.[kind] || []).find((p) => p.proposalId === proposalId);
    if (proposal) return { kind, proposal };
  }
  throw new CliError(`No proposal "${proposalId}". List them with: ${CMD} proposals`);
}

async function cmdDecide(ctx, action) {
  const target = ctx.positional[0];
  if (!target) throw new CliError(`Which one? ${CMD} ${action} <proposalId>   or   ${CMD} ${action} all [--agents|--guardrails]`);
  const api = await ctx.api();
  const id = projectId(ctx.p);
  let project = await api(`/projects/${id}`);
  if (target === 'all') {
    const kinds = ctx.options.agents ? ['agents'] : ctx.options.guardrails ? ['guardrails'] : ['agents', 'guardrails'];
    for (const kind of kinds) {
      project = await api(`/projects/${id}/proposals/${kind}/bulk`, { method: 'POST', body: { action, only: typeof ctx.options.only === 'string' ? ctx.options.only : undefined } });
    }
  } else {
    const { kind } = kindOf(project, target);
    project = await api(`/projects/${id}/proposals/${kind}/${target}`, { method: 'POST', body: { action } });
  }
  printProposals(project);
  return undefined;
}

const MODEL_DRIVEN = new Set(['instructionAgent', 'bmadPersonaAgent']);

async function cmdEdit(ctx) {
  const target = ctx.positional[0];
  // Values are free text (instructions, names), so they are taken whole — never split on commas.
  const sets = (ctx.options.set === undefined ? [] : [].concat(ctx.options.set)).filter((item) => item !== true).map(String);
  if (!target || !sets.length) throw new CliError(`${CMD} edit <proposalId> --set key=value [--set key=value …]`);
  const api = await ctx.api();
  const id = projectId(ctx.p);
  const { kind, proposal } = kindOf(await api(`/projects/${id}`), target);

  const patch = {};
  for (const pair of sets) {
    const equals = pair.indexOf('=');
    if (equals < 1) throw new CliError(`--set needs key=value, got "${pair}".`);
    const key = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1);
    if (['instructions', 'purpose', 'output'].includes(key)) {
      if (kind !== 'agents' || !MODEL_DRIVEN.has(proposal.impl)) {
        throw new CliError(`"${proposal.name}" runs built-in code, so it has no ${key} to edit. Add an agent of your own instead: ${CMD} add-agent …`);
      }
      const field = key === 'output' ? 'outputDescription' : key;
      patch.authored = { ...(proposal.authored || {}), ...(patch.authored || {}), [field]: value };
      if (key === 'purpose') patch.description = value;
    } else if (key === 'on-failure' || key === 'onFailure') patch.onFailure = value;
    else if (key === 'applies-to' || key === 'appliesTo') patch.appliesTo = value;
    else patch[key] = value;
  }
  const project = await api(`/projects/${id}/proposals/${kind}/${target}`, { method: 'POST', body: { action: 'edit', patch } });
  say(`Edited and accepted ${proposal.name} (${target}): ${Object.keys(patch).join(', ')}.`);
  printProposals(project);
  return undefined;
}

const INPUT_KEYS = ['requirements', 'constraints', 'artifacts', 'sourceModel', 'generated'];

function resolveAgentRef(ref, accepted, what) {
  const query = String(ref).toLowerCase();
  const match =
    accepted.find((a) => a.agentId === ref || a.proposalId === ref) ||
    accepted.find((a) => a.name.toLowerCase() === query) ||
    accepted.find((a) => a.name.toLowerCase().includes(query));
  if (!match) throw new CliError(`No accepted agent matches "${ref}" for ${what}. Accepted agents: ${accepted.map((a) => a.name).join(', ') || 'none'}`);
  return match;
}

async function cmdAddAgent(ctx) {
  const o = ctx.options;
  const text = (key) => (o[key] && o[key] !== true ? String(o[key]) : undefined);
  const api = await ctx.api();
  const id = projectId(ctx.p);
  const project = await api(`/projects/${id}`);
  const accepted = (project.proposals?.agents || []).filter((a) => a.decision === 'accepted');

  let agentId;
  if (o.bmad) {
    const bmadAgents = (await api('/registry')).agents.filter((a) => a.source === 'bmad');
    const query = String(o.bmad).toLowerCase();
    const match = bmadAgents.find(
      (a) =>
        a.id === query ||
        a.id === `bmad.${query}` ||
        a.id === `bmad.bmad-agent-${query}` ||
        a.bmad?.role === query ||
        a.name.toLowerCase().startsWith(query),
    );
    if (!match) {
      throw new CliError(
        bmadAgents.length
          ? `No BMAD agent "${o.bmad}". Yours: ${bmadAgents.map((a) => `${a.bmad?.role || a.id} (${a.name})`).join(', ')}`
          : 'No BMAD install was found for this project. Install BMAD here (npx bmad-method install), then try again.',
      );
    }
    agentId = match.id;
  }
  if (!text('name') && !agentId) {
    throw new CliError(`${CMD} add-agent --name "…" --purpose "…" --instructions "…" [--inputs ${INPUT_KEYS.join(',')}] [--files java,csv] [--output "…"] [--after <agent>|start|end]   (or --bmad <role>)`);
  }
  const inputs = list(o.inputs);
  const unknown = inputs.filter((key) => !INPUT_KEYS.includes(key));
  if (unknown.length) throw new CliError(`Unknown input(s): ${unknown.join(', ')}. Choose from: ${INPUT_KEYS.join(', ')}`);

  const after = text('after');
  const runAfter = !after || after === 'end' || after === 'start' ? after || 'end' : resolveAgentRef(after, accepted, '--after').agentId;
  const before = new Set((project.proposals?.agents || []).map((a) => a.proposalId));
  const updated = await api(`/projects/${id}/proposals/agents`, {
    method: 'POST',
    body: {
      agentId,
      name: text('name'),
      purpose: text('purpose'),
      instructions: text('instructions'),
      inputSelections: inputs,
      artifactFilter: text('files') || '',
      outputDescription: text('output'),
      runAfter,
      saveToRegistry: Boolean(o.save),
    },
  });
  const added = updated.proposals.agents.find((a) => !before.has(a.proposalId));
  say(`Added and accepted: ${added.name} (${added.proposalId}) — ${SOURCE_LABEL[added.source] || added.source}, runs ${added.authored?.runAfterLabel || 'at the end'}.`);
  if (MODEL_DRIVEN.has(added.impl)) say('When the run reaches it, the step is handed to you, the coding assistant, to do.');
  return next(`Show the user the updated list (${CMD} proposals), or run when they are ready: ${CMD} run`);
}

async function cmdAddGuardrail(ctx) {
  const o = ctx.options;
  const text = (key) => (o[key] && o[key] !== true ? String(o[key]) : undefined);
  if (!text('name') || (!text('rule') && !text('check'))) {
    throw new CliError(`${CMD} add-guardrail --name "…" --rule "<plain English>" [--severity blocker|major|minor] [--applies-to workflow|<agent>] [--on-failure stop|flag|continue]`);
  }
  const onFailure = text('on-failure') || 'flag';
  if (!['stop', 'flag', 'continue'].includes(onFailure)) throw new CliError('--on-failure is stop, flag or continue.');
  const severity = text('severity') || 'major';
  if (!['blocker', 'major', 'minor'].includes(severity)) throw new CliError('--severity is blocker, major or minor.');

  const api = await ctx.api();
  const id = projectId(ctx.p);
  const project = await api(`/projects/${id}`);
  const accepted = (project.proposals?.agents || []).filter((a) => a.decision === 'accepted');
  const target = text('applies-to');
  const agent = target && target !== 'workflow' ? resolveAgentRef(target, accepted, '--applies-to') : null;

  const before = new Set((project.proposals?.guardrails || []).map((g) => g.proposalId));
  const updated = await api(`/projects/${id}/proposals/guardrails`, {
    method: 'POST',
    body: {
      name: text('name'),
      rule: text('rule'),
      check: text('check'),
      severity,
      onFailure,
      appliesTo: agent ? agent.agentId : 'workflow',
      appliesToLabel: agent ? agent.name : 'The whole workflow',
    },
  });
  const added = updated.proposals.guardrails.find((g) => !before.has(g.proposalId));
  say(`Added and accepted: ${added.name} (${added.proposalId}) — ${severity}, on failure: ${onFailure}, applies to ${added.appliesToLabel}.`);
  if (added.check === 'customRule') say('A rule in plain English is judged when a model is available; otherwise it asks the user to sign it off.');
  return undefined;
}

async function cmdBmad(ctx) {
  const api = await ctx.api();
  const bmad = await api('/bmad');
  if (!bmad.found) {
    say(`No BMAD install found (looked in: ${bmad.searched.join(', ')}).`);
    return next('Everything else works without it. To add BMAD to this project: npx bmad-method install');
  }
  say(`BMAD ${bmad.version} in ${bmad.root}${bmad.user ? ` · user ${bmad.user}` : ''}`, '');
  for (const agent of bmad.agents) {
    const customised = agent.overrides.filter((layer) => layer !== 'base');
    say(`  ${agent.icon} ${agent.name} — ${agent.title}   role: ${agent.role}${customised.length ? `   customised: ${customised.join(' + ')}` : ''}`);
  }
  say('', `${bmad.workflows.length} workflow(s) available to you directly as BMAD skills.`);
  return next(`To make one a step in the workflow: ${CMD} add-agent --bmad <role> [--instructions "…"] [--after "<agent>"]`);
}

async function cmdRun(ctx) {
  const api = await ctx.api();
  const id = projectId(ctx.p);
  const project = await api(`/projects/${id}`);
  if (!project.discovery) throw new CliError(`Discovery has not run yet: ${CMD} discover`);
  const latest = project.runs?.[0];
  if (latest && ['running', 'queued', 'waiting'].includes(latest.status)) {
    throw new CliError(`Run ${latest.id} is ${latest.status === 'waiting' ? 'waiting on you (the coding assistant) — see: ' + CMD + ' task' : 'still going'}. Finish it before starting another.`);
  }
  const agents = project.proposals?.agents || [];
  if (!agents.some((a) => a.decision === 'accepted')) throw new CliError(`No agents are accepted yet, so there is nothing to run. Review them: ${CMD} proposals`);
  const undecided = agents.filter((a) => a.decision === 'proposed').length;
  if (undecided) say(`Note: ${undecided} agent proposal(s) are still undecided and will not run.`);

  const composed = await api(`/projects/${id}/compose`, { method: 'POST' });
  if (!composed.graph?.order?.length) throw new CliError(`Nothing to run: ${(composed.graph?.errors || []).join(' ')}`);
  const byId = new Map(composed.graph.nodes.map((node) => [node.nodeId, node.name]));
  say(`Workflow: ${composed.graph.order.map((nodeId) => byId.get(nodeId)).join(' → ')}`);
  if (composed.graph.errors?.length) say(`Warnings: ${composed.graph.errors.join(' ')}`);

  const { runId } = await api(`/projects/${id}/runs`, { method: 'POST' });
  say(`Running ${runId}…`, '');
  return afterRun(ctx, await settle(api, runId));
}

async function cmdTask(ctx) {
  const api = await ctx.api();
  const run = await currentRun(ctx, api);
  if (run.status !== 'waiting') return say(`Nothing is waiting on the coding assistant. Run ${run.id} is ${run.status}.`);
  return announceWaiting(ctx, run);
}

async function cmdSubmit(ctx) {
  const api = await ctx.api();
  const run = await currentRun(ctx, api);
  if (run.status !== 'waiting') throw new CliError(`Run ${run.id} is ${run.status}, not waiting on the coding assistant. Nothing to submit.`);
  if (run.waitingFor?.kind === 'judgement') {
    throw new CliError(`Run ${run.id} is waiting for verdicts on rules, not for files. See: ${CMD} task   and record each with: ${CMD} judge <guardrailId> pass|warn|fail "<evidence>"`);
  }
  const node = run.nodes.find((n) => n.status === 'waiting');
  const out = path.join(ctx.p.handoff, `${run.id}-${node.nodeId}`, 'out');
  if (!fs.existsSync(out)) {
    announceWaiting(ctx, run);
    throw new CliError(`Write the step's files under ${relPosix(ctx.p.root, out)}/ first.`);
  }

  const files = [];
  const notes = [];
  walk(out, (absolute) => {
    const relative = relPosix(out, absolute);
    const content = fs.readFileSync(absolute, 'utf8');
    if (relative === 'NOTES.md') notes.push(...content.split('\n').map((line) => line.replace(/^\s*[-*]\s*/, '').trim()).filter((line) => line && !line.startsWith('#')));
    else files.push({ path: relative, content });
  });
  if (ctx.options.notes && ctx.options.notes !== true) notes.push(String(ctx.options.notes));
  if (!files.length) throw new CliError(`No files under ${relPosix(ctx.p.root, out)}/ yet. Write the step's files there, then submit.`);

  const result = await api(`/runs/${run.id}/nodes/${node.nodeId}/submit`, {
    method: 'POST',
    body: { files, notes, by: 'your coding assistant (VS Code)' },
  });
  say(`↩ Handed back ${result.files.length} file(s) for "${node.name}": ${result.files.join(', ')}. The run carries on…`, '');
  return afterRun(ctx, await settle(api, run.id));
}

const byWhom = (ctx) => (ctx.options.by && ctx.options.by !== true ? String(ctx.options.by) : 'human (via VS Code)');
const noteOf = (ctx) => (ctx.options.note && ctx.options.note !== true ? String(ctx.options.note) : '');

async function cmdApproval(ctx, state) {
  const api = await ctx.api();
  const run = await currentRun(ctx, api);
  const approval = await api(`/runs/${run.id}/approval`, { method: 'POST', body: { state, note: noteOf(ctx), by: byWhom(ctx) } });
  say(`${state === 'approved' ? '✔ Approved' : '↩ Changes requested on'} ${run.id} — recorded as ${approval.by}${approval.note ? `: "${approval.note}"` : ''}.`);
  if (state === 'approved') {
    return next(`To put the files into the project: ${CMD} export shows the plan and writes nothing; ${CMD} export --yes writes it once the user agrees.`);
  }
  return next(
    'Help the user make the change they asked for, for example:',
    `  edit an agent:  ${CMD} edit <proposalId> --set instructions="…"`,
    `  add an agent:   ${CMD} add-agent …      add a rule: ${CMD} add-guardrail …`,
    `Then re-run from the agent that changed — the unchanged ones before it are reused: ${CMD} rerun --from "<agent name>"`,
  );
}

async function cmdContinue(ctx) {
  const api = await ctx.api();
  const run = await currentRun(ctx, api);
  const started = await api(`/runs/${run.id}/continue`, { method: 'POST', body: { note: noteOf(ctx), by: byWhom(ctx) } });
  say(`▶ Continuing ${run.id} past "${started.overrode}" — ${started.continuing.length} agent(s) left to run…`, '');
  return afterRun(ctx, await settle(api, run.id));
}

async function cmdRerun(ctx) {
  const api = await ctx.api();
  const id = projectId(ctx.p);
  const run = await currentRun(ctx, api);
  let fromNodeId;
  const from = ctx.options.from && ctx.options.from !== true ? String(ctx.options.from) : null;
  if (from) {
    const query = from.toLowerCase();
    const node = run.nodes.find((n) => n.nodeId === from) || run.nodes.find((n) => n.name.toLowerCase() === query) || run.nodes.find((n) => n.name.toLowerCase().includes(query));
    if (!node) throw new CliError(`No agent matching "${from}" in ${run.id}. Its agents: ${run.nodes.map((n) => n.name).join(', ')}`);
    fromNodeId = node.nodeId;
  }
  // The workflow picks up any agent the user edited since the run.
  await api(`/projects/${id}/compose`, { method: 'POST' });
  const started = await api(`/runs/${run.id}/rerun`, { method: 'POST', body: { fromNodeId, note: noteOf(ctx), by: byWhom(ctx) } });
  say(
    `↻ Re-running as ${started.runId}${started.from ? ` from "${started.from}"` : ''} — reusing ${started.reused.length ? started.reused.join(', ') : 'nothing'}.`,
    ...started.reasons.map((reason) => `  ${reason}`),
    '',
  );
  return afterRun(ctx, await settle(api, started.runId));
}

const EXPORT_LABEL = { create: '+ create   ', overwrite: '! overwrite', 'skip-exists': '= keep     ', blocked: '✖ blocked  ' };

async function cmdExport(ctx) {
  const api = await ctx.api();
  const run = await currentRun(ctx, api);
  if (['running', 'queued', 'waiting'].includes(run.status)) throw new CliError(`Run ${run.id} is ${run.status}; export it when it has finished.`);
  const to = ctx.options.to && ctx.options.to !== true ? String(ctx.options.to) : null;
  const target = to ? path.resolve(ctx.p.root, to) : ctx.p.root;
  const yes = Boolean(ctx.options.yes);
  const overwrite = Boolean(ctx.options.overwrite);
  const include = ctx.options.include ? list(ctx.options.include) : undefined;
  const result = await api(`/runs/${run.id}/export`, { method: 'POST', body: { targetDir: target, dryRun: !yes, overwrite, include } });

  if (!yes) {
    say(`Export plan for ${run.id} → ${result.root}   (nothing written yet)`);
    for (const file of result.files) say(`  ${EXPORT_LABEL[file.status] || file.status} ${file.path}${file.reason ? ` — ${file.reason}` : ''}`);
    const s = result.summary;
    say('', `${s.create} to create, ${s.overwrite} to overwrite, ${s.skipExists} already exist and are kept, ${s.blocked} blocked.`);
    if (run.approval?.state !== 'approved') say(`Note: run ${run.id} is ${run.approval?.state || run.status}, not approved.`);
    return next(
      'Show this plan to the user. Write it only when they say so:',
      `  ${CMD} export --yes${overwrite ? ' --overwrite' : ''}${to ? ` --to "${to}"` : ''}`,
      'Existing files are kept unless the user explicitly asks to overwrite them (--overwrite).',
    );
  }
  say(`Wrote ${result.written.length} file(s) into ${result.root}:`, ...result.written.map((file) => `  + ${relPosix(ctx.p.root, file.absolute)}`));
  if (result.skipped.length) say(`Kept ${result.skipped.length} existing file(s) unchanged: ${result.skipped.map((file) => file.path).join(', ')}`);
  if (result.blocked.length) say(`Blocked: ${result.blocked.map((file) => `${file.path} (${file.reason})`).join(', ')}`);
  if (result.errors.length) say(`Failed: ${result.errors.map((e) => `${e.path}: ${e.error}`).join(', ')}`);
  return undefined;
}

async function cmdReport(ctx) {
  const api = await ctx.api();
  const run = await currentRun(ctx, api);
  if (!run.report) return say(`Run ${run.id} has no report yet (${run.status}).`);
  fs.mkdirSync(ctx.p.reports, { recursive: true });
  const file = path.join(ctx.p.reports, `${run.id}.md`);
  fs.writeFileSync(file, run.report);
  return say(`Report for ${run.id}: ${relPosix(ctx.p.root, file)}`);
}

async function cmdUi(ctx) {
  const base = await ensureServer(ctx.p);
  if (!fs.existsSync(path.join(ASDD_HOME, 'web', 'dist', 'index.html'))) {
    return say(`The dashboard is not built yet. Build it once: cd "${ASDD_HOME}" && npm run build`, `Then open ${base}`);
  }
  say(
    `ASDD dashboard for this folder: ${base}`,
    'It shows the same project, runs and approvals as the chat — a decision made in either place shows up in both.',
    'In VS Code: Command Palette → "Simple Browser: Show" → paste the address.',
  );
  if (ctx.options.open) {
    const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', base]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [base]];
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  return undefined;
}

async function cmdStop(ctx) {
  const running = await runningServer(ctx.p);
  if (!running) {
    fs.rmSync(ctx.p.portFile, { force: true });
    return say('No ASDD server is running for this folder.');
  }
  try {
    process.kill(running.pid);
  } catch (err) {
    throw new CliError(`Could not stop the ASDD server (PID ${running.pid}): ${err.message}`);
  }
  fs.rmSync(ctx.p.portFile, { force: true });
  return say(`Stopped the ASDD server for this folder (PID ${running.pid}). The project stays in _asdd/.`);
}

async function cmdJudge(ctx) {
  const [guardrailId, status, ...words] = ctx.positional;
  const evidence = ctx.options.evidence && ctx.options.evidence !== true ? String(ctx.options.evidence) : words.join(' ');
  if (!guardrailId || !['pass', 'warn', 'fail'].includes(status) || !evidence.trim()) {
    throw new CliError(`${CMD} judge <guardrailId> pass|warn|fail "<the evidence you saw>"`);
  }
  const api = await ctx.api();
  const run = await currentRun(ctx, api);
  const result = await api(`/runs/${run.id}/judgements`, {
    method: 'POST',
    body: { verdicts: [{ guardrailId, status, evidence }], by: 'your coding assistant (VS Code)' },
  });
  if (!result.resumed) {
    say(`Recorded ${status} for ${guardrailId}.`, `Still to judge: ${result.outstanding.map((o) => `${o.name} (${o.guardrailId})`).join(', ')}`);
    return next(`Judge the rest: ${CMD} judge <guardrailId> pass|warn|fail "<the evidence you saw>"`);
  }
  say(`Recorded ${status} for ${guardrailId}. Every rule is judged — the run carries on…`, '');
  return afterRun(ctx, await settle(api, run.id));
}

async function cmdClarify(ctx) {
  const [question, ...words] = ctx.positional;
  const answer = ctx.options.answer && ctx.options.answer !== true ? String(ctx.options.answer) : words.join(' ');
  if (!question?.trim() || !answer.trim()) {
    throw new CliError(`${CMD} clarify "<the question you asked>" "<the user's answer>" [--why "<why it matters>"]`);
  }
  const api = await ctx.api();
  await api(`/projects/${projectId(ctx.p)}/interview/questions`, {
    method: 'POST',
    body: { question, answer, why: ctx.options.why && ctx.options.why !== true ? String(ctx.options.why) : '', by: 'your coding assistant (VS Code)' },
  });
  return say(
    `Recorded: "${truncate(question, 160)}" → "${truncate(answer, 160)}".`,
    'It is part of the spec now (constraints), so discovery and every agent read it, and the report lists it.',
  );
}

/** VS Code starts this over stdio. Stdout belongs to the MCP protocol, so nothing is printed. */
async function cmdMcp(ctx) {
  const base = await ensureServer(ctx.p);
  process.env.ASDD_API = base;
  // Where this folder's server keeps the editor-bridge token.
  process.env.ASDD_DATA_DIR = ctx.p.state;
  process.env.ASDD_WORKSPACE = ctx.p.root;
  await import('./mcp.js');
}

const MCP_ENTRY = { type: 'stdio', command: 'node', args: ['${workspaceFolder}/_asdd/asdd.mjs', 'mcp'] };

/** Adds the "asdd" MCP server to the project's .vscode/mcp.json — never over one of the user's. */
function installMcpConfig(root) {
  const file = path.join(root, '.vscode', 'mcp.json');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ servers: { asdd: MCP_ENTRY } }, null, 2)}\n`);
    return 'created';
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 'unreadable';
  }
  config.servers = config.servers || {};
  if (config.servers.asdd) return JSON.stringify(config.servers.asdd) === JSON.stringify(MCP_ENTRY) ? 'present' : 'kept';
  config.servers.asdd = MCP_ENTRY;
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return 'added';
}

function cmdHelp() {
  say(
    `ASDD ${VERSION} — Adaptive Spec Driven Development, run from your project folder.`,
    '',
    `Usage: ${CMD} <command> [options]        (from VS Code, the /asdd-* skills run these for you)`,
    '',
    'Set up',
    '  install [--skills <dir>]          add the ASDD skills to this project (next to BMAD\'s, if present)',
    '  start --name <n> --source <dir> --requirements <file> | --requirements-text "<lines>"',
    '        [--kind migration|custom] [--source-stack "<…>"] [--target-stack "<…>"] [--constraints "<…>"]',
    '  sync                              re-read the source files and requirements',
    '  status                            where things stand, and what is waiting on the user',
    '  interview | answer <id> "<text>"  the open questions, and recording the user\'s answers',
    '',
    'Shape the workflow (each change is the user\'s decision)',
    '  discover [--force]                find capabilities, risks and gaps; propose agents and guardrails',
    '  proposals                         list them',
    '  accept|reject <id>|all [--agents|--guardrails]',
    '  edit <id> --set key=value         e.g. --set instructions="…"   --set severity=blocker',
    '  add-agent --name … --purpose … --instructions … [--inputs …] [--files …] [--output …] [--after <agent>]',
    '  add-agent --bmad <role> [--instructions …] [--after <agent>]   one of your BMAD agents as a step',
    '  add-guardrail --name … --rule … [--severity …] [--applies-to <agent>] [--on-failure stop|flag|continue]',
    '  bmad                              your BMAD agents',
    '',
    'Run and decide',
    '  run                               compose the accepted agents and run them',
    '  task | submit [--notes …]         the step handed to the coding assistant, and handing its files back',
    '  approve | request-changes [--note …]',
    '  continue [--note …]               carry a halted run on past its stop (recorded as an override)',
    '  rerun [--from <agent>] [--note …] re-run from a changed agent, reusing the unchanged ones before it',
    '  export [--to <dir>] [--yes] [--overwrite]   preview, then write the files into the project',
    '  report                            save the latest run\'s report under _asdd/reports/',
    '',
    'Other',
    '  ui [--open]                       the dashboard for this folder (same state as the chat)',
    '  stop                              stop this folder\'s ASDD server (it also stops itself after 30 idle minutes)',
    '  mcp                               ASDD\'s MCP tools on this folder\'s server (VS Code runs this; see .vscode/mcp.json)',
    '',
    'For the coding assistant',
    '  clarify "<question>" "<answer>"   record a question you asked the user, with their answer',
    '  judge <guardrailId> pass|warn|fail "<evidence>"   your verdict on a plain-English rule the run is waiting on',
  );
}

const SHIM_SOURCE = `#!/usr/bin/env node
// Runs ASDD for this project folder. Written by "asdd install" - run that again if ASDD moves.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { asddHome } = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
const cli = join(process.env.ASDD_HOME || asddHome, 'server', 'src', 'cli.js');
if (!existsSync(cli)) {
  console.error('ASDD is not at ' + cli + ' any more. From the ASDD folder run: node server/src/cli.js install --workspace "' + dirname(here) + '"');
  process.exit(1);
}
process.env.ASDD_WORKSPACE_DEFAULT = dirname(here);
await import(pathToFileURL(cli).href);
`;

const COMMANDS = {
  install: cmdInstall,
  start: cmdStart,
  sync: cmdSync,
  status: cmdStatus,
  interview: cmdInterview,
  answer: cmdAnswer,
  discover: cmdDiscover,
  proposals: cmdProposals,
  accept: (ctx) => cmdDecide(ctx, 'accept'),
  reject: (ctx) => cmdDecide(ctx, 'reject'),
  edit: cmdEdit,
  'add-agent': cmdAddAgent,
  'add-guardrail': cmdAddGuardrail,
  bmad: cmdBmad,
  run: cmdRun,
  task: cmdTask,
  submit: cmdSubmit,
  approve: (ctx) => cmdApproval(ctx, 'approved'),
  'request-changes': (ctx) => cmdApproval(ctx, 'changes-requested'),
  continue: cmdContinue,
  rerun: cmdRerun,
  export: cmdExport,
  report: cmdReport,
  ui: cmdUi,
  stop: cmdStop,
  judge: cmdJudge,
  clarify: cmdClarify,
  mcp: cmdMcp,
  help: cmdHelp,
};

async function main(argv) {
  const [command = 'help', ...rest] = argv;
  if (command === '--version' || command === '-v') return say(`asdd ${VERSION}`);
  const handler = COMMANDS[command];
  if (!handler) throw new CliError(`Unknown command "${command}". ${CMD} help lists them.`);
  const { positional, options } = parseArgs(rest);
  return handler(context(options, positional));
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof CliError ? `✖ ${err.message}` : `✖ ${err.stack || err.message}`);
  process.exitCode = 1;
});
