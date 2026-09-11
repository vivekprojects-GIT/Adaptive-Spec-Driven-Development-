---
name: asdd-start
description: 'Start ASDD in this project folder: ask the user what they want (a migration or any custom workflow), find their requirements and source files here, create the ASDD project, and get every blocking question answered by the user. Use when the user wants to begin a migration or a spec-driven workflow in this project.'
---
<!-- installed by ASDD — "asdd install" updates this file; edits here are overwritten. -->

# Start ASDD in this project

Goal: an ASDD project for this folder, built from the user's own requirements and source files,
with every blocking question answered by the user.

1. Check where things stand: `node _asdd/asdd.mjs status`. If a project already exists, tell the user and carry on from its `NEXT:` line instead of starting again.

2. Ask the user, in one short message:
   - What they want to achieve — for example "convert our Selenium Java suite to Playwright TypeScript", or anything else.
   - Where the requirements are: a document in this project (its path), or a few lines they type.
   - Which folder(s) hold the source material — the test suite, collections, fixtures. Look at the project tree and suggest likely folders, but let them confirm.
   - What kind of work it is: a **migration** (convert a test suite — ask for the source and target stacks), a **build** (make something new from the requirements, plan-first — ask whether any technology is already decided), or `custom` (anything else — they author the agents).

3. Start it with their answers:

   ```
   node _asdd/asdd.mjs start --name "<name>" --kind migration --source <folder> [--source <folder> …] --requirements <file> --source-stack "<…>" --target-stack "<…>" [--constraints "<…>"]
   ```

   Use `--requirements-text "<their lines, one per line>"` instead of `--requirements` when they typed them, and `--kind build` or `--kind custom` when it is not a migration.

4. It prints the interview. For every **blocking** question, ask the user — include its "why it matters" line — and record their answer in their words:

   ```
   node _asdd/asdd.mjs answer <questionId> "<their answer>"
   ```

   Offer the optional questions; do not push them.

5. Then read the requirements and the source files yourself, the way a senior engineer would before
   starting. If something important is unclear, missing or contradictory, ask the user — a few
   questions at most — and record each question with their answer:

   ```
   node _asdd/asdd.mjs clarify "<your question>" "<their answer>" --why "<why it matters>"
   ```

   It becomes part of the spec, so discovery and every agent see it, and the report lists it.

6. When nothing blocks, continue with `/asdd-review`.

Never invent requirements, stacks or answers. If the user does not know, record that as their
answer ("not sure — …") or leave the question open and tell them what it blocks.
