# paperclip-aperture 0.4.0

`0.4.0` is the first release of `paperclip-aperture` aligned to the newer
published Aperture Core lane contract and the latest Paperclip plugin SDK.

This release keeps the existing Focus operator surface largely intact while
making the plugin a better source adapter and response bridge for Aperture Core.

## Highlights

- upgraded to `@tomismeta/aperture-core@^0.5.0`
- upgraded to `@paperclipai/plugin-sdk@2026.403.0`
- aligned the plugin to Core's published `now / next / ambient` view contract
- added bounded Core trace export for replay/debug workflows
- added `activity.logged`-driven document invalidation for fresher Focus updates
- added sparse Focus telemetry and Paperclip activity log writes for major actions

## Why This Matters

- gives Aperture Core cleaner, current SDK-aligned facts without turning the
  plugin into a second judgment engine
- keeps Focus fresher when issue documents change
- makes export, replay, and debug workflows more useful with recent Core traces
- improves observability of Focus actions through low-noise telemetry and host
  activity entries

## Validation

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm release:check`
