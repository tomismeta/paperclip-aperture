# paperclip-aperture 0.2.1

`0.2.1` keeps the `0.2.0` product surface intact while updating the plugin to align with `@tomismeta/aperture-core@0.4.0`.

## Highlights

- Validated the plugin against `@tomismeta/aperture-core@0.4.0`
- Added core-shaped semantic payloads onto plugin-authored `ApertureEvent`s
- Kept Paperclip-specific interpretation and operator-language generation inside the plugin
- Preserved the existing `Focus` experience and interaction model

## What Changed

- `event-mapper` now uses `@tomismeta/aperture-core/semantic` to enrich mapped events with canonical semantic metadata
- Approval and issue events now carry richer provenance and continuity hints
- Linked issue and approval events now attach `same_issue` relation hints when source facts support it

## Architecture Notes

- The plugin still publishes explicit `ApertureEvent`s
- The plugin does **not** switch to `SourceEvent` ingestion in this release
- Core semantic helpers are used as a shared semantic substrate, not as a replacement for plugin-local ontology
- Paperclip-specific actor resolution, issue intent detection, and operator-language generation remain plugin-local by design

## Why This Helps

- Better semantic traceability without giving up Paperclip-specific control
- Cleaner continuity inputs for future Aperture Core improvements
- Lower-risk alignment with the `0.4.0` semantic contract than a full ingestion-path migration

## Dependency Snapshot

- `@tomismeta/aperture-core@0.4.0`
- `@paperclipai/plugin-sdk@2026.318.0`

## Validation

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- local Paperclip smoke test with:
  - issue comment action
  - acknowledge flow
  - `attention-display` polling
