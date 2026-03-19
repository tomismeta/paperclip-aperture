# Roadmap and Releasing

This document defines how `paperclip-aperture` should mature from a strong `0.1.x`
integration into a dependable operator surface.

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
- better shared live-update primitives than repeated polling

### Potential Aperture Core

These should only happen if we find a clearly reusable SDK need:

- state import/export helpers
- replay/bootstrap helpers
- structured "Why this?" trace export
- standardized provenance and reasoning surfaces for host integrations

## Next Feature Set

The next meaningful release should focus on trust and operator usefulness, not just UI polish.

### 0.2.x: Trustworthy Focus

Goals:

- make `Focus` dependable after restarts and missed events
- improve non-approval coverage
- reduce ambiguity about why something is `now`, `next`, or `ambient`

Scope:

- broader backfill/reconciliation beyond approvals
- stronger blocked/waiting/run-failure semantics
- deeper links back into Paperclip entities
- richer operator actions for high-value frames
- unread/review state or lightweight "new since last seen" model

Success criteria:

- approvals, issues, and failed runs all feel trustworthy after restart
- operators can move from `Focus` directly into the underlying Paperclip work
- a new operator can explain why a frame landed in a given lane

### 0.3.x: Explainability and Review

Goals:

- make the plugin more transparent than a styled inbox
- expose Aperture's reasoning in a way operators can trust

Scope:

- `Why this?` surface
- richer provenance UI
- review/mute/snooze patterns
- stronger lane-specific row treatments

Success criteria:

- an operator can inspect why a frame is interrupting them
- the plugin supports both quick action and thoughtful review

## Release Checklist

For every release:

1. Update `package.json` version
2. Update `src/manifest.ts` version and confirm metadata matches:
   - `author`
   - `description`
   - `categories`
3. Run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm release:check
```

4. Verify install from npm:

```bash
npx paperclipai plugin install @tomismeta/paperclip-aperture
```

5. Verify uninstall/reinstall:

```bash
npx paperclipai plugin uninstall tomismeta.paperclip-aperture --force
npx paperclipai plugin install @tomismeta/paperclip-aperture
```

6. Verify the plugin reaches `ready`
7. Verify sidebar, page, and widget render in a real Paperclip instance
8. Create and push the git tag
9. Publish to npm
10. Create the GitHub release

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
