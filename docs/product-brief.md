# Product Brief — ASDD (Adaptive Spec Driven Development)

**Status:** approved · **Method:** ASDD · **Phase:** 1 (Analysis)

## Problem

Migration work (Selenium→Playwright, Cypress→Playwright, JUnit→PyTest, legacy REST tests→modern API
frameworks) is rebuilt from scratch every time. Teams hard-code "run these five agents", so every new
source/target pair means a new tool. Meanwhile the risks that actually sink a migration — dropped
assertions, lost test data, broken requirement traceability — are policed by hand, if at all.

## Insight

The workflow should be *derived*, not declared:

> Requirements determine the workflow, the workflow determines the agents,
> and the identified risks determine the guardrails.

## Product

A **control plane** that reads a spec (requirements + source tech + target tech + artifacts), discovers
what is really being migrated, composes an agent graph from a reusable registry, proposes guardrails
matched to the discovered risks, puts every proposal in front of a human
(**Accept / Reject / Edit / Create own**), then executes and validates the migration.

## Non-goals

- Pretending any technology pair is supported. When a capability has no registry match and no generatable
  adapter, ASDD raises a **Capability Gap** and says so instead of faking a migration.
- Replacing human review. Every graph is approved before it runs.

## Primary users

- **Migration lead** — owns the spec, approves agents and guardrails.
- **QA / SDET** — reads the generated code, the traceability matrix and the validation report.
- **Engineering manager** — reads the run report and the gap list.

## Success criteria

1. Clone → `npm install` → `npm run dev` → a full migration runs end-to-end with zero configuration.
2. A brand-new source/target pair changes **no orchestration code** — only registry entries and the
   composed graph.
3. Every guardrail verdict is computed from artifacts, never asserted.
