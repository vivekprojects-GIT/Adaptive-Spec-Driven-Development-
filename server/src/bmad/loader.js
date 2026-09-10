/**
 * BMAD loader — reads the user's real BMAD install instead of reimplementing its agents.
 *
 * ASDD sits ON TOP of BMAD: BMAD supplies the agents (Mary, John, Winston, Sally, Amelia) and the
 * workflows; ASDD supplies the control plane, guardrails, approvals, traceability and UI. So the
 * personas come from BMAD's own files, merged exactly the way BMAD merges them:
 *
 *   {skill}/customize.toml                 base   (installer-owned)
 *   _bmad/custom/{skill}.toml              team   (committed)
 *   _bmad/custom/{skill}.user.toml         user   (personal)
 *
 *   scalars override · tables deep-merge · arrays of tables keyed by `code`/`id` replace-or-append
 *   · every other array appends
 *
 * A team override that adds regulatory facts to Winston therefore reaches ASDD intact — which is
 * the whole point of running on BMAD rather than beside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');
const MANIFEST = ['_bmad', '_config', 'skill-manifest.csv'];
const CACHE_MS = 10_000;

/* ------------------------------------------------------------ discovery */

export function isBmadRoot(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, ...MANIFEST));
}

/**
 * Where BMAD lives. ASDD is usually cloned INSIDE a BMAD workspace, so the parent folder is the
 * natural default; an explicit path (Settings) or ASDD_BMAD_ROOT wins when given.
 */
export function bmadRootCandidates(explicit) {
  return [explicit, process.env.ASDD_BMAD_ROOT, path.dirname(REPO_ROOT), REPO_ROOT]
    .filter(Boolean)
    .map((dir) => path.resolve(dir));
}

export function findBmadRoot(explicit) {
  return bmadRootCandidates(explicit).find(isBmadRoot) || null;
}

/* -------------------------------------------------------------- parsers */

/** RFC 4180 CSV — BMAD descriptions contain commas and doubled quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((value) => value.trim()));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((key, i) => [key.trim(), (r[i] ?? '').trim()])));
}

/** SKILL.md frontmatter: flat `key: value`, values optionally single- or double-quoted. */
export function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: String(text) };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    meta[kv[1]] = value;
  }
  return { meta, body: String(text).slice(match[0].length) };
}

/** BMAD's module config.yaml is flat `key: value`; no YAML dependency needed for it. */
export function parseFlatYaml(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[kv[1]] = value;
  }
  return out;
}

function readToml(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return parseToml(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { __error: err.message };
  }
}

/* ---------------------------------------------------------------- merge */

const isTable = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const keyOf = (item) => (isTable(item) ? item.code ?? item.id : undefined);

/** BMAD's structural merge, exactly as its resolver documents it. */
export function bmadMerge(base, override) {
  if (override === undefined) return base;
  if (base === undefined) return override;

  if (Array.isArray(base) && Array.isArray(override)) {
    const keyed = override.length > 0 && [...base, ...override].every((item) => keyOf(item) !== undefined);
    if (!keyed) return [...base, ...override];
    const out = base.map((item) => ({ ...item }));
    for (const item of override) {
      const index = out.findIndex((existing) => keyOf(existing) === keyOf(item));
      if (index >= 0) out[index] = { ...item };
      else out.push({ ...item });
    }
    return out;
  }

  if (isTable(base) && isTable(override)) {
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) out[key] = bmadMerge(base[key], value);
    return out;
  }

  return override;
}

function resolveBlock(skillDir, root, skillId, key) {
  const layers = [
    ['base', path.join(skillDir, 'customize.toml')],
    ['team', path.join(root, '_bmad', 'custom', `${skillId}.toml`)],
    ['user', path.join(root, '_bmad', 'custom', `${skillId}.user.toml`)],
  ];
  let block = {};
  const applied = [];
  const problems = [];
  for (const [label, file] of layers) {
    const doc = readToml(file);
    if (!doc) continue;
    if (doc.__error) {
      problems.push(`${label} customization ${path.relative(root, file)} is not valid TOML: ${doc.__error}`);
      continue;
    }
    if (doc[key]) {
      block = bmadMerge(block, doc[key]);
      applied.push(label);
    }
  }
  return { block, applied, problems };
}

/* ------------------------------------------------------------- skills */

/**
 * The manifest's `path` is BMAD's canonical layout, but an IDE install copies skills elsewhere —
 * for Claude Code, into `.claude/skills/`. Try the canonical path, then each IDE location.
 */
