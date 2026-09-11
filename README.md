# ASDD — Adaptive Spec Driven Development

A migration-adaptive AI control plane, built with the ASDD method.

> **Requirements determine the workflow, the workflow determines the agents,
> and the identified risks determine the guardrails.**

Give it requirements — three typed lines or a whole document — plus whatever source material you
have. It interviews you about anything it does not know, discovers what is really being asked for,
composes an agent graph from a reusable registry, proposes guardrails matched to the risks it found,
waits for your approval, runs the work, and proves what it did with computed evidence.

It is not a Selenium-to-Playwright tool. Selenium → Playwright is one path through it. Set the
project kind to `custom` and it makes no assumptions at all — you author the agents, it runs them
and holds them to your rules.

**AI proposes the architecture; you own the final architecture.**

**It runs on your ASDD personas.** Point it at your persona library and your personas — Mary, John,
Winston, Sally and Amelia, with your team's customisations — become agents ASDD can put in any
workflow, read in place on every run and never copied. And it runs inside VS Code as skills Copilot
follows in your project folder, with **Copilot as the model and no API key**.

---

## Run it

```bash
npm install
npm run dev
```

That is the whole setup. No database, no Docker, no API key, no global installs — just
**Node.js 20.6 or later**.

- UI → **http://localhost:5173**
- API → **http://127.0.0.1:5174** — loopback only, since it also carries the model bridge. Set
  `HOST=0.0.0.0` if you really mean to share it.

Then pick a **template** and walk the nine steps across the top.

A template is a starting shape, not a ready-made run: it sets the source and target stacks and
lists what you need to provide. It brings none of your content — you add your own files and your
own requirements, and the interview holds the project until you have. Each template also offers
**Load demo content**, a separate clearly-labelled action that fills it with sample source files if
you want to watch the pipeline work end to end first.

Other useful commands:

```bash
npm test          # pipeline, persona loader, model bridge and an MCP end-to-end test — no network, ~20s
npm run seed      # create the flagship sample project without using the UI
npm run build     # rebuild the UI (npm install already builds it once)
npm start         # single process on :5174 serving the built UI + API
```

### In VS Code — Copilot does it, in your project folder

ASDD runs inside VS Code as skills that Copilot's agent mode follows.
Install it into your project once (after `npm install` in the ASDD folder):

```bash
node <path-to-ASDD>/server/src/cli.js install --workspace <your-project-folder>
```

That adds six skills next to your project's other skills — `.github/skills/`, or `.claude/skills/`
if that is where your personas live — and a small launcher at `_asdd/asdd.mjs`. Open the project in
VS Code, open Copilot Chat in **Agent** mode, and type **/asdd-start**.

| Skill | What Copilot does with you |
|---|---|
| `/asdd-start` | Asks what you want, finds your requirements and source folders, asks the blocking questions |
| `/asdd-review` | Shows the proposed agents and guardrails, records your accept / reject / edit, adds your own — including your ASDD personas |
| `/asdd-run` | Runs the workflow, and does the steps ASDD hands to it |
| `/asdd-decide` | Approve, request changes, continue past a stop, re-run; previews, then writes, the files into your project |
| `/asdd-status` | Where things stand and what is waiting on you |
| `/asdd` | The overview and the rules |

- **Everything stays in your project.** ASDD reads your requirements and source files from the
  folder, keeps its state in `_asdd/`, saves a report per run in `_asdd/reports/`, and writes
  generated files into the project only after showing you the plan and getting your yes.
- **Copilot is the model — no API key, no bridge.** The deterministic engine (parsers, generators,
  guardrail checks, traceability) runs as a command. A step that needs thinking — an agent you
  wrote, or one of your ASDD personas such as Winston — is handed to Copilot as a `TASK.md`: the
  persona with your team's customisations, the task, and the inputs. Copilot does it with your
  files, can ask you, and hands the files back with `submit`; the run carries on. Guardrails you
  wrote in plain English are judged by Copilot too — against the run's files, with the evidence
  quoted, and a failed "stop" rule still stops the run. And before discovery Copilot reads your
  requirements and source itself and asks you what is unclear; your answers become part of the spec.
