# Audit Remediation — April 2026

This note records the architecture remediation pass that followed a top-down code audit of `paperclip-aperture`.

The goal was not cosmetic cleanup. The goal was to raise the ceiling of the system so the plugin would look disciplined to senior engineers reviewing it:

- fewer competing truths
- less hidden mutation
- better SDK utilization
- clearer ownership boundaries
- better replay/debug posture

## What Changed

### 1. Live Core Sessions Instead Of Read-Time Rebuilds

The plugin now preserves a live `ApertureCore` session per company in the worker instead of reconstructing Core from the ledger on every read.

Why it matters:

- keeps runtime state stable
- reduces read-path churn
- makes future Core features easier to adopt cleanly

Key files:

- `src/aperture/core-store.ts`
- `src/handlers/data.ts`

### 2. Worker-Owned Final Display Snapshot

The worker now builds the final Focus display snapshot, including live approval merging.

Why it matters:

- the UI, exports, and replay/debug flows now look at the same final attention view
- removes client-side view composition drift

Key files:

- `src/handlers/data.ts`
- `src/aperture/approval-frames.ts`

### 3. Worker-Side Approval Transport

Approval reads and writes now go through a worker-side Paperclip adapter using the plugin SDK HTTP client.

Why it matters:

- removes browser-side host coupling
- keeps host integration logic behind a worker boundary
- uses the published Paperclip SDK more directly

Key files:

- `src/host/paperclip-approvals.ts`
- `src/handlers/actions.ts`
- `src/manifest.ts`

### 4. Deliberate Reconciliation Caching And Invalidation

Reconciliation is now cached in the worker and invalidated explicitly when new host facts land.

Why it matters:

- reduces hot-path recomputation
- gives document-backed review flows fresher updates without rebuilding everything on each UI poll

Key files:

- `src/aperture/core-store.ts`
- `src/handlers/data.ts`
- `src/handlers/events.ts`

### 5. Query Paths No Longer Persist State Implicitly

Read handlers no longer repair and persist state as a side effect of being queried.

Why it matters:

- makes mutation ownership clearer
- improves predictability for debugging and caching

Key files:

- `src/handlers/data.ts`
- `src/handlers/shared.ts`

### 6. Typed Frame Metadata Contract

The plugin now has a typed metadata reader for Focus-specific frame semantics.

Why it matters:

- reduces ad hoc record digging
- makes explainability and telemetry read from a stable contract

Key files:

- `src/aperture/contracts.ts`
- `src/aperture/explainability.ts`

### 7. Less Plugin-Side Shadow Ranking

The plugin-side frame merge logic now preserves Core lanes instead of re-scoring across lanes with a parallel ranking model.

Why it matters:

- keeps Aperture Core as the primary judgment layer
- reduces policy duplication inside the plugin

Key files:

- `src/aperture/frame-model.ts`

### 8. UI Decomposition

The Focus UI was split so transport/view-model logic and chrome primitives no longer live in one giant file.

Why it matters:

- reduces team friction for future UI work
- makes it easier to reason about page composition vs shared view logic

Key files:

- `src/ui/chrome.tsx`
- `src/ui/focus-model.tsx`
- `src/ui/index.tsx`

### 9. Governed Issue Intelligence

Issue intent analysis now carries explicit matched rule ids and richer reconciled metadata.

Why it matters:

- makes the heuristics more inspectable
- creates a better foundation for future evaluation and calibration work

Key files:

- `src/aperture/issue-intelligence.ts`
- `src/aperture/reconciliation.ts`

### 10. Stronger Architecture-Level Tests

The test suite now covers worker-owned display merging, approval transport, cache invalidation, and trace/export behavior.

Why it matters:

- tests now protect the architecture, not just the happy path UI behavior

Key files:

- `tests/plugin.spec.ts`
- `tests/frame-model.spec.ts`

## Value Received

This pass produced five concrete gains:

1. **One closer-to-canonical attention view**
   The operator surface, export path, and reconciliation output now line up more cleanly.

2. **Lower operational risk**
   The browser is no longer responsible for host approval transport or final attention composition.

3. **Better SDK leverage**
   Aperture Core remains the judgment engine.
   The Paperclip plugin SDK now handles more real integration work through worker-side HTTP, config, telemetry, and streams.

4. **Better performance posture**
   Reconciliation is cached and invalidated intentionally instead of being rebuilt and persisted through read handlers.

5. **A more reviewable codebase**
   The system is easier to explain:
   worker owns state and host adaptation, Core owns judgment, UI owns presentation.

## Immediate User-Facing Follow-Up

On top of the remediation pass, Focus now uses Aperture Core's operator engagement support to hold the current `now` item steady briefly while the operator is actively interacting with it.

Current triggers:

- opening `Show context`
- opening the inline comment composer on the active item

Why it matters:

- the current focus item feels calmer while someone is actively working it
- the new live Core session architecture now pays off in a directly visible way

## Verification

The remediation pass was validated with:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- a live local Paperclip smoke test with the branch build installed and rendering through the real host UI

## What This Did Not Try To Do

This pass did not try to:

- redesign the product surface
- replace Aperture Core policy with plugin policy
- move everything to `SourceEvent`
- add a large new UI shell

It was intentionally focused on runtime integrity, ownership boundaries, and codebase quality.
