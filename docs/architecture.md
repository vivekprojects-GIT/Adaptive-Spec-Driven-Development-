# Architecture — ASDD

**Method:** BMAD · **Phase:** 3 (Solutioning) · **Traces to:** prd.md

## 1. The invariant (the spine)

> The control plane **derives** the execution layer. Execution never hard-codes an agent list.

Three consequences every module must honour:

1. **Registry-first.** Capability → registry lookup → reuse. Generation is the fallback; a gap is the floor.
2. **Human gate.** No proposal becomes a graph node without an explicit accept.
3. **Evidence or silence.** A guardrail verdict must be computed from artifacts. Unverifiable → `warn`,
   never `pass`.

## 2. Layers

```
 UI (React/Vite)  ──HTTP + SSE──▶  API (Express)
                                      │
                       ┌──────────────┴──────────────┐
                       │        CONTROL PLANE        │
                       │  discovery → agent factory  │
                       │  → guardrail designer       │
                       │  → workflow composer        │
                       └──────────────┬──────────────┘
                                      │ approved graph
                       ┌──────────────┴──────────────┐
                       │       EXECUTION LAYER       │
                       │  orchestrator → agent impls │
                       │  → validator → reporter     │
                       └──────────────┬──────────────┘
                                      │
                              JSON store (server/data)
```

## 3. Key modules

| Module | File | Responsibility |
|---|---|---|
| Discovery | `server/src/engine/discovery.js` | Classify migration, extract entities, required capabilities, risks |
| Agent Factory | `server/src/engine/agentFactory.js` | Registry search → reuse / generate / gap |
| Guardrail Designer | `server/src/engine/guardrailDesigner.js` | Risk → guardrail mapping plus custom proposals |
| Workflow Composer | `server/src/engine/workflowComposer.js` | Accepted agents → validated DAG + topological order |
| Orchestrator | `server/src/engine/orchestrator.js` | Executes the DAG, emits events, collects artifacts |
| Agent impls | `server/src/engine/agents.js` | The actual work (analyzers, generators, mappers) |
| Validator | `server/src/engine/validator.js` | Runs guardrail checks against artifacts |
| Reporter | `server/src/engine/reporter.js` | Traceability matrix + Markdown export |
| Registries | `server/src/registry/*.js` | Seed agents and guardrails, user extensible; BMAD agents listed live |
| BMAD loader | `server/src/bmad/loader.js` | Reads the user's BMAD install in place; applies BMAD's override merge |
| LLM assist | `server/src/lib/llm.js` | Optional; Anthropic key, else the editor bridge, else rules |
| Model bridge | `server/src/lib/bridge.js` | Queues model requests for the MCP server to answer by sampling |
| MCP server | `server/src/mcp.js` | Thin client of the API: tools for the assistant + the sampling loop |

## 3a. Who owns what

> AI proposes the migration architecture; the human owns the final architecture.

| The platform proposes | The human decides |
|---|---|
| Capabilities required, risks found, gaps that block | Which agents run, in what order, reading what |
| Registry agents that match, guardrails that cover each risk | Accept / Reject / Edit / **Create my own** on every proposal |
| Verdicts computed from artifacts | Whether the run is accepted at all (approval gate) |

An **authored agent** (`impl: instructionAgent`) is a first-class node: its instructions, chosen
input sources, expected output and graph position travel with it and are executed. With no model
configured it writes the fully resolved brief and states that it did not run — it never fabricates.

An **authored guardrail** (`check: customRule`) carries a plain-English rule, an `appliesTo` target
and an `onFailure` policy. `stop` is honoured mid-run: guardrails scoped to an agent execute the
moment that agent finishes, so the workflow halts there instead of reporting the failure afterwards.

A halt is not a dead end, and a decision never restarts the work from scratch:

- **Continue** — `prepareContinue` marks the halting check `overridden: { by, note, at }` and resets
  the skipped nodes to pending; `executeRun(…, { resume: true })` carries the *same* run on. Finished
  nodes and their scoped checks stand, the workspace is restored from `run.ws`, and workflow-level
  checks re-run over the full artifact set. An overridden failure no longer blocks, but the verdict
  can never read `passed`. A halted run cannot be approved as it stands.
- **Re-run** — `prepareRerun` creates a new run. `planRerun` walks the old and new workflows in order
  and reuses the unbroken prefix of agents that are the same, unchanged and finished, stopping at the
  requested agent — or earlier at the first that changed or did not finish, or at the top when the
  spec/answers/discovery hash differs. Each run records which node last wrote each piece of shared
  workspace state (`wsWriters`), so a reused prefix carries over exactly the state it produced.