- **You still own every decision.** The skills tell Copilot never to answer, accept, approve,
  continue, re-run or export on its own judgment — it asks you, then records your words.
- **The dashboard is optional.** `node _asdd/asdd.mjs ui` gives the address of the same project in
  the web UI — graph, live console, trace. Whatever you did in the chat is there.
- VS Code asks before running each terminal command. That is a useful gate; if you would rather not
  click each time, add `node _asdd/asdd.mjs` to VS Code's terminal auto-approve list.
- **ASDD's tools in Copilot Chat, on the same project.** `install` also adds an `asdd` entry to the
  project's `.vscode/mcp.json` (never over one of yours). It runs on the folder's own server, so
  the chat tools, the skills and the dashboard all see one project.
- **Nothing left running.** The folder's ASDD server stops itself after 30 minutes with no command,
  no dashboard open and no run in progress; the next command starts it again from the same state.
- The commands work from any terminal too: `node _asdd/asdd.mjs help`.

### Also in VS Code: ASDD tools, and Copilot's model for the dashboard (MCP)

The repo ships `.vscode/mcp.json`, which registers ASDD as an MCP server. That gives you two things:

1. **ASDD inside Copilot Chat.** In Agent mode, ask *"what's waiting for my approval?"*, *"run
   discovery on the payments project"*, *"summarise the last run"*, or *"give me Winston's persona"*.
   The tools drive the same server the UI uses, so everything shows up in the UI and the log. The
   decision tools — approve, continue or re-run a run, accept proposals, export — act only when you say so, and each
   decision is recorded as yours.
2. **Copilot's model inside ASDD.** The MCP server borrows your editor's model through MCP
   *sampling* and lends it to the ASDD server. Set the model to **Auto** or **Copilot** in Settings
   and the interview, your authored agents and your ASDD personas run on your Copilot subscription.

Setup:

1. `npm run dev`
2. Open this folder in VS Code (1.102 or later) and start **asdd** from the MCP servers view, or
   from the *Start* link above it in `.vscode/mcp.json`.
3. The first time ASDD asks for a model, VS Code asks whether to allow it. Allow it.
4. **Settings → Copilot through VS Code** now says *connected*, with the client and a count of
   requests served.

Any MCP client that supports sampling works the same way. One that doesn't still gets the tools, and
Settings tells you the model bridge is unavailable.

To debug the API itself, press <kbd>F5</kbd> (`.vscode/launch.json`). Recommended extensions are
suggested on first open.

---

## What you can do from the UI

Everything. There is no step that requires curl or editing a file by hand.

| Step | What happens |
|---|---|
| **1 Spec** | A checklist of what the template needs, then your requirements (typed or imported) and your source files |
| **2 Interview** | The platform asks what it does not know and **blocks fulfilment until you answer**. Each question says *why* it matters and what changes based on your answer. Blocking questions are the gate — the readiness score is only a quality signal |
| **3 Discovery** | Classifies source/target, parses the artifacts, counts entities, emits required **capabilities**, **risks**, and honest **capability gaps** |
| **4 Agents** | Agent Factory proposals — registry hits marked `reused`, synthesised ones marked `generated`. Accept / Reject / Edit / **Create my own** |
| **5 Guardrails** | Guardrail Designer proposals, each naming the discovered risk it covers. Same four actions |
| **6 Workflow** | The composed DAG, drawn. Layers come from capability phases, so the picture is the real execution order |
| **7 Run** | Live execution with a streaming console, per-node status on the graph, guardrail verdicts, and a browsable file viewer of everything generated |
| **7a Approval** | Approve the run or request changes — the run stays `pending` until you decide. A halted run is continued past its stop, or re-run from the agent you changed — never restarted from scratch |
| **8 Trace** | Five-column lineage — requirement → source test → agent → artifact → guardrail. Click any node and its whole chain lights up. Plus the traceability matrix and a full decision trail |
| **9 Report** | Acceptance summary and a Markdown report, downloadable, plus a JSON bundle of the entire run |

