# paperclip-aperture 0.3.2

`0.3.2` is a dependency refresh release.

It upgrades the plugin to the latest published `@tomismeta/aperture-core` patch
line while keeping the current Focus product surface and plugin architecture
unchanged.

## Highlights

- upgraded `@tomismeta/aperture-core` from `0.4.0` to `0.4.2`
- kept the existing Paperclip adapter and explainable Focus UX intact
- validated the plugin against the latest published Core package

## Why This Matters

- picks up the latest semantic robustness improvements from Aperture Core
- keeps the plugin aligned with the current Core SDK patch line
- does so without widening the plugin architecture or changing the operator-facing workflow

## Validation

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm release:check`