A **custom project kind** switches off every migration assumption — no source parser is expected, no
emitter, no framework questions, and no capability gaps. The platform contributes only what it can
prove (traceability, structural checks) and the human authors the rest.

## 3b. BMAD underneath, the editor's model alongside

ASDD is a layer on BMAD, not a replacement. `loadBmad()` reads `_bmad/_config/skill-manifest.csv`,
finds each skill's `SKILL.md` at its manifest path or wherever the IDE installed it
(`.claude/skills/…`), and merges `customize.toml` ← `_bmad/custom/<id>.toml` ← `<id>.user.toml` with
BMAD's rules (scalars override, tables deep-merge, keyed arrays-of-tables replace or append, other
arrays append). Persona agents appear in the registry as `bmad.<id>` with `impl: bmadPersonaAgent`;
a graph node stores only the BMAD id, so every run loads the persona as it is *now*.

The model bridge exists because an HTTP server cannot call an editor's model directly — only an MCP
client can, through sampling. So:

```
engine ─ assist() ─▶ bridge queue ◀─ long-poll ─ mcp.js ─ sampling/createMessage ─▶ VS Code model
       ◀──── text ── bridge queue ◀── POST result ──┘
```

The poll and the result are authenticated with a token written to the git-ignored data directory
on start; the API listens on 127.0.0.1. Sampling is one completion with no tools, so a BMAD agent
here does one bounded task; BMAD's interactive workflows stay in the assistant.

## 3c. Running from a project folder, BMAD-style

`asdd install` copies the skills in `skills/` into the project's skills folder and writes a launcher,
`_asdd/asdd.mjs`, that finds this ASDD install. The first command starts a server for that folder
(`PORT=0`, loopback, `ASDD_DATA_DIR=<project>/_asdd/state`, `ASDD_WORKSPACE`, `ASDD_BMAD_ROOT`)
and records its port in `_asdd/state/server.json`; every later command is an HTTP client of it, so
there is still exactly one writer and the dashboard shows the same state.

That server defaults the model to `assistant`. A model-driven agent then returns `{ handoff }`
instead of calling a model: the node goes `waiting`, the run stops (neither finished nor failed),
and the command line writes `_asdd/handoff/<run>-<node>/TASK.md`. The assistant writes the files
under `out/` and runs `submit`; `prepareSubmission` records them as the node's output and marks it
`submitted`, and `executeRun(…, { resume: true })` runs that node's scoped checks and the rest.

Plain-English guardrails (`customRule`) work the same way. In assistant mode the check returns
`pending` with the rule, its scope and the files; the run pauses with `waitingFor.kind =
'judgement'` (the agent's own checks marked `checksPending`, so they re-run on resume). The
assistant records a verdict with evidence per rule (`prepareJudgement`); on resume the check finds
it in `run.judgements`, and a failed "stop" rule halts the run exactly as any other check would.
Questions the assistant asks the user are recorded through `interview/questions`: they join the
interview, survive re-assessment, and are appended to the spec's constraints.

The folder's server exits after `ASDD_IDLE_EXIT_MINUTES` (30 from the command line) with no open
request, no activity and no run in progress. `install` also adds `node _asdd/asdd.mjs mcp` to the
project's `.vscode/mcp.json`, which starts the MCP server against that same folder server.

## 4. Contracts

**Capability** — the unit of matchmaking: `{ id, label, tags[] }`. Agents *provide* capabilities;
discovery *requires* them. Everything adaptive hangs off this single join.

**Agent record** — `{ id, name, capability, inputs[], outputs[], impl, source: registry | generated }`.
`impl` names a function in the agent implementation map. A generated agent with no implementation falls
back to `genericAdapter` and is flagged in the report.

**Guardrail record** — `{ id, name, risk, severity, check }` where `check` names a validator function
returning `{ status, evidence }` with status in `pass | warn | fail`.

## 5. Data flow of a run

```
spec → discovery report → proposals (agents, guardrails) → human decisions
     → graph → run → artifacts → guardrail verdicts → report
```

Every stage is persisted, so any run is fully reconstructible after a restart.

## 6. Extension path

Adding **Cypress → Playwright** requires: one registry agent entry with `impl: 'cypressAnalyzer'`, one
implementation function, and one discovery classifier rule. No orchestrator, UI, or schema change.
