---
name: asdd-run
description: 'Run the ASDD workflow the user approved in this project, and carry out any agent step ASDD hands to you (such as one of the user''s ASDD personas or an agent they wrote), then hand the files back so the run continues. Use when the user says run, go, or carry on with ASDD.'
---
<!-- installed by ASDD — "asdd install" updates this file; edits here are overwritten. -->

# Run the ASDD workflow

1. Make sure the user has reviewed the agents (`/asdd-review`) and wants to run. Then:

   ```
   node _asdd/asdd.mjs run
   ```

2. Read the output and act on it:

   - **Agents ran and guardrails reported.** Relay the verdict, and every FAIL and WARN with its evidence. Then `/asdd-decide`.

   - **`WAITING FOR YOU`** — a step is yours to do. This is how ASDD uses you as its model, with no API key:
     1. Read the whole TASK.md it names. It says who you are for this step (often one of the user's ASDD personas, carrying their team's customisations), what to do, and the inputs that agent was given.
     2. Do the work for real. Read the project files you need, and write the files under the `out/` folder it names, each at the path it should have in the project.
     3. Stay in that role and that step's scope. Do not change other project files for this step.
     4. If something essential is missing, ask the user. If you go ahead on an assumption, write it in `NOTES.md` in that `out/` folder.
     5. Run `node _asdd/asdd.mjs submit`. The run carries on, and it may hand you another step — repeat. In a plan-first project it hands you each phase in turn — brief, PRD, architecture, stories, then the implementation — and each task includes the documents written before it.

   - **`⚖ WAITING FOR YOU … Judge N rule(s)`** — rules the user wrote in plain English need a verdict. You are the judge, so be a strict one:
     1. Read the JUDGE.md it names: each rule, what it applies to, and the files the run produced for it.
     2. For each rule, decide on those files alone: `pass` only if they demonstrably satisfy it, `fail` if they demonstrably break it, `warn` if they do not show enough to decide.
     3. Record each verdict with the evidence you saw, quoted: `node _asdd/asdd.mjs judge <guardrailId> pass|warn|fail "<evidence>"`.
     4. Do not soften a fail. If its author set the rule to stop, the run stops — and what happens next is the user's decision, in `/asdd-decide`.

   - **A guardrail stopped the run.** That decision is the user's. Go to `/asdd-decide`.

3. If the user wants to watch the graph or read the trace: `node _asdd/asdd.mjs ui`, and give them the address (in VS Code: Command Palette → "Simple Browser: Show").
