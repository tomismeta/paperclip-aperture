# paperclip-aperture 0.3.0

`0.3.0` turns Focus into a more explainable operator surface without changing the core live-attention workflow.

## Highlights

- Added embedded explainability to the Focus UI
- Added `Why now` on the active card and `Why next` on queued rows
- Exposed confidence, signals, thread context, and related activity in the card details
- Persisted explainability metadata on reconciled issue, approval, and agent frames

## What Changed

- added a shared explainability layer that turns frame provenance, semantic confidence, relation hints, and episode continuity into operator-facing rationale
- active `Now` cards now expose:
  - `Why now`
  - `Confidence`
  - `Signals`
  - `Thread context`
  - `Related activity`
- expanded `Next` rows now show a compact `Why next` strip
- explainability metadata is now attached to reconciled issue frames and approval bootstrap frames so the UI is reading worker-owned semantics rather than inventing its own rationale
- copy was tightened to feel like product language rather than internal semantic-engine language

## Why This Matters

- Focus is more legible in place, without forcing operators into a separate inspection mode
- operators can now answer:
  - why did this surface?
  - why is it in this lane?
  - how much should I trust this judgment?
- the plugin keeps its existing architectural line:
  - Aperture Core remains the bounded semantic substrate
  - paperclip-aperture remains the Paperclip-specific interpreter and operator-language layer

## Validation

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm release:check`
- live-smoke-tested against a local Paperclip instance with screenshots of both:
  - the active `Why now` panel
  - the queued `Why next` strip
