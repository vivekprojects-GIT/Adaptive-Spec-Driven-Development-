# PRD — ASDD Control Plane

**Method:** ASDD · **Phase:** 2 (Planning) · **Traces to:** product-brief.md

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
| FR-14 | **Any project, not only migrations.** A `custom` project kind assumes no source suite and no target framework | Custom projects raise no gaps and ask no framework questions |
| FR-15 | **Requirements arrive either way** — a pasted line or an imported document | Parser handles both; import reports how many it recognised |
| FR-16 | **Author your own agent**: name, purpose, inputs, output, instructions, and where it runs | An authored agent with instructions is executed, not filed as a note |
| FR-17 | **Author your own guardrail**: rule in plain English, severity, applies-to, on-failure | `on failure: stop` halts the run at that agent and skips the rest |
| FR-18 | **Human approval** closes every run | Run ends `pending`; approve or request changes, recorded on the run |
| FR-19 | **Everything is logged** — API calls, stage changes, agent steps, guardrail verdicts, model calls | Filterable feed with levels and scopes |
| FR-20 | **Dashboard answers "where did it fail"** | Ranks failing guardrails, failing agents, placeholder agents, orphan requirements, open gaps, blocked projects |
| FR-21 | **ASDD document set** written per run: brief, PRD, architecture, epics & stories | Every row derived from the run; unknowns stated, not invented; switchable per project |
| FR-22 | **Templates are starting shapes**, not ready-made runs | A new project from a template has no artifacts and no requirements, and discovery refuses until it does |
| FR-23 | **Approvals inbox** — every outstanding human decision in one place | Sidebar count, per-project count, in-project banner, and a list that links to the resolving screen |
| FR-24 | **Export to folder** — write a run's artifacts into a real repository | Absolute path required; previews the plan; never overwrites without explicit consent; paths cannot escape the target |
| FR-25 | **Runs on the user's existing persona library** — personas, customisations and standing facts read in place | No copy of the library in the repo; team and personal overrides merged by the library's own rules; a missing fact file is reported |
| FR-26 | **ASDD personas are workflow agents** — any persona in the library can be added to a graph | Loads the agent's current persona at run time; output traced and guarded like any other agent |
| FR-27 | **MCP server** exposes ASDD to the editor's assistant | Status, approvals, discovery, proposals, runs, ASDD personas; decision tools act only on the user's explicit instruction |
| FR-28 | **Editor's model with no API key** via MCP sampling | Model setting `copilot` or `auto`; bridge status visible in Settings; each run records the model it used |
| FR-30 | **Runs inside VS Code as skills** — skills Copilot follows in the project folder, with Copilot as the model | `asdd install` adds the skills next to the project's other skills; state, reports and handed-over steps live in the project's `_asdd/`; model-driven steps are handed to the assistant and resume on `submit`; files reach the project only after a preview and a yes |
| FR-29 | **Decisions resume the work** — a halted run continues past its stop; a run with changes requested re-runs from any agent | A halted run cannot be approved as it stands; continue keeps finished work and runs only the skipped agents in the same run, recording the override; a re-run reuses unchanged upstream agents and says why when it cannot |

## 3. Non-functional

- **NFR-1** Zero external services. JSON file persistence. Runs fully offline.
- **NFR-2** Optional model assist — an `ANTHROPIC_API_KEY`, or the editor's model through MCP
  sampling. With neither, the deterministic rule engine runs and the happy path is unaffected.
- **NFR-5** The API binds to loopback by default; the model bridge requires a per-install token.
- **NFR-3** `npm install && npm run dev` is the entire setup. No DB, no Docker, no global installs.
- **NFR-4** Every inference is explainable: each finding carries `why` and `evidence`.

## 4. Out of scope (v1)

Multi-user auth, cloud deployment, actually compiling/running generated code (structure is checked, not
executed), git integration.
