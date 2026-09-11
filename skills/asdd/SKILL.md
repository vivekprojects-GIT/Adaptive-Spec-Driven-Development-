---
name: asdd
description: 'ASDD (Adaptive Spec Driven Development) in this project: turn requirements into a workflow of agents, guardrails that check their work, and decisions the user owns. Use when the user wants to migrate a test suite (Selenium, Cypress, JUnit, Postman) or run any spec-driven workflow here, or asks what ASDD can do. Routes to the asdd-* skills.'
---
<!-- installed by ASDD — "asdd install" updates this file; edits here are overwritten. -->

# ASDD in this project

ASDD turns the user's requirements and source material into a workflow of agents, checks every
agent's work with guardrails, and stops at every decision that belongs to the user. It works in
this folder: its state lives in `_asdd/`, and generated files are written into the project only
when the user says so. If this project has BMAD installed, ASDD uses the user's BMAD agents in place.

You drive it by running commands in the terminal, from the project root:

```
node _asdd/asdd.mjs <command>
```

Every command prints what happened and ends with a `NEXT:` line. Follow it.

## The flow

1. **Start** — `/asdd-start`: ask the user what they want, point ASDD at their requirements and source files, and get the blocking questions answered.
2. **Review** — `/asdd-review`: discovery proposes agents and guardrails; the user accepts, rejects, edits or adds their own (including their BMAD agents).
3. **Run** — `/asdd-run`: run the workflow. When a step is handed to you, do it and hand the files back.
4. **Decide** — `/asdd-decide`: approve, request changes, continue past a stop, re-run from a changed agent, and write the files into the project.

`/asdd-status` at any time: where things stand and what is waiting on the user.

## Rules

- **The user owns every decision.** Never answer an interview question, accept or reject a proposal, approve, request changes, continue past a stop, re-run, or export with `--yes` on your own judgment. Ask, wait for their answer, then run the command with their words in `--note`.
- **Relay what ASDD reports, as it reports it.** Give verdicts and guardrail evidence plainly. Do not soften a FAIL or a capability gap.
- **A step handed to you is real work.** When a command prints `WAITING FOR YOU`, read the TASK.md it names, do the step in that role, write the files where it says, then run `node _asdd/asdd.mjs submit`.
- **When you judge a rule, judge it strictly.** A verdict rests on the files ASDD gives you, with the evidence quoted — never on what you expect them to contain.
- **Do not edit anything under `_asdd/state/`.** Use the commands.
- The dashboard (`node _asdd/asdd.mjs ui`) shows the same project as the chat, with the workflow graph, live console and traceability, if the user wants to see it.

## Commands

| Command | What it does |
|---|---|
| `status` | Where things stand, and what is waiting on the user |
| `start …` / `sync` | Set up from this folder / re-read its files |
| `interview` / `answer <id> "<text>"` | Open questions / record the user's answer |
| `discover` / `proposals` | Propose agents and guardrails / list them |
| `accept` / `reject <id>` or `all` | Record the user's decision |
| `edit <id> --set key=value` | Change a proposal the user wants changed |
| `add-agent …` / `add-agent --bmad <role>` | The user's own agent / one of their BMAD agents |
| `add-guardrail …` | The user's own rule |
| `run` | Run the accepted workflow |
| `task` / `submit` | The step handed to you / hand its files back |
| `judge <id> pass\|warn\|fail "<evidence>"` | Your verdict on a plain-English rule the run is waiting on |
| `clarify "<question>" "<answer>"` | A question you asked the user, with their answer |
| `approve` / `request-changes` | Final decision on a run |
| `continue` | Carry a halted run on past its stop |
| `rerun --from "<agent>"` | Re-run from a changed agent |
| `export` / `export --yes` | Preview / write the files into the project |
| `ui` | The dashboard for this folder |

`node _asdd/asdd.mjs help` lists every option.
