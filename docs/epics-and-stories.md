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

## Definition of done (applied to every story)

1. Feature reachable from the UI with no manual API calls.
2. State survives a server restart.
3. Failure path visible to the user (error surfaced, not swallowed).
4. Covered by the smoke test in `server/test/smoke.test.js` where it is testable headlessly.
