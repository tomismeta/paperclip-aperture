# paperclip-aperture 0.4.6

`0.4.6` is an install-compatibility patch for Paperclip `2026.525.0`.

## Highlights

- removes the manifest-level `minimumHostVersion` gate because Paperclip `2026.525.0` reports `0.0.0` to the plugin loader during install
- keeps the runtime requirement documented as Paperclip `2026.525.0` or newer
- keeps the original Focus sidebar icon/count behavior from `0.4.5`
- keeps `@paperclipai/plugin-sdk` at `2026.525.0`
- documents the Paperclip `2026.525.0` scoped-package installer bug where explicit version suffixes check the wrong package directory

## Install

Install the current npm `latest` package without an explicit version suffix:

```bash
npx paperclipai plugin uninstall tomismeta.paperclip-aperture --force
npx paperclipai plugin install @tomismeta/paperclip-aperture
```

## Validation

- `pnpm release:check`
