---
name: asdd-status
description: 'Show where the ASDD project in this folder stands and what is waiting on the user: blocking questions, undecided proposals, a halted run, a run to approve, or a step for the assistant. Use when the user asks what is next or what ASDD is waiting for.'
---
<!-- installed by ASDD — "asdd install" updates this file; edits here are overwritten. -->

# ASDD status

1. Run `node _asdd/asdd.mjs status`.
2. Tell the user, briefly: the stage, what is waiting on them (as a list), the latest run's verdict, and the one next step. Offer the skill that does it — `/asdd-start`, `/asdd-review`, `/asdd-run` or `/asdd-decide`.
3. If a step is waiting on you (`WAITING FOR YOU`), do it as `/asdd-run` describes.