function resolveSkillFile(root, row) {
  const candidates = [
    row.path && path.resolve(root, row.path),
    path.join(root, '.claude', 'skills', row.canonicalId, 'SKILL.md'),
    path.join(root, '.github', 'skills', row.canonicalId, 'SKILL.md'),
    path.join(root, '.agents', 'skills', row.canonicalId, 'SKILL.md'),
  ].filter(Boolean);
  // A manifest entry must not point outside the install.
  return candidates.find((file) => file.startsWith(root) && fs.existsSync(file)) || null;
}

function sectionOf(body, heading) {
  const match = String(body).match(new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm'));
  return match ? match[1].trim() : '';
}

function groupFor(row) {
  const p = row.path || '';
  if (/\/agents\//.test(p)) return 'Agents';
  if (/\/plan\//.test(p)) return 'Planning';
  if (/\/ship\//.test(p)) return 'Implementation';
  if (row.module === 'core') return 'Core';
  return row.module || 'Other';
}

/** Where a BMAD persona naturally sits in an ASDD graph, by the phase it owns in BMAD. */
const PERSONA_PHASE = { analyst: 15, pm: 18, 'ux-designer': 22, architect: 25, dev: 35 };

/* ------------------------------------------------------------ facts */

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '(?:.*/)?';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.data', '_bmad-output']);

function expandGlob(pattern) {
  const normalised = pattern.replace(/\\/g, '/');
  if (!/[*?]/.test(normalised)) {
    return fs.existsSync(normalised) && fs.statSync(normalised).isFile() ? [normalised] : [];
  }
  const segments = normalised.split('/');
  const firstGlob = segments.findIndex((segment) => /[*?]/.test(segment));
  const base = segments.slice(0, firstGlob).join('/') || '/';
  const matcher = globToRegex(segments.slice(firstGlob).join('/'));

  const found = [];
  let visited = 0;
  (function walk(dir, relative) {
    if (visited > 5000 || found.length >= 20) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (matcher.test(rel)) found.push(full);
    }
  })(base, '');
  return found;
}

/**
 * Resolves BMAD persistent facts. `file:` entries load the referenced contents (globs allowed),
 * `skill:` entries are noted, everything else is a literal fact. A fact that points at a missing
 * file is reported as missing rather than silently dropped.
 */
export function resolveFacts(entries = [], root, { maxBytes = 12000 } = {}) {
  let budget = maxBytes;
  return entries.map((raw) => {
    const entry = String(raw);
    if (entry.startsWith('file:')) {
      const files = expandGlob(entry.slice(5).trim().replace(/\{project-root\}/g, root));
      if (!files.length) return { entry, kind: 'file', missing: true, files: [], text: '' };
      const parts = [];
      for (const file of files) {
        if (budget <= 0) break;
        const content = fs.readFileSync(file, 'utf8').slice(0, budget);
        budget -= content.length;
        parts.push(`--- ${path.relative(root, file).replace(/\\/g, '/')}\n${content}`);
      }
      return { entry, kind: 'file', files: files.map((f) => path.relative(root, f).replace(/\\/g, '/')), text: parts.join('\n\n') };
    }
    if (entry.startsWith('skill:')) {
      return { entry, kind: 'skill', text: `(references the BMAD skill "${entry.slice(6).trim()}", which runs in the assistant)` };
    }
    return { entry, kind: 'literal', text: entry };
  });
}

/* ---------------------------------------------------------------- load */

let cache = null;

/**
 * @returns {{ found, root, searched, version, config, agents, workflows, deprecated, problems }}
 */
export function loadBmad({ root: explicit, force = false } = {}) {
  const root = findBmadRoot(explicit);
  if (!root) {
    return { found: false, root: null, searched: bmadRootCandidates(explicit), version: null, config: {}, agents: [], workflows: [], deprecated: [], problems: [] };
  }
  if (!force && cache && cache.root === root && Date.now() - cache.at < CACHE_MS) return cache.value;

  const problems = [];
  const rows = parseCsv(fs.readFileSync(path.join(root, ...MANIFEST), 'utf8'));
  const manifestYaml = path.join(root, '_bmad', '_config', 'manifest.yaml');
  const version = fs.existsSync(manifestYaml) ? (fs.readFileSync(manifestYaml, 'utf8').match(/version:\s*([\d.]+)/) || [])[1] || null : null;

  const bmmConfigFile = path.join(root, '_bmad', 'bmm', 'config.yaml');
  const config = fs.existsSync(bmmConfigFile) ? parseFlatYaml(fs.readFileSync(bmmConfigFile, 'utf8')) : {};
  const coreToml = readToml(path.join(root, '_bmad', 'config.toml')) || {};
  if (coreToml.__error) problems.push(`_bmad/config.toml is not valid TOML: ${coreToml.__error}`);

  const agents = [];
  const workflows = [];
  const deprecated = [];

  for (const row of rows) {
    if (!row.canonicalId) continue;
    if (/^deprecated\b/i.test(row.description)) {
      deprecated.push(row.canonicalId);
      continue;
    }

    const skillFile = resolveSkillFile(root, row);
    const isAgent = row.canonicalId.startsWith('bmad-agent-');
    if (!skillFile) {
      problems.push(`${row.canonicalId} is in the manifest but its SKILL.md is not installed.`);
      continue;
    }

    const { meta, body } = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
    const skillDir = path.dirname(skillFile);
    const base = {
      id: row.canonicalId,
      module: row.module,
      group: groupFor(row),
      description: meta.description || row.description,
      skillFile: path.relative(root, skillFile).replace(/\\/g, '/'),
    };

    if (isAgent) {
      const { block, applied, problems: layerProblems } = resolveBlock(skillDir, root, row.canonicalId, 'agent');
      problems.push(...layerProblems);
      const declared = coreToml.agents?.[row.canonicalId] || {};
      const role = row.canonicalId.replace(/^bmad-agent-/, '');
      agents.push({
        ...base,
        kind: 'agent',
        role,
        name: block.name || declared.name || role,
        title: block.title || declared.title || '',
        icon: block.icon || declared.icon || '',
        overview: sectionOf(body, 'Overview'),
        phase: PERSONA_PHASE[role] ?? 25,
        persona: {
          role: block.role || '',
          identity: block.identity || '',
          communication_style: block.communication_style || '',
          principles: block.principles || [],
          persistent_facts: block.persistent_facts || [],
          menu: block.menu || [],
        },
        overrides: applied,
      });
    } else {
      const { block, applied, problems: layerProblems } = resolveBlock(skillDir, root, row.canonicalId, 'workflow');
      problems.push(...layerProblems);
      workflows.push({ ...base, kind: 'workflow', name: meta.name || row.canonicalId, overview: sectionOf(body, 'Overview'), workflow: block, overrides: applied });
    }
  }

  const value = { found: true, root, searched: [root], version, config, agents, workflows, deprecated, problems };
  cache = { root, at: Date.now(), value };
  return value;
}

/** Finds an agent by id, short role, or persona name — "bmad-agent-architect", "architect", "Winston". */
export function findBmadAgent(query, bmad = loadBmad()) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  return (
    bmad.agents.find((agent) => agent.id.toLowerCase() === q) ||
    bmad.agents.find((agent) => agent.id.toLowerCase() === `bmad-agent-${q}`) ||
    bmad.agents.find((agent) => agent.name.toLowerCase() === q) ||
    bmad.agents.find((agent) => agent.title.toLowerCase().includes(q)) ||
    null
  );
}

/**
 * The system prompt that makes a model BE this BMAD persona for one ASDD step. Built entirely
 * from BMAD's own definitions — overview, role, identity, style, principles, standing facts.
 */
export function personaPrompt(agent, { facts = [], config = {} } = {}) {
  const p = agent.persona || {};
  const sections = [
    `You are ${agent.name}${agent.title ? `, ${agent.title}` : ''} — a BMAD Method agent (${agent.id}).`,
    agent.overview,
    p.role && `Role: ${p.role}`,
    p.identity && `Identity: ${p.identity}`,
    p.communication_style && `Communication style: ${p.communication_style}`,
    p.principles?.length && `Principles:\n${p.principles.map((principle) => `- ${principle}`).join('\n')}`,
  ];

  const standing = facts.filter((fact) => fact.text).map((fact) => (fact.kind === 'file' ? fact.text : `- ${fact.text}`));
  if (standing.length) sections.push(`Standing facts you must respect:\n${standing.join('\n')}`);
  if (config.communication_language) sections.push(`Communicate in ${config.communication_language}.`);

  sections.push(
    'You are running inside ASDD as one step of a workflow a human has already approved — not as an interactive chat. ' +
      'Do the task in a single pass and do not ask the user questions. Where the inputs are insufficient, say exactly what is missing rather than inventing it.',
  );
  return sections.filter(Boolean).join('\n\n');
}