**Getting the files out.** The run view has **Export to folder** in the top action row: give it an absolute path and it
writes `tests/`, `pages/`, `data/`, `features/` and `docs/` straight into that repository. It always
previews first — every file marked *new*, *exists — skipped* or *blocked* — and it never overwrites
anything unless you explicitly tick the box. Then open the folder in your editor; they are ordinary
source files, and Copilot, Cursor or Claude Code can pick them up from there. The folder you used
last is remembered per project, so a repeat export is one click — but the preview is always
recomputed, never restored from the last time.

Four more screens in the sidebar:

- **Approvals** — every decision waiting on a human, across every project, in one list: unanswered
  blocking questions, undecided agent and guardrail proposals, halted runs, finished runs nobody has
  signed off, and guardrails that asked for a person because they could not be evaluated. Blockers
  sort first, each row says what is waiting and why, and each row's button takes you straight to the
  screen that resolves it. The count follows you in the sidebar, on each project row, and as a banner
  inside the project itself — so a run cannot sit `pending` unnoticed.
- **Dashboard** — built to answer one question: *where did it fail?* It ranks failing guardrails with
  their evidence, agents that threw and what they threw, agents that produced placeholders instead of
  real work, requirements that never reached an artifact, capability gaps still open, and projects
  stuck at the interview. Underneath sits the live activity log — every API call, stage change, agent
  step, guardrail verdict and model call, filterable by level and scope.
- **Registries** — browse and extend the agent registry, the guardrail registry, and the technology
  profiles. An agent you add here is available to the *next* discovery on any project.
- **Settings** — pick the model (**Auto**, **Copilot via VS Code**, Opus 5, Sonnet 5, Haiku 4.5,
  Fable 5.1, or **Offline**), set an API key if you have one, point ASDD at your persona library, watch
  whether VS Code's model bridge is connected, and cap how many questions the interview may ask.

---

## You own the architecture, not the tool

The platform proposes; you decide. Every proposal — agent or guardrail — carries four actions:
**Accept**, **Reject**, **Edit**, and **Create my own**.

**Create an agent** and you fill in what an agent actually is:

| Field | What it does |
|---|---|
| Name, Purpose | Identity, and the description used everywhere it appears |
| Input | Checkboxes: requirements, constraints, source artifacts (optionally filtered to `java, xml, csv`), the parsed source model, artifacts generated earlier in this run. Nothing else reaches it |
| Output | What it should hand back |
| Instructions | Written as you'd brief a colleague — and **executed**, not filed as a note |
| When should it run? | Before everything, after any agent already in the graph, or at the very end |

With a model configured, the instructions run and whatever files come back are written into the run.
With no model, the agent writes the fully resolved brief and states plainly that it did not execute —
it never invents output and lets a guardrail call it a success.

**Create a guardrail** and you get the same ownership:

| Field | What it does |
|---|---|
| Rule | Plain English. With a model it is evaluated against the artifacts in scope; without one it becomes a required human sign-off |
| Severity | blocker / major / minor |
| Applies to | The whole workflow, or one specific agent |
| On failure | **Stop workflow and request review** · Flag and carry on · Record only |

`Stop` is real. A guardrail scoped to an agent runs the moment that agent finishes, so the workflow
halts *there* — later agents are marked skipped, the verdict is `blocked`, and the run waits for you.

And every run ends the same way: **pending your approval**. Approve it, or request changes with a
note. Nothing is accepted just because the machine finished — and because the platform waits on you
by design, the **Approvals** inbox exists so you always know what it is waiting for.

**A decision picks the work up where it stopped — it never starts over.** A run a guardrail halted
cannot be approved as it stands, because agents in it never ran. You get two choices instead:

- **Approve and continue** — the *same* run carries on from the agent after the one that stopped it.
  Everything already produced is kept and only the skipped agents run. The override is recorded
  against you, the check still counts as failed (the verdict can no longer read *passed*), and the
  run comes back to you for final approval.
- **Request changes**, then **Re-run from** any agent — make the change (edit the agent, recompose
  the workflow), and a new run reuses every agent before the one you pick that has not changed
  (marked *reused*, drawn dashed on the graph), then runs that agent and everything after it. If
  something earlier changed — or the spec, source files or answers did — it starts earlier and says
  why, rather than mixing two versions.

Every decision — continued, approved, changes requested, re-run — is on the run's timeline, in its
report, and on the project's decision trail.

