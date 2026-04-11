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

- keeps Aperture Core as the primary continuity and replay layer while the plugin owns host-native overlays explicitly
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

## Follow-On Hardening

After the first remediation pass, the worker/runtime got a second hardening slice aimed at the scaling and credibility gaps that still stood out in review.

### 11. Bounded Company Sessions And Health Visibility

The worker now prunes idle company sessions instead of holding every live Core runtime forever, and the health data exposes the current session budget.

Why it matters:

- removes an obvious unbounded-memory failure mode
- makes multi-tenant behavior easier to reason about operationally

Key files:

- `src/aperture/core-store.ts`
- `tests/core-store.spec.ts`

### 12. Host Read Caching With Explicit Fresh Paths

Host-side reads for issues, comments, documents, and agents are now cached behind the worker, while summary/export flows can bypass that cache when they need fresh truth instead of fast display.

Why it matters:

- cuts reconciliation fan-out on hot UI paths
- preserves a trustworthy debug/export surface that does not hide behind TTLs

Key files:

- `src/aperture/reconciliation.ts`
- `src/handlers/data.ts`
- `src/handlers/events.ts`
- `src/handlers/actions.ts`

### 13. Issue Intelligence Eval Harness

Issue-intelligence rules now have a small corpus-backed eval script that runs in CI.

Why it matters:

- converts the intent layer from "just regexes" into something with a pinned regression surface
- makes future heuristic edits auditable instead of vibes-based

Key files:

- `src/aperture/issue-intelligence.ts`
- `scripts/eval-issue-intelligence.ts`
- `tests/fixtures/issue-intelligence-corpus.json`
- `.github/workflows/ci.yml`

### 14. Small Operability Cleanup

The repo now includes a clean script for local artifacts, exact-pins the Aperture Core dependency, and uses retries on worker-side approval reads.

Why it matters:

- narrows deterministic drift from dependency resolution
- makes local dev state and network flakiness less annoying

Key files:

- `package.json`
- `src/host/paperclip-approvals.ts`

### 15. Durable State Rollback And Persistence Health

Failed mutations now restore the last durable attention envelope instead of blindly replaying whatever happens to be in memory, and worker health exposes whether any company session is in a faulted persistence state.

Why it matters:

- reconciled-only frames no longer disappear if a local write fails mid-flight
- operators and reviewers now have an explicit signal when persistence is unhealthy

Key files:

- `src/handlers/shared.ts`
- `src/aperture/core-store.ts`
- `tests/plugin.spec.ts`

### 16. Persisted State Migration Path

The composite attention envelope now has an explicit migration path from earlier schema versions instead of treating versioning as a single constant and a shrug.

Why it matters:

- future state format changes have a place to land cleanly
- older persisted envelopes can be upgraded instead of silently dropped

Key files:

- `src/aperture/persisted-state.ts`
- `tests/persisted-state.spec.ts`

### 17. UI Seams And One Build Path

The Focus UI now splits frame derivation, explainability rendering, and issue-comment composition into dedicated modules, and the unused Rollup build path has been removed.

Why it matters:

- future UI edits no longer require full-file context across all page concerns
- the repo now has one real build story instead of one active path and one ghost

Key files:

- `src/ui/index.tsx`
- `src/ui/frame-helpers.tsx`
- `src/ui/frame-explainability.tsx`
- `src/ui/issue-comment-composer.tsx`
- `package.json`

## Value Received

This pass produced five concrete gains:

1. **One closer-to-canonical attention view**
   The operator surface, export path, and reconciliation output now line up more cleanly.

2. **Lower operational risk**
   The browser is no longer responsible for host approval transport or final attention composition.

3. **Better SDK leverage**
   Aperture Core remains the continuity and replay substrate.
   The Paperclip plugin SDK now handles more real integration work through worker-side HTTP, config, telemetry, and streams.

4. **Better performance posture**
   Reconciliation is cached and invalidated intentionally instead of being rebuilt and persisted through read handlers.

5. **A more reviewable codebase**
   The system is easier to explain:
   worker owns state and host adaptation, Core owns continuity and attention mechanics, UI owns presentation.

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
- `pnpm eval:issue-intelligence`
- `pnpm build`
- a live local Paperclip smoke test with the branch build installed and rendering through the real host UI

## What This Did Not Try To Do

This pass did not try to:

- redesign the product surface
- replace Aperture Core policy with plugin policy
- move everything to `SourceEvent`
- add a large new UI shell

It was intentionally focused on runtime integrity, ownership boundaries, and codebase quality.
