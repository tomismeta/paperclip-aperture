# paperclip-aperture 0.6.0

Paperclip Aperture 0.6.0 upgrades Focus to Aperture Core 0.10.0 and the official
Paperclip SDK 2026.1023.0. Published on npm on October 25, 2026.

## Requirements and installation

- Paperclip host API **2026.1023.0 or newer**; the bounded verification below used
  official, unmodified `2026.1023.0`.
- Node.js **24.11.0 or newer**.
- Runtime dependencies: `@paperclipai/plugin-sdk@2026.1023.0` and
  `@tomismeta/aperture-core@0.10.0`.

For a new installation:

```bash
npx paperclipai plugin install @tomismeta/paperclip-aperture --version 0.6.0
```

Use the separate `--version` option. The tested host failed to resolve the package
installation directory with the scoped `package@version` form.

**Before upgrading, back up persisted plugin state. Do not force-uninstall an
existing installation or downgrade a worker in place.** See [Upgrade safety](#upgrade-safety).

## Highlights

- **Native approvals and human attribution.** Company-scoped SDK approval reads
  and approve/reject writes replace the optional HTTP approval adapter. Decisions
  and issue comments use host-verified human identity. Budget revisions hand off
  through **Request revision in Paperclip** without recording a plugin decision.
- **Independent human-decision cards.** Plain confirmations support confirm/decline,
  required reasons, preparing gates, and fresh actor eligibility checks. Questions,
  specialized requests, and agent approvals without native approval IDs hand off to
  Paperclip rather than offering unsupported acknowledgements.
- **Separate run-failure attention.** Failed runs have independent task identities;
  supported recovery and closure facts retire attention without erasing execution
  history. Correlated scheduled retries downgrade only their predecessor's display.
- **Safer historical state.** Schema 5 preserves legacy approval acknowledgements
  as local audit/suppression instead of replaying invalid approval answers into Core.
  It does not fabricate native approval decisions. Ordinary acknowledgements apply
  to their recorded interaction rather than hiding a different pending decision.
- **Complete issue discovery and honest refresh failures.** Reconciliation reads
  the accessible issue collection without unsupported pagination arguments; agent
  discovery remains paginated without a total cap. Failed reconciliation retains
  the last complete candidates with a visible warning. Fresh exports fail rather
  than label stale issue, agent, or interaction data as current. Approval overlays
  retain a separate bounded cache.
- **Company-scoped operation.** Configuration and worker state are company-scoped.
  Company changes withhold the previous company's display while the next scope
  loads. Event-derived state is persisted by subsequent scoped reads/actions.
- **Focused interaction.** Bounded focus hold supports context inspection and
  commenting. Failure details remain under **Show context**. Decision controls use
  the same blue accent as Acknowledge across active and queued cards.

## Known host limitations

This release preserves the polling-based Focus experience; it does not claim full
compatibility with every host feature.

1. **No reliable instant cross-client push.** The observed stock SSE endpoint
   returned HTTP 501. The supported baseline is 15-second visible-page polling,
   plus visibility/action refresh. Stream support remains opportunistic.
2. **Incomplete recovery visibility.** Complete scheduled-retry, active-recovery,
   and blocked-inbox facts are not guaranteed through the public worker contract.
   Supplied context remains supported; missing fields do not establish that no
   recovery exists. Actual continuation was not exercised in the stock upgrade.
3. **Host navigation mismatch.** Switching companies and using browser Back can
   leave the host company selector/sidebar inconsistent with the route. Scoped
   plugin cards do not fix global host navigation.

Read/unread markers remain task-scoped. A new interaction can therefore be visible
but already counted as read. Event facts not yet flushed by a scoped invocation
can be lost on worker restart or session eviction. Native writes and plugin-state
persistence are separate transactions; unknown comment-write outcomes do not carry
an exactly-once guarantee.

## Upgrade safety

Schema 3 histories from the published 0.5.1 worker migrate to schema 5. Historical
acknowledgements and their timestamps are retained, including legacy approval
acknowledgements preserved as local suppression rather than native decisions.

- Preserve a matching pre-upgrade package and state backup.
- Do not run an older worker against schema-5 state: it can reject the envelope,
  load obsolete split state, and overwrite newer history.
- To roll back, stop the worker and restore its matching pre-upgrade state backup
  before starting the older package.
- Existing `paperclipApiBase` settings are ignored. Native SDK approvals replace
  the removed HTTP adapter; budget revisions open Paperclip.
- The verified local-artifact migration used soft uninstall **without force**,
  followed by installation of the candidate consumer. Plugin identity, state, and
  company configuration survived. The version-only upgrade endpoint was not
  qualified for retargeting a local package path.

## Native stock-first upgrade

Recorded release qualification used official Paperclip `2026.1023.0` and the
actual published `0.5.1` baseline in an isolated installation:

- Both company histories migrated from schema 3 to 5; all nine original ledger
  entries, acknowledgement timestamps, and suppression were retained.
- Focus, sidebar, and dashboard widget rendered native issue attention.
- Native comments and confirmation responses were attributed to the signed-in human.
- Company reads/exports stayed disjoint; a cross-company comment was rejected.
- Visible-page polling converged on new native issue attention.
- A cold host/worker restart retained schema 5, ledger/review contents, accepted
  confirmation, acknowledgements, and distinct company settings.

The release preparation record reports 391 passing tests, typecheck, the 19/19
issue-intelligence corpus, build, bundle budgets, and package checks. The native
journey used runtime bytes identical to the published package; subsequent archive
changes affected README only. A separate post-publication registry installation
reached `ready`, and all six installed package files matched the registry archive.

These are bounded results, not new verification performed by publishing this
GitHub release. Native approval approve/reject, additional actor/addressee branches,
active recovery/continuation, automatic new-tab navigation, and query/hash navigation
were not exercised in the stock upgrade fixture. Visibility refresh was not
independently timed. Known SSE and browser-Back failures remain limitations.

## Published artifact

The npm archive contains six files. Its SHA-256 is:

```text
2aeaa54a2df9fa4da69fa8cf00de9df41481b25f9dc6ebf7027c883f9e7ef960
```

- [npm package](https://www.npmjs.com/package/@tomismeta/paperclip-aperture/v/0.6.0)
- [Published tarball](https://registry.npmjs.org/@tomismeta/paperclip-aperture/-/paperclip-aperture-0.6.0.tgz)
- [Changes since 0.5.1](https://github.com/tomismeta/paperclip-aperture/compare/v0.5.1...v0.6.0)

## History

See the [0.5.1 release notes](./RELEASE-0.5.1.md) for the previous release.
