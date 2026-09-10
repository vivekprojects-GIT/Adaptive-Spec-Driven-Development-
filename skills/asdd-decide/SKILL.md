---
name: asdd-decide
description: 'Record the user''s decision on an ASDD run (approve, request changes, continue past a guardrail stop, or re-run from a changed agent) and write the generated files into the project when they say so. Use when an ASDD run has finished or halted.'
---
<!-- installed by ASDD — "asdd install" updates this file; edits here are overwritten. -->

# Decide on an ASDD run

Every command here records a decision **as the user's**. Run one only after they have told you,
in this conversation, what they want — and put their reason in `--note`, in their words.

**A finished run waiting for approval.** Show the verdict and the guardrails (`node _asdd/asdd.mjs status`), then ask: approve, or request changes?

```
node _asdd/asdd.mjs approve --note "<what they checked>"
node _asdd/asdd.mjs request-changes --note "<what needs changing>"
```

**A halted run** — a guardrail set to "stop" fired. It cannot be approved as it stands, because agents after the stop never ran. Ask: continue past the stop, or send it back? Continuing records their override, and that check still counts as failed.

```
node _asdd/asdd.mjs continue --note "<why they are overriding it>"
node _asdd/asdd.mjs request-changes --note "<what needs changing>"
```

**After changes were requested.** Help them make the change — edit an agent, add one, adjust a guardrail (see `/asdd-review`) — then re-run from the agent that changed. The unchanged agents before it are reused, not run again:

```
node _asdd/asdd.mjs rerun --from "<agent name>" --note "<what changed>"
```

**Putting the files into the project.** Always preview first, and show the user the plan:

```
node _asdd/asdd.mjs export            # the plan: what would be created, kept, or blocked — writes nothing
node _asdd/asdd.mjs export --yes      # only when the user says so
```

Existing files are kept unless the user explicitly asks to overwrite them (`--overwrite`). `--to <folder>` writes somewhere else inside the project.

Each finished run's report is saved in `_asdd/reports/<run>.md`.
