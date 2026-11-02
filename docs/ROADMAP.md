# Roadmap and Releasing

This document records the integration's direction and the separation between
local release preparation and explicitly authorized publication.

The guiding principle is simple:

- keep Paperclip-specific integration logic in the plugin
- keep reusable judgment logic in Aperture Core
- only push work into Aperture Core when multiple integrations need the same SDK primitive

## Release Lanes

### Plugin-only

These should ship from `paperclip-aperture` without requiring Aperture Core changes:

- event mapping and normalization
- replay, persistence, and reconciliation in plugin state
- UI and operator workflow improvements
- richer action handling
- install/docs/demo polish
- npm and GitHub release hygiene
- smoke tests and integration coverage

### Host-dependent

These are valid improvements, but should be tracked separately because they depend on
Paperclip runtime or CLI behavior:

- in-app plugin discoverability for external/community plugins
- local plugin manifest/cache reload behavior
- support for pinned version installs with scoped npm packages
- corrected company-scoped stream delivery and shared host stream connections
- complete canonical worker recovery enrichment beyond conditional supplied context
- global company selector/sidebar synchronization and dynamic-plugin route memory

### Potential Aperture Core

These should only happen if we find a clearly reusable SDK need:

- state import/export helpers
- replay/bootstrap helpers
- structured "Why this?" trace export
- standardized provenance and reasoning surfaces for host integrations

## Current Position

The `0.5.1` baseline uses SDK `2026.722.0` and Aperture Core `0.9.0`.
Version **0.6.0** is published on npm with official SDK/minimum host API
baseline `2026.1023.0`, Node.js `>=24.11.0`, and Core `0.10.0`.
The release scope is the published experience upgraded on unmodified stock
Paperclip, retaining the stateful worker-owned `ApertureCore` architecture and
current safety and feature improvements.

The release retains native human-attributed SDK approvals and comments,
structured decision cards, separate run lifecycle attention, complete unpaged
issue discovery, paginated agent discovery, company-scoped configuration, and
failure-preserving reconciliation. Schema 5 preserves legacy approval acknowledgements
as local audit/suppression without submitting invalid Core responses or inventing
native decisions. Explainability, interaction-owned acknowledgements, bounded focus
hold, company fences, and the single canonical worker composition path remain.

The published refresh contract is 15-second visible-page polling plus visibility/
action refresh. Stream consumers/emissions remain opportunistic; observed SSE 501
is still a failed push-delivery gate, not a polling pass. Conditional recovery,
watchdog, and blocked-inbox context already existed in `0.5.1` and stays supported
when supplied; missing fields never prove no recovery. Complete recovery parity,
actual continuation, and global company-navigation correctness require separate
host contracts/evidence. They are not mandatory dependencies of the Core upgrade;
the plugin does not replace canonical host facts or global routing.