---

## It runs on your ASDD personas

ASDD does not reimplement its personas or ship copies of them. It reads your persona library — the
`_bmad/` folder in your project — in place, every time:

| From your library | Where it lives | What ASDD does with it |
|---|---|---|
| Personas | `_bmad/_config/skill-manifest.csv` → each persona's `SKILL.md` and `customize.toml` | Each one becomes a registry agent (marked *your ASDD persona*) you can put in any workflow |
| Your team's and your own customisations | `_bmad/custom/<agent>.toml`, `<agent>.user.toml` | Merged the way the library's own resolver merges them: scalars override, tables deep-merge, keyed menu items replace or append, lists append |
| Standing facts | `persistent_facts`, including `file:{project-root}/…` globs | The referenced files are loaded into the persona's context. A fact that points at a missing file is reported, not quietly dropped |
| Your name and language | `_bmad/bmm/config.yaml` | Used in the persona |
| Workflows | the same manifest, found wherever your IDE installed them (`.claude/skills/…`) | Counted in Settings, and available to your assistant alongside the ASDD tools |

**Where it looks:** the folder in **Settings → Your ASDD personas**, else `ASDD_PERSONA_ROOT`, else
the folder ASDD is cloned into and its parent — so clone ASDD inside your project and it is found
with no configuration. Deprecated shims are skipped.

**No persona library yet?** Everything else in ASDD works without it — Settings just says *not
found*. To add one to your project, run `npx bmad-method install` there, then clone ASDD inside
that project or point Settings at it.

**Using one:** on the Agents step choose **Create my own → Start from one of your ASDD personas**.
Leave *Instructions* blank and it gets the standard task for its role — the architect reviews the
migration's invariants and risks, the PM checks requirements coverage, and so on — or write the task
you want. At run time it loads that persona's *current* definition, so edit its customisation and
the next run picks it up. Its output lands in `personas/<role>/` in the run, traced and held to your
guardrails like any other agent's.

---

## It hands back the ASDD document set

Every run can write the ASDD document set into `docs/`, derived from what that run actually found:

| Document | Built from |
|---|---|
| `product-brief.md` | Source entity counts, the requirements, your constraints; non-goals are the real gaps and unmappable constructs |
| `prd.md` | One row per requirement → the source test that covers it → the generated artifact → migrated / partial / **not covered**. Acceptance criteria are the guardrails you accepted |
| `architecture.md` | The approved agent graph, drawn by layer, with every capability, provenance and implementation named |
| `epics-and-stories.md` | One epic per source suite, one story per source test, status computed from the run — plus a "Port by hand" epic for constructs with no target equivalent |

It runs after traceability, so the PRD can link requirements to the artifacts that satisfy them, and
it says what the run does not know instead of filling the gap: parse nothing and the brief says
"No source tests were parsed"; leave a requirement untraced and the PRD marks it **not covered**.

Switch it off per project with the **ASDD document set** checkbox on the Spec step.

Your ASDD personas and workflows can pick up from these documents where the run left off.

---

## Any project, not just migrations

Set **Project kind** to `custom` on the Spec step and every migration assumption switches off: no
source framework question, no target emitter, no capability gaps. The platform contributes only what
it can genuinely prove — traceability and structural checks — and you author the agents that do the
work.

Requirements arrive either way. Paste three lines, or import a requirements document (`.md`, `.txt`,
`.csv`, `.json`) — the parser handles tagged IDs, bullets, numbered lists, user stories and
"the system shall" sentences, skips headings and prose scaffolding, and tells you how many
requirements it recognised so a document it could not read fails loudly rather than importing nothing.

### Model selection and Auto mode

| Mode | Behaviour |
|---|---|
| **Auto** (default) | With an API key, routes per task: discovery → Opus 5, interview → Haiku 4.5, rationales/generation → Sonnet 5, report → Fable 5.1. With no key but VS Code connected: your editor's model. With neither: the rule engine |
| **Copilot (via VS Code MCP)** | Always your editor's model, through the MCP server — no key |
| A specific Claude model | That model for every assisted task (needs a key) |
| **Offline** | No network calls at all |

