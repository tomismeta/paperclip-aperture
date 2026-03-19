# Paperclip Aperture

An Aperture-powered attention center for Paperclip.

This repo is intentionally separate from the Paperclip monorepo. The plugin is
host-first in naming and structure:

- host: Paperclip
- judgment engine: Aperture
- artifact: `@tomismeta/paperclip-aperture`

The current scaffold is set up as a real Paperclip plugin starter, not just a
generic example. It already includes:

- an embedded `@tomismeta/aperture-core` worker store
- a Paperclip event-to-Aperture mapping layer
- plugin data/actions split into `src/handlers/`
- a company-scoped attention page and dashboard widget
- tests that exercise the event loop end to end

## Structure

```text
src/
  manifest.ts
  worker.ts
  aperture/
    core-store.ts
    event-mapper.ts
    response-mapper.ts
    types.ts
  handlers/
    actions.ts
    data.ts
    events.ts
    shared.ts
  ui/
    index.tsx
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm dev            # watch builds
pnpm test
```

This scaffold snapshots `@paperclipai/plugin-sdk` and `@paperclipai/shared` from a local Paperclip checkout at:

`/Users/tom/dev/paperclip/packages/plugins/sdk`

The packed tarballs live in `.paperclip-sdk/` for local development. Before publishing this plugin, switch those dependencies to published package versions once they are available on npm.



## Install Into Paperclip

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/Users/tom/dev/paperclip-aperture","isLocalPath":true}'
```

## Initial Product Shape

- `page` route at `/:companyPrefix/aperture`
- `dashboardWidget` summary for now/next/ambient counts
- approval and run-failure ingestion into Aperture attention state
- local acknowledge/dismiss response loop for supervised frames

## Next Recommended Steps

1. Add richer Paperclip event coverage for `approval.decided`, `issue.updated`, and blocked agent states.
2. Add a Paperclip-native return path for approval approve/reject actions.
3. Add entity-specific tabs once the main page UX feels right.
4. Replace the local tarball SDK deps with published versions when ready to publish.
