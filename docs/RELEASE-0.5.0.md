# paperclip-aperture 0.5.0

`0.5.0` adopts the Aperture Core 0.9 semantic and judgment hardening release
once `@tomismeta/aperture-core@0.9.0` is published.

## Highlights

- upgrades `@tomismeta/aperture-core` from `0.8.0` to `0.9.0`
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
- npm publication check currently remains pending until Core 0.9.0 is on the
  registry