**With no model at all the platform is still fully functional.** Parsing, code generation, data
migration, traceability and every guardrail check are deterministic and never call a model. A model
— yours through a key, or Copilot's through VS Code — adds project-specific interview questions,
richer explanations, and actually executes authored agents and ASDD personas. It does not change correctness.
Every run records which model it used.

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
 React UI ──HTTP + SSE──▶ Express API ◀──HTTP── MCP server ◀──stdio── VS Code · Copilot Chat
                          (127.0.0.1)          tools + model bridge (MCP sampling)
                              │
                              │ reads in place: the persona library (_bmad/) — personas, customisations, facts
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

Four invariants every module honours:

1. **Registry-first.** Capability → registry lookup → reuse. Generation is the fallback, a gap is the floor.
2. **Human gate.** No proposal becomes a graph node without an explicit accept.
3. **Evidence or silence.** A guardrail verdict must be computed from artifacts. Unverifiable → `warn`, never `pass`.
4. **One brain, one writer.** The Express server owns all state and all logic. The MCP server is a
   thin client of its API, and the persona library is only ever read — so the UI, Copilot Chat and the log always agree.

Full detail in [docs/architecture.md](docs/architecture.md).

### Layout

```
docs/                      ASDD document set: product brief → PRD → architecture → epics & stories
server/
  src/engine/              discovery · agentFactory · guardrailDesigner · workflowComposer
                           orchestrator · agents · parsers · validator · reporter · interview
  src/registry/            agents (seeded + your ASDD personas, live) · guardrails · technologies
  src/routes/              projects · runs · registry · settings · observability · approvals
                           personas · llm-bridge
  src/bmad/loader.js       reads your persona library: manifest, SKILL.md, customize.toml merge, facts
  src/cli.js               the command line the ASDD skills run from a project folder
  src/mcp.js               the MCP server: ASDD tools + the editor model bridge
  src/lib/bridge.js        the queue that lends the editor's model to the engine
  src/templates.js         six starting templates, each with optional demo content
  test/smoke.test.js       end-to-end pipeline tests
  test/authoring.test.js   custom projects, authored agents/guardrails, halting, approval
  test/bmad-loader.test.js a fixture laid out like a real persona library, and its merge rules
  test/mcp.e2e.test.js     a real MCP client with sampling runs an ASDD persona with no API key
  test/workspace.e2e.test.js  the whole flow from a project folder, exactly as the skills run it
  test/cli-commands.e2e.test.js  every other command, rules judged by the assistant, MCP on the
                           folder's server, and the server stopping itself when idle
skills/                    the ASDD skills that `asdd install` copies into a project
.vscode/mcp.json           registers the asdd MCP server in VS Code
web/
  src/pages/               Dashboard · Projects · Workspace · Registry · Settings
  src/stages/              Spec · Interview · Discovery · Proposals · Workflow · Run · Trace · Report
  src/components/Graph.jsx SVG DAG renderer, shared by the workflow and run views
```

React with no UI framework — React 18 + Vite and hand-written CSS. Server dependencies: Express,
CORS, the MCP SDK (with zod), and smol-toml to read the personas' `customize.toml`. That is the entire list.

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
- **Authored agents need a model.** Free-text instructions cannot be executed by the deterministic
  engine. Without a key they produce a resolved brief and say so; they never pretend to have run.
- **Requirements import is text only** (`.md`, `.txt`, `.csv`, `.json`). No .docx or PDF parsing.
- **Through the MCP bridge, the editor's model answers one prompt at a time.** MCP sampling is a single completion — no
  tools, no file access, no follow-up questions. So a persona inside ASDD does one bounded job per
  run. Interactive persona workflows (the step-by-step PRD or architecture sessions) need a
  conversation: run those in your assistant, where ASDD's tools sit alongside them. Through the skills there is
  no such limit: Copilot does each handed-over step with its full tools.
- **Sampling needs a client that supports it, and your consent.** VS Code does. With a client that
  doesn't, you still get the tools, and the model falls back to a key or the rule engine.

---

Built with the ASDD method: brief → PRD → architecture → epics & stories → implementation.
Those artifacts are in [`docs/`](docs/) and describe the system that is actually here.
