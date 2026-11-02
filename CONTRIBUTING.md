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

Use a disposable Paperclip installation, never your default instance:

1. Run `pnpm release:check`, then pack the checked build with
   `pnpm --config.ignore-scripts=true pack --pack-destination <temporary-directory>`.
   Install that exact archive into a fresh consumer directory; do not point a
   release smoke test at the mutable source checkout.
2. Start official Paperclip `2026.1023.0` with fresh, isolated `HOME` and
   `PAPERCLIP_HOME` directories and a free loopback port. Use authenticated/private
   mode for identity and authorization checks.
3. Bootstrap a disposable owner and authorize the CLI against that instance.
   Pass its explicit `--data-dir` and `--api-base` to plugin commands; do not
   change global CLI context.
4. Install with `plugin install --local <installed-consumer-package-directory>`.
   A fresh instance does not require uninstalling anything. Never use `--force`
   to prepare a smoke test or upgrade an installation whose history must survive.
5. Open Focus through the disposable company's actual sidebar/URL prefix.
   Exercise native attention, actions, company isolation, polling, and restart
   persistence. Record unexercised branches and known host limitations.

Use a separate disposable installation for migration from the published baseline.
Preserve plugin identity, configuration, and persisted state across the no-force
package switch. Never start an older worker against schema-5 state.

See the [release checklist](docs/ROADMAP.md#release-checklist) and
[0.6.0 upgrade safety](docs/RELEASE-0.6.0.md#upgrade-safety). Stop only the services
and browser sessions created for the smoke test.

## Architecture Boundaries

Please keep the boundary honest:

- Aperture Core owns continuity, replay, engagement, and attention mechanics.
- The plugin worker owns Paperclip-specific host adaptation, reconciliation, approval overlays, and persisted review state.
- The UI owns presentation and operator interaction wiring.
- Paperclip source facts should enter through the narrow adapter layer and use `SourceEvent`/ledger contracts where possible; avoid making the UI infer attention policy.

This plugin is not meant to become a second independent attention engine. If a change starts inventing new generic ranking policy inside the plugin, pause and ask whether it belongs in Aperture Core instead.

## Change Expectations

- Prefer extending the worker-side adapters and typed contracts over ad hoc UI logic.
- Keep task and interaction identity flowing through the shared task-ref helpers instead of hand-parsing ids.
- Preserve decision-owner metadata whenever reconciliation or display overlays move a frame between lanes.
- Treat new operator evidence as durable signal ledger entries when Core should learn from it after restart.
- Preserve bounded exports and bundle budgets unless you deliberately revisit those limits.
- Add or update tests whenever behavior, persistence, or reconciliation logic changes.
