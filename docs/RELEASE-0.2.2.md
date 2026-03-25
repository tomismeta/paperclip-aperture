# paperclip-aperture 0.2.2

`0.2.2` keeps the `0.2.x` product surface intact while tightening the semantic bridge into Aperture Core and making review flows more document-aware.

## Highlights

- Added richer semantic continuity hints on mapped issue events
- Added better semantic confidence shaping for plugin-authored issue semantics
- Added document-aware review interpretation for memo/spec-backed issues
- Added `issue.documents.read` support to the plugin worker

## What Changed

- issue events now project clearer core-shaped relation hints such as:
  - `same_issue`
  - `supersedes`
  - `resolves`
- the plugin no longer over-stamps confidence on approval and failure paths when core can infer it from the canonical event shape
- reconciliation now checks issue documents for blocked and `in_review` issues
- if a review-blocking memo/spec request has been satisfied by a later document attachment, Focus downgrades that item from interruptive review work into monitor-only follow-up

## Why This Matters

- better semantic relation hints improve continuity and episode-tracking behavior in Aperture Core without forcing the plugin to abandon its Paperclip-specific ontology
- document-aware review handling makes Focus less stale in real Paperclip workflows where the critical artifact lives on the issue, not just in comments
- the architectural line remains the same:
  - Aperture Core owns bounded semantic substrate and attention judgment
  - paperclip-aperture owns Paperclip-specific interpretation and operator language

## Dependency Snapshot

- `@tomismeta/aperture-core@^0.4.0`
- `@paperclipai/plugin-sdk@2026.318.0`

## Validation

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- live smoke-tested against a running local Paperclip instance, including document attach -> ambient downgrade behavior
