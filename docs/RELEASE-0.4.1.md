# paperclip-aperture 0.4.1

`0.4.1` is a focused Core-alignment patch.

It upgrades `paperclip-aperture` to the latest published
`@tomismeta/aperture-core` line while keeping the current Focus surface,
Paperclip adapter boundary, and plugin UX unchanged.

## Highlights

- upgraded `@tomismeta/aperture-core` from `0.5.x` to `0.6.0`
- picks up calmer live judgment and safer passive-state retention from Core
- keeps the plugin’s current response bridge and explainable Focus surface
  intact

## Why This Matters

- inherits Core’s latest attention-integrity improvements without widening the
  plugin architecture
- keeps Focus aligned with the newest published Core SDK contract
- preserves the plugin’s judgment-first positioning while benefiting from
  calmer engine behavior under interrupt churn

## Validation

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm release:check`
