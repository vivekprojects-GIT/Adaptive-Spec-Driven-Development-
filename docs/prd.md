# PRD — ASDD Control Plane

**Method:** BMAD · **Phase:** 2 (Planning) · **Traces to:** product-brief.md

## 1. Scope

A local-first web application (React UI + Node API) implementing the adaptive control plane and an
execution layer over a pluggable Agent Registry and Guardrail Registry.

## 2. Functional requirements

| ID | Requirement | Acceptance |
|----|-------------|------------|
| FR-1 | Create / list / delete **projects**, each holding one spec and many runs | Project persists across restarts |
| FR-2 | **Spec intake**: requirements text, source stack, target stack, pasted or uploaded artifacts | Spec editable until the graph is approved |
| FR-3 | **Project Discovery** derives migration kind, entities, required capabilities, risks, gaps | Report renders with evidence pointing at the artifacts |
| FR-4 | **Agent Factory** searches the registry first; proposes new agents only for unmatched capabilities | Agents labelled `reuse` vs `generated` |
| FR-5 | **Guardrail Designer** maps discovered risks → guardrails, plus project-specific custom rules | Each guardrail names the risk it covers |
| FR-6 | **Human approval** on every proposal: Accept / Reject / Edit / Create own | Nothing executes until the graph is approved |
| FR-7 | **Workflow Composer** builds a dependency DAG from accepted agents and renders it | Cycles rejected; topological order shown |
| FR-8 | **Orchestrator** executes the DAG, streaming per-node status and logs live | SSE stream; run survives a page refresh |
| FR-9 | Execution produces **real artifacts** — analysis JSON, generated target code, data files | Artifacts viewable and downloadable in-app |
| FR-10 | **Validation** runs every accepted guardrail against the artifacts → pass / warn / fail + evidence | Assertions and data counted, not claimed |
| FR-11 | **Report**: traceability matrix (requirement → agent → artifact → guardrail) + Markdown / JSON export | Downloadable from the run page |
| FR-12 | **Registries** browsable and extensible from the UI | A user-added agent is selectable on the next discovery |
| FR-13 | **Capability gaps** surfaced, never silently skipped | Gap states what is missing (parser / connector / runtime) |

## 3. Non-functional

- **NFR-1** Zero external services. JSON file persistence. Runs fully offline.
- **NFR-2** Optional LLM assist (`ANTHROPIC_API_KEY`). Without a key the deterministic rule engine runs
  and the happy path is unaffected.
- **NFR-3** `npm install && npm run dev` is the entire setup. No DB, no Docker, no global installs.
- **NFR-4** Every inference is explainable: each finding carries `why` and `evidence`.

## 4. Out of scope (v1)

Multi-user auth, cloud deployment, actually compiling/running generated code (structure is checked, not
executed), git integration.
