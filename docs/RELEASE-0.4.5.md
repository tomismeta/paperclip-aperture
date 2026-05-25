# paperclip-aperture 0.4.5

`0.4.5` aligns Paperclip Aperture with the current Paperclip plugin SDK and
uses the newer host attention contracts where they improve Focus judgment.

## Highlights

- upgraded `@paperclipai/plugin-sdk` from `2026.428.0` to `2026.525.0`
- declares Paperclip `2026.525.0` as the minimum host version
- surfaces Paperclip Blocked Inbox attention as first-class Focus evidence
- surfaces active Paperclip recovery actions directly in Focus
- keeps planning-mode blockers calmer unless the host marks them urgent
- preserves document lock metadata in review handoff copy and diagnostics
- excludes plugin-operation issues from host reconciliation scans
- preserves the original Focus sidebar icon
- preserves UI bundle import syntax so Paperclip's host-side plugin loader can rewrite React and SDK imports reliably
- relies on the existing polling refresh path instead of opening the optional UI stream bridge on hosts where streams are not enabled
- makes agent run failure cards acknowledgeable and clears issue-linked failures when the issue moves on
- documents the Windows `spawn npm ENOENT` Paperclip installer failure mode

## Why This Matters

- lets Focus defer to Paperclip's own blocked-work and recovery signals instead
  of relying only on plugin-local heuristics
- keeps Aperture current with the latest Paperclip issue, comment, and document
  contracts
- improves operator clarity around locked review artifacts and planning-mode
  work without changing the plugin boundary
- closes the feedback loop for stale failure cards and broken sidebar entry
  reports from early `0.4.4` installs

## Validation

- `pnpm release:check`
