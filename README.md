# ASDD — Adaptive Spec Driven Development

A migration-adaptive AI control plane, built with the BMAD method.

> **Requirements determine the workflow, the workflow determines the agents,
> and the identified risks determine the guardrails.**

Give it a spec (requirements + source stack + target stack + source files). It interviews you about
anything it does not know, discovers what is really being migrated, composes an agent graph from a
reusable registry, proposes guardrails matched to the risks it found, waits for your approval, runs
the migration, and proves what it did with computed evidence.

It is not a Selenium-to-Playwright tool. Selenium → Playwright is one path through it.

---

## Run it

```bash
npm install
npm run dev
```

That is the whole setup. No database, no Docker, no API key, no global installs.

- UI → **http://localhost:5173**
- API → **http://localhost:5174**

Then click **Create project** on any sample and walk the nine steps across the top. The
`Selenium (Java) → Playwright (TypeScript)` sample is the one to start with: 2 suites, 5 tests,
6 assertions, a CSV fixture, a hardcoded password, and one `JavascriptExecutor` call that genuinely
cannot be migrated.

Other useful commands:

```bash
npm test          # engine smoke tests — the whole pipeline, no network, ~4s
npm run seed      # create the flagship sample project without using the UI
npm run build     # build the UI
npm start         # single process on :5174 serving the built UI + API
```

### In VS Code

Open the folder and press <kbd>F5</kbd> to debug the API (`.vscode/launch.json`), or run
`npm run dev` in the integrated terminal. Recommended extensions are suggested on first open.

---

## What you can do from the UI

Everything. There is no step that requires curl or editing a file by hand.

| Step | What happens |
|---|---|
| **1 Spec** | Type requirements, name the stacks, upload or paste source files |
| **2 Interview** | The platform asks what it does not know and **blocks fulfilment until you answer**. Each question says *why* it matters and what changes based on your answer |
| **3 Discovery** | Classifies source/target, parses the artifacts, counts entities, emits required **capabilities**, **risks**, and honest **capability gaps** |
| **4 Agents** | Agent Factory proposals — registry hits marked `reused`, synthesised ones marked `generated`. Accept / Reject / Edit / Create your own |
| **5 Guardrails** | Guardrail Designer proposals, each naming the discovered risk it covers. Same four actions |
| **6 Workflow** | The composed DAG, drawn. Layers come from capability phases, so the picture is the real execution order |
| **7 Run** | Live execution with a streaming console, per-node status on the graph, guardrail verdicts, and a browsable file viewer of everything generated |
| **8 Trace** | Five-column lineage — requirement → source test → agent → artifact → guardrail. Click any node and its whole chain lights up. Plus the traceability matrix and a full decision trail |
| **9 Report** | Acceptance summary and a Markdown report, downloadable, plus a JSON bundle of the entire run |

Two more screens in the sidebar:

- **Registries** — browse and extend the agent registry, the guardrail registry, and the technology
  profiles. An agent you add here is available to the *next* discovery on any project.
- **Settings** — pick the model (**Auto**, Opus 5, Sonnet 5, Haiku 4.5, Fable 5.1, or **Offline**),
  set an API key, test the connection, and cap how many questions the interview may ask.

### Model selection and Auto mode

| Mode | Behaviour |
|---|---|
| **Auto** (default) | Routes per task: discovery → Opus 5, interview → Haiku 4.5, rationales/generation → Sonnet 5, report → Fable 5.1 |
| A specific model | That model for every assisted task |
| **Offline** | No network calls at all |

**With no API key the platform is fully functional.** Parsing, code generation, data migration,
traceability and every guardrail check are deterministic and never call a model. A key adds
project-specific interview questions and richer explanations on top. It does not change correctness.

---

## What actually gets produced

Not a summary of a migration — the migration. From the Selenium sample:

```ts
test('User Can Log In With Valid Credentials', async ({ page }) => {
  await page.goto('https://shop.example.com/login');
  await page.locator('#username').fill('standard_user');
  await page.locator('#password').fill(process.env.PASSWORD ?? '');
  await page.locator('button[type=\'submit\']').click();
  // auto-waiting replaces an explicit 2000ms sleep
  await expect(page).toHaveTitle('Products');
  await expect(page.locator('.inventory_list')).toBeVisible();
});
```

