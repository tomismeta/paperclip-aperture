# Contributing

Thanks for helping with `paperclip-aperture`.

## Development Setup

```bash
pnpm install
pnpm verify
```

`pnpm verify` is the main local gate. It runs:

- `pnpm typecheck`
- `pnpm test`
- `pnpm eval:issue-intelligence`
- `pnpm build`
- `pnpm check:bundle-size`

Use `pnpm release:check` before publish to run the full verification flow plus `npm pack --dry-run`.

If you want to clear local artifacts first:

```bash
pnpm clean
```

## Live Paperclip Smoke Test

Build the plugin:

```bash
pnpm build
```

Run Paperclip in one terminal:

```bash
npx paperclipai run -i default
```

Install the local plugin in another:

```bash
npx paperclipai context set --api-base http://localhost:3100
npx paperclipai plugin uninstall tomismeta.paperclip-aperture --force
npx paperclipai plugin install --local .
```

Then open `http://127.0.0.1:3100/APE/aperture`.

## Architecture Boundaries

Please keep the boundary honest:

- Aperture Core owns continuity, replay, engagement, and attention mechanics.
- The plugin worker owns Paperclip-specific host adaptation, reconciliation, approval overlays, and persisted review state.
- The UI owns presentation and operator interaction wiring.

This plugin is not meant to become a second independent attention engine. If a change starts inventing new generic ranking policy inside the plugin, pause and ask whether it belongs in Aperture Core instead.

## Change Expectations

- Prefer extending the worker-side adapters and typed contracts over ad hoc UI logic.
- Keep task and interaction identity flowing through the shared task-ref helpers instead of hand-parsing ids.
- Preserve bounded exports and bundle budgets unless you deliberately revisit those limits.
- Add or update tests whenever behavior, persistence, or reconciliation logic changes.