The coordinated 391-test release check and bounded native published-`0.5.1` upgrade
passed: schema-3 history migrated to schema 5, with actual Focus/sidebar/widget,
polling, human-attributed native actions, company isolation and cold-restart
persistence. Exact artifact identity and unexercised branches are in the
[0.6.0 release notes](./RELEASE-0.6.0.md#native-stock-first-upgrade).
The `0.6.0` release contract includes the three documented host limitations:
polling rather than reliable instant push, incomplete recovery visibility, and
the company-selector/route mismatch after browser Back. Their expanded guarantees
remain failed or unqualified, not release blockers or silently passing results.
Keep the implementation intact; removing capabilities is not a remedy.
Npm publication and exact-registry-artifact verification are complete, including
an actual `0.6.0` registry install-to-ready on official `2026.1023.0` and a live
README check. Git releases and production deployment remain separate operations.

## Historical Feature Direction

The following `0.3.x` framing is retained as historical planning context, not an
upcoming release schedule or a claim that every proposed review control shipped.

### 0.3.0: Explainable Focus

Goals:

- make `Focus` more transparent than a styled inbox
- help operators understand why something is interrupting them or queued behind the active item
- preserve the fast action surface while making judgment easier to trust

Scope:

- embedded `Why now` and `Why next` surfaces
- confidence, signals, thread context, and related-activity visibility
- richer provenance UI that stays attached to the existing Focus cards
- stronger lane-specific treatments without introducing a separate inspection mode first

Success criteria:

- an operator can explain why the current item is `now`
- an operator can explain why a queued item is `next`
- explainability improves trust without slowing the action loop

### 0.3.x: Operator Control and Review

Goals:

- give operators more lifecycle control over attention once they trust the queue
- reduce long-tail noise without weakening the core ranking model

Scope:

- review/mute/snooze patterns
- stronger retirement behavior for ambient and stale tails
- tighter review controls on queued and ambient items

Success criteria:

- operators can shape what stays visible over time
- the plugin supports both quick action and deliberate queue management

## Release Checklist

### Local preparation (no publication)

1. Match `package.json` and `src/manifest.ts` versions and review release notes,
   author, description, and categories. Preserve dependency pins unless a
   dependency change is explicitly part of the release.
2. With Node.js `>=24.11.0` and pnpm 10, run the single coordinated gate:

   ```bash
   pnpm release:check
   ```

   This includes verification and the package dry run; do not duplicate its
   component commands as separate release gates.
3. Create the canonical archive with `pnpm --config.ignore-scripts=true pack --pack-destination`
   pointing to a new temporary directory. This reuses the checked build without
   rerunning `prepack`; do not change source or `dist` between checking and packing.
   Record the archive's version, contents, and SHA-256.
4. Smoke the exact archive in a fresh isolated host installation. Install it into
   a fresh consumer and point `--local` at that installed package, with explicit
   `--data-dir` and `--api-base`. Isolate both `HOME` and `PAPERCLIP_HOME` for registry
   installs. Do not use a default user instance or an unpublished registry version.
5. Use a separate fresh owned host B for the actual published `0.5.1` migration.
   Install the published package first, create and preserve schema-3 history/export,
   review/suppression, configuration and plugin identity. Switch with the verified
   soft uninstall **without force**, then local install of the exact candidate
   consumer. Verify the same ID/state/config and the new packagePath. The version-only
   upgrade endpoint cannot retarget this local path and was not exercised.
   Never downgrade onto schema-5 state.
   Record actual Focus/sidebar/widget, native events/actions and human attribution,
   15-second polling/visibility/action convergence, capture settings, company isolation,
   and cold host/worker restart persistence. Export forces fresh issue/agent/interaction
   reconciliation; native approval overlays may use their separate 15-second cache.
   Distinguish the real-published-worker approval-acknowledgement harness probe
   from native proof.
   Report conditional recovery/watchdog fixtures as observed or unavailable; track
   expanded stream/recovery/navigation results separately without relabeling failures.
   Record the host and archive identities; packaging or source checks alone do not
   establish installed runtime compatibility.
6. Complete the requested independent review and resolve actionable findings.
   Retain the exact tested archive and evidence. If files change afterward,
   qualify the resulting artifact rather than publishing an untested rebuild.

### Explicit approval boundary

Preparation stops before any commit, tag, push, npm publication, GitHub release,
or deployment. Passing checks is not authorization for those operations.

Only after explicit approval may the maintainer execute the agreed publication
steps, publish the exact qualified archive, and verify the resulting registry
artifact. Keep publication verification distinct from pre-publication smoke:
the registry cannot validate an unpublished candidate.

## Notes on Core Impact

The following do **not** require Aperture Core changes:

- release discipline
- plugin packaging
- install docs
- event coverage
- replay/reconciliation in plugin state
- operator actions
- unread/review models
- UI polish

The following **might** justify Aperture Core work later:

- generalized SDK replay/import-export support
- reusable reasoning trace APIs
- portable provenance helpers shared across multiple hosts

Until that need is proven across integrations, keep this work in the plugin.
