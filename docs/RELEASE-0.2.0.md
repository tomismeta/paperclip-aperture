# paperclip-aperture 0.2.0

`0.2.0` turns Paperclip Aperture into the live attention layer for Paperclip.

## Highlights

- Repositioned `Focus` as a live attention layer rather than an inbox clone
- Added ranked `now`, `next`, and `ambient` lanes with dynamic re-stacking
- Improved operator-facing language with a plugin-local semantic mapping layer
- Added agent-aware routing using real company agent names
- Added inline issue commenting directly from Focus
- Hardened acknowledge/suppression behavior so seen state survives refresh and replay
- Added stale-blocker downgrades and short-lived `ambient` decay
- Validated the plugin against `@tomismeta/aperture-core@0.3.0`

## Notable Product Changes

- `Inbox tells you what changed. Focus tells you what deserves attention now.`
- `Now` leads with a recommended move instead of just mirroring the source title
- `Next` behaves as a staged queue behind the active item
- `Ambient` keeps awareness visible briefly without interrupting the operator

## Architecture Notes

- Paperclip remains the system of record for issue and approval writes
- The plugin worker owns Aperture ingestion, replay, review state, and display composition
- The plugin publishes `ApertureEvent`s today using a Paperclip-specific semantic layer
- Approval transport still uses same-origin Paperclip UI APIs because the current plugin SDK does not expose approval read/write clients

## Reliability Improvements

- Per-company mutations are serialized through a shared mutation path
- Mutation persistence now rolls back durable state if a ledger/snapshot write sequence fails mid-flight
- Review state is reconstructed from plugin-owned history
- Resurfacing only happens when newer meaningful updates arrive
- Ambient items expire after five minutes instead of lingering forever

## Demo Updates

- Refreshed demo assets and flow
- Demo now explicitly shows:
  - one approval decision
  - one inline Focus comment
  - one acknowledge-to-clear action

## Dependency Snapshot

- `@tomismeta/aperture-core@0.3.0`
- `@paperclipai/plugin-sdk@2026.318.0`

## Validation

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `npm publish --dry-run`

