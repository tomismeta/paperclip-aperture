# Audit Remediation - May 2026

This pass addresses the remaining high-value engineering gaps from the `0.4.x`
architecture audit while keeping the package boundaries clean:

- no Paperclip host code was modified
- no `@paperclipai/plugin-sdk` code was modified
- no `@tomismeta/aperture-core` code was modified

## What Changed

1. Source fidelity now reaches Core through `SourceEvent` where the published
   Aperture Core contract supports it. The plugin still stores the normalized
   `ApertureEvent` for replay/export so debugging remains straightforward.

2. Focus operator signals are now durable ledger entries. `viewed` and
   `context_expanded` evidence can be replayed after worker restart instead of
   living only inside the current in-memory Core session.

3. Display-only approval responses now have explicit `overlay-response` ledger
   entries. When an approval came from the worker-side display adapter rather
   than the replayed Core snapshot, the action is still auditable without
   pretending Core owned that frame.

4. Reconciled and display frames now carry decision-owner metadata. Diagnostics
   can distinguish Core-owned judgment from Paperclip reconciliation policy,
   approval overlays, and final display promotion.

5. Reconciled candidate caching now has a TTL in addition to invalidation
   events. This keeps the fast path but prevents stale display composition from
   living indefinitely when the host cache expires quietly.

6. Approval adapter failures are tracked in diagnostics. The worker still uses
   the plugin SDK HTTP client and does not reach into browser-local host APIs.

7. Issue intelligence has a larger regression corpus, negative-intent checks,
   and per-intent recall output. The rules are still intentionally lightweight,
   but edits now have a clearer calibration harness.

8. The Now action rail now uses the shared issue comment composer instead of a
   second inline implementation.

9. The README boundary notes were refreshed for `@tomismeta/aperture-core@0.7.0`
   and `@paperclipai/plugin-sdk@2026.428.0`.

10. Diagnostics/export now include signal entries, overlay response entries,
    ledger strategy metadata, host cache counts, and approval adapter status.

11. The plugin now reads Paperclip issue blocker relations from the typed SDK
    and surfaces them as durable Focus context/provenance/metadata. This gives
    Aperture better source facts without adding a second ranking engine.

## Remaining Honest Limitation

The plugin still persists a full replay ledger. Export windows are bounded and
diagnostics now flag when compaction should be considered, but true checkpoint
compaction should wait for a Core-supported task-view checkpoint/restore contract
so we do not fake replay correctness.
