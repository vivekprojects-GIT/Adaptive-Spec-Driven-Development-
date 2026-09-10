# Epics & Stories — ASDD

**Method:** BMAD · **Phase:** 4 (Implementation) · **Traces to:** architecture.md

| Epic | Story | Traces | Status |
|---|---|---|---|
| **E1 Foundation** | S1.1 Monorepo, dev script, JSON store | NFR-1, NFR-3 | done |
| | S1.2 Project CRUD + spec intake | FR-1, FR-2 | done |
| **E2 Control plane** | S2.1 Discovery engine (classify, entities, capabilities, risks) | FR-3 | done |
| | S2.2 Agent Factory, registry-first matching + gaps | FR-4, FR-13 | done |
| | S2.3 Guardrail Designer risk→guardrail mapping | FR-5 | done |
| | S2.4 Human approval: accept / reject / edit / create own | FR-6 | done |
| | S2.5 Workflow Composer DAG + cycle detection | FR-7 | done |
| **E3 Execution** | S3.1 Orchestrator with SSE event stream | FR-8 | done |
| | S3.2 Java Selenium analyzer + Playwright TS generator | FR-9 | done |
| | S3.3 Cypress, REST API and JUnit→PyTest adapters | FR-9 | done |
| | S3.4 Generic adapter for generated agents | FR-4 | done |
| **E4 Assurance** | S4.1 Validator: assertion, data, traceability, PII, structure checks | FR-10 | done |
| | S4.2 Traceability matrix + Markdown / JSON export | FR-11 | done |
| **E5 UI** | S5.1 Project list, spec editor, discovery view | FR-1, FR-2, FR-3 | done |
| | S5.2 Proposal review boards (agents, guardrails) | FR-6 | done |
| | S5.3 Workflow graph, live run console, artifact viewer | FR-7, FR-8, FR-9 | done |
| | S5.4 Registry browser + add | FR-12 | done |
| **E6 Human ownership** | S6.1 Custom project kind — no framework assumptions anywhere | FR-14 | done |
| | S6.2 Requirements from a document or a typed line | FR-15 | done |
| | S6.3 Author an agent (purpose, inputs, output, instructions, position) and execute it | FR-16 | done |
| | S6.4 Author a guardrail (rule, severity, applies-to, on-failure) with real stop-on-failure | FR-17 | done |
| | S6.5 Human approval gate closing every run | FR-18 | done |
| **E7 Observability** | S7.1 Structured log across api / run / agent / guardrail / llm | FR-19 | done |
| | S7.2 Failure-first dashboard with live log feed | FR-20 | done |
| **E8 BMAD handover** | S8.1 BMAD Artifact Agent emitting brief / PRD / architecture / epics | FR-21 | done |
| | S8.2 Templates that start empty and hold the run until you supply content | FR-22 | done |
| **E9 Human visibility** | S9.1 Approvals inbox aggregating every pending decision | FR-23 | done |
| | S9.2 Waiting counts in the sidebar, project list, stepper and an in-project banner | FR-23 | done |
| **E10 Handover** | S10.1 Export a run's artifacts to a folder, with a preview and overwrite protection | FR-24 | done |
| **E11 BMAD underneath** | S11.1 Read the user's BMAD install in place, with BMAD's override merge and standing facts | FR-25 | done |
| | S11.2 BMAD persona agents as workflow nodes, persona loaded at run time | FR-26 | done |
| **E12 Editor integration** | S12.1 MCP server exposing ASDD tools, decisions only on explicit instruction | FR-27 | done |
| | S12.2 Model bridge: the editor's model through MCP sampling, no API key | FR-28, NFR-5 | done |
| **E13 Picking up from a decision** | S13.1 Continue a halted run past its stop, recorded as an override | FR-29 | done |
| | S13.2 Re-run from a changed agent, reusing the unchanged agents before it | FR-29 | done |
| **E14 VS Code, BMAD-style** | S14.1 Command line over a per-folder ASDD server, state in the project's `_asdd/` | FR-30 | done |
| | S14.2 ASDD skills and `asdd install`, next to the project's BMAD skills | FR-30 | done |
| | S14.3 Model-driven steps handed to the coding assistant, resumed on submit | FR-30 | done |

## Definition of done (applied to every story)

1. Feature reachable from the UI with no manual API calls.
2. State survives a server restart.
3. Failure path visible to the user (error surfaced, not swallowed).
4. Covered by the smoke test in `server/test/smoke.test.js` where it is testable headlessly.
