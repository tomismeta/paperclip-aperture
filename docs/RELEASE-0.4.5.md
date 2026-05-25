# paperclip-aperture 0.4.5

`0.4.5` aligns Paperclip Aperture with the current Paperclip plugin SDK and
uses the newer host attention contracts where they improve Focus judgment.

## Highlights

- upgraded `@paperclipai/plugin-sdk` from `2026.428.0` to `2026.517.0`
- declares Paperclip `2026.517.0` as the minimum host version
- surfaces Paperclip Blocked Inbox attention as first-class Focus evidence
- surfaces active Paperclip recovery actions directly in Focus
- keeps planning-mode blockers calmer unless the host marks them urgent
- preserves document lock metadata in review handoff copy and diagnostics
- excludes plugin-operation issues from host reconciliation scans
- uses a host-rendered sidebar launcher for the Focus entry
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

- `pnpm verify`
