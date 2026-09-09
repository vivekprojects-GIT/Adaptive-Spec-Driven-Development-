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
| Registries | `server/src/registry/*.js` | Seed agents and guardrails, user extensible |
| LLM assist | `server/src/lib/llm.js` | Optional; falls back to rules when no key is set |

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

A **custom project kind** switches off every migration assumption — no source parser is expected, no
emitter, no framework questions, and no capability gaps. The platform contributes only what it can
prove (traceability, structural checks) and the human authors the rest.

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
