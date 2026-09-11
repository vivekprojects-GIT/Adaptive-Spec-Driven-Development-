---
name: asdd-review
description: 'Run ASDD discovery and review the proposed agents and guardrails with the user, recording their accept, reject and edit decisions and adding their own agents (including their ASDD personas) and guardrails. Use after /asdd-start, or whenever the user wants to change the ASDD workflow.'
---
<!-- installed by ASDD — "asdd install" updates this file; edits here are overwritten. -->

# Review the ASDD workflow with the user

AI proposes the workflow; the user owns it. Nothing runs until they are happy with the list.

**A plan-first (`build`) project:** the proposal *is* the plan — the phases in order (brief → PRD →
UX when there is a user interface → architecture → epics & stories → implementation), who does
each (their ASDD persona for the role, or ASDD's built-in agent), and the guardrails between the
phases. Two of those stop the run before any code is written: if the plan is incomplete, or if a
requirement has no story. Show it to the user as that structure. If they approve it as it is, one
command accepts it all and runs every phase by itself: `node _asdd/asdd.mjs approve-plan`. If they
want changes, make them first (the table below), then `approve-plan`.

1. `node _asdd/asdd.mjs discover` — or `proposals` if discovery already ran and nothing changed.
   If it refuses because questions still block, go back to `/asdd-start` step 4. Add `--force` only if the user explicitly says to go ahead anyway.

2. Tell the user, plainly:
   - the discovery summary and the risks it found;
   - any **capability gaps** — things nothing can do yet. Say so; do not paper over them;
   - each proposal, with its id, what it is and why it was proposed. Agents first, then guardrails.

3. Ask what they want, and record exactly that:

   | They want | Run |
   |---|---|
   | Keep one | `node _asdd/asdd.mjs accept <id>` |
   | Drop one | `node _asdd/asdd.mjs reject <id>` |
   | Keep everything proposed | `node _asdd/asdd.mjs accept all` |
   | Change one | `node _asdd/asdd.mjs edit <id> --set name="…" --set severity=blocker` |
   | Their own agent | `node _asdd/asdd.mjs add-agent --name "…" --purpose "…" --instructions "…" [--inputs requirements,artifacts] [--files java,csv] [--output "…"] [--after "<agent name>"]` |
   | One of their ASDD personas as a step | `node _asdd/asdd.mjs personas` to list them, then `node _asdd/asdd.mjs add-agent --persona <role> [--instructions "…"] [--after "<agent name>"]` |
   | Their own rule | `node _asdd/asdd.mjs add-guardrail --name "…" --rule "<plain English>" --severity blocker\|major\|minor --applies-to "<agent name>"\|workflow --on-failure stop\|flag\|continue` |

   Inputs an agent can read: `requirements`, `constraints`, `artifacts` (the source files), `sourceModel` (the parsed source), `generated` (files produced earlier in the run).
   A persona with no `--instructions` does the standard review for its role; with instructions, it does that task as itself.
   `--on-failure stop` really stops the run at that agent and waits for the user.

4. Show the final list (`node _asdd/asdd.mjs proposals`) and ask whether it is right. When they say go, continue with `/asdd-run`.
