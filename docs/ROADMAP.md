# Roadmap and Releasing

This document defines how `paperclip-aperture` should mature from a strong `0.1.x`
integration into a dependable and legible operator surface.

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

## Current Position

`0.2.x` largely delivered the trustworthy Focus foundation:

- dependable replay and review state
- stronger issue, approval, and agent semantics
- richer recommended moves
- document-aware review downgrade behavior
- a clearer `now`, `next`, and `ambient` model

The next wedge is no longer basic trust. It is explainability and operator control.

## Next Feature Set

The next meaningful release should focus on legibility and operator usefulness, not just ranking polish.

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
