# paperclip-aperture 0.4.9

`0.4.9` is an Aperture Core alignment release.

## Highlights

- upgraded `@tomismeta/aperture-core` from `0.7.0` to `0.8.0`
- takes the Core semantic and judgment hardening through the existing stateful
  `ApertureCore` integration
- intentionally leaves the new Core `./kernel` subpath out of the runtime path
  so Focus does not maintain two parallel judgment systems
- leaves truncation/source-quality hints unwired until Paperclip exposes factual
  clipped or partial-source metadata

## Why This Matters

- picks up the latest deterministic Core behavior without architectural churn in
  the Paperclip plugin
- keeps the plugin boundary stable: Paperclip still owns host policy and UI
  composition, while Aperture Core owns continuity and attention mechanics
- preserves a clear future path for evaluator-based diagnostics and kernel-based
  embedding if Paperclip later needs those surfaces

## Validation

- `pnpm release:check`
