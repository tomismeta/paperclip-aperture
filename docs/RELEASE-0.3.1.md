# paperclip-aperture 0.3.1

`0.3.1` refines the new Explainable Focus surface so it feels more native inside Paperclip.

## Highlights

- Reworked the active `Now` card into a clearer two-lane decision surface
- Tightened queued and ambient presentation so Focus reads more like an operator queue and less like stacked plugin cards
- Kept explainability visible in place while reducing duplication and visual noise
- Preserved inline actionability, including commenting on issue-backed `Now` items without leaving Focus

## What Changed

- the active `Now` surface now separates:
  - decision context on the left
  - actions and response controls on the right
- issue-backed `Now` items keep `Comment` and `Acknowledge` on the primary surface
- approval-backed `Now` items now use a more intentional action layout with:
  - `Approve` and `Reject` paired together
  - `Request revision` treated as the secondary path
- `Next` rows were quieted and clarified to feel more like a staged queue
- `Ambient` was simplified into a more peripheral awareness shelf
- `Why now` / `Why next` copy and action layout were tightened to remove repetition and reduce plugin-chrome feel

## Why This Matters

- Focus feels more like a native Paperclip operator surface
- the active item is easier to scan, explain, and act on without leaving context
- explainability stays attached to the decision without reading like a diagnostics panel

## Validation

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm release:check`
- live-smoke-tested against a local Paperclip instance, including:
  - issue-backed `Now` with inline commenting
  - approval-backed `Now` with approve / reject / request revision
  - queued and ambient lane inspection
