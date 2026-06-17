# paperclip-aperture 0.4.7

`0.4.7` is a focused runtime safety patch for Paperclip's scoped plugin
invocation model.

## Highlights

- keeps subscribed event callbacks memory-only: no issue reads, state
  reads/writes, stream emits, or per-event config fetches from `ctx.events.on`
- defers persistence for event-derived Aperture state until the next scoped
  data/action bridge call, preserving ledger replay after Focus refreshes
- keeps read-only Focus data handlers usable when the host denies state or
  reconciliation scope by falling back to the current in-memory attention state
- adds regression coverage for event-scope safety, deferred persistence, and
  restart replay

## Validation

- `pnpm verify`