Note what happened without being asked: the hardcoded password moved to an environment variable,
`Thread.sleep` became auto-waiting, `By.xpath` became `xpath=`, and the assertions came across
one for one.

And the guardrails that then *proved* it, each computed from the artifacts:

```
PASS  No Assertion Loss          6 assertion(s) in the source, 6 in the generated output.
PASS  No Test Case Loss          5 source test case(s), 5 generated test(s).
PASS  Test Data Preservation     4 record(s) in, 4 record(s) out.
PASS  No Hardcoded Secrets       secrets read from the environment.
PASS  Requirement Traceability   5/5 requirement(s) reach a generated test. Orphans: none.
WARN  Unsupported Feature        1 construct has no target equivalent: JavascriptExecutor.
```

That last line is the point. `JavascriptExecutor` has no Playwright equivalent, so it is emitted as
a skipped test with the original source line attached, listed in the report, and the run is marked
`passed-with-warnings` rather than green.

---

## Adding a new migration path

The control plane is generic; only the ends are technology-specific. To add **Cypress → Playwright**
(already shipped) you would touch exactly three places:

1. `server/src/registry/technologies.js` — a profile with keywords and code signals.
2. `server/src/engine/parsers.js` — a parser producing the shared source model.
3. `server/src/registry/agents.js` — a registry entry pointing at it.

No orchestrator change. No UI change. No schema change. Discovery starts requiring the new
capability, the factory finds the new agent, and the composer wires it in.

If you name a technology nobody has built for — try the **Mainframe COBOL** sample — you get a
**Capability Gap**: what is missing, what would have to be built, and a refusal to pretend. That is
deliberate. A platform that quietly produces plausible output for a stack it cannot parse is worse
than one that says no.

---

## Architecture

```
 React UI ──HTTP + SSE──▶ Express API
                              │
              ┌───────────────┴───────────────┐
              │         CONTROL PLANE         │
              │  interview → discovery        │
              │  → agent factory              │
              │  → guardrail designer         │
              │  → workflow composer          │
              └───────────────┬───────────────┘
                              │ approved graph
              ┌───────────────┴───────────────┐
              │        EXECUTION LAYER        │
              │  orchestrator → agents        │
              │  → validator → reporter       │
              └───────────────┬───────────────┘
                              │
                     JSON store (server/data)
```

Three invariants every module honours:

1. **Registry-first.** Capability → registry lookup → reuse. Generation is the fallback, a gap is the floor.
2. **Human gate.** No proposal becomes a graph node without an explicit accept.
3. **Evidence or silence.** A guardrail verdict must be computed from artifacts. Unverifiable → `warn`, never `pass`.

Full detail in [docs/architecture.md](docs/architecture.md).

### Layout

```
docs/                      BMAD artifacts: product brief → PRD → architecture → epics & stories
server/
  src/engine/              discovery · agentFactory · guardrailDesigner · workflowComposer
                           orchestrator · agents · parsers · validator · reporter · interview
  src/registry/            agents · guardrails · technologies
  src/routes/              projects · runs · registry · settings
  src/samples.js           five runnable sample projects
  test/smoke.test.js       end-to-end pipeline tests
web/
  src/pages/               Projects · Workspace · Registry · Settings
  src/stages/              Spec · Interview · Discovery · Proposals · Workflow · Run · Trace · Report
  src/components/Graph.jsx SVG DAG renderer, shared by the workflow and run views
```

React with no UI framework — React 18 + Vite and hand-written CSS. Server dependencies: Express and
CORS. That is the entire dependency list.

---

## Limits, stated plainly

- **Parsers are regex-based, not full grammars.** They handle idiomatic Selenium/Cypress/JUnit/Postman
  well. A suite built on heavy custom base classes or reflection will parse thin — the interview asks
  about exactly this when it sees artifacts that yield zero tests.
- **Generated code is checked structurally, not compiled.** The structure validator catches unbalanced
  delimiters, missing imports and empty bodies. It does not run `tsc`.
- **Generated agents are honest placeholders.** When the factory synthesises an agent for a capability
  with no implementation, it runs on the generic adapter and the run report says so.
- **Single user, local.** No auth, no multi-tenancy, no cloud deployment.

---

Built with the BMAD method: brief → PRD → architecture → epics & stories → implementation.
Those artifacts are in [`docs/`](docs/) and describe the system that is actually here.
