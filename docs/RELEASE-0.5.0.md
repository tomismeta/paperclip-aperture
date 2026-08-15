# paperclip-aperture 0.5.0

`0.5.0` adopts the published Aperture Core 0.9 semantic and judgment hardening
release.

## Highlights

- upgrades `@tomismeta/aperture-core` from `0.8.0` to `0.9.0`
- upgrades `@paperclipai/plugin-sdk` from `2026.707.0` to `2026.722.0`
- resolves Paperclip plugin configuration by company ID for event, data, and
  action paths instead of keeping one worker-global configuration snapshot
- keeps Paperclip on the existing stateful `ApertureCore` integration
- preserves one judgment path and intentionally leaves the Core `./kernel`
  subpath out of the runtime path
- updates the truncation contract for Core 0.9, which no longer exposes a
  consequence field on truncation hints
- maps only validated Paperclip run diagnostics into Core 0.9 `SourceEvidence`
  and preserves explicit truncation facts as semantic hints
- subscribes to native Paperclip issue document/relation events and preserves
  document-scoped comment context without promoting it to a top-level follow-up
- raises the worker bundle budget to 730 KB after measuring the Core 0.9
  bundle at approximately 719 KB

## Why This Matters

- Paperclip receives the Core semantic improvements without duplicating the
  judgment engine or adopting a second runtime path.
- The bundle budget change is explicit and bounded rather than an untracked
  allowance.
- The integration remains conservative: Paperclip does not manufacture
  capability ownership or infer typed evidence from arbitrary prose.
- Native Paperclip event facts are preferred over the legacy activity-log
  fallback when both are available.

## Validation

- `pnpm release:check`
- packed consumer validation against the Core 0.9.0 artifact
- npm publication check against the published Core 0.9.0 registry artifact
- exact npm tarball installed in a clean consumer with Core 0.9.0 and SDK
  2026.722.0
- exact packed plugin activated in Paperclip 2026.722.0 and rendered Focus at
  desktop and mobile viewport sizes

## Upstream Note

Paperclip `2026.722.0` may report its running host version as `0.0.0` during
plugin minimum-version validation. That installer defect is in Paperclip's
server and is not worked around by lowering this plugin's declared minimum
host version.
