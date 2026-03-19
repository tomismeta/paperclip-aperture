<div align="center">

# Paperclip Aperture

**A Focus view for Paperclip powered by Aperture's deterministic attention engine.**

[![aperture github](https://img.shields.io/badge/aperture-tomismeta%2Faperture-18181b)](https://github.com/tomismeta/aperture)
[![npm aperture core](https://img.shields.io/npm/v/%40tomismeta%2Faperture-core?label=aperture%20core&color=0f766e)](https://www.npmjs.com/package/@tomismeta/aperture-core)
[![paperclip](https://img.shields.io/badge/host-paperclip-2563eb)](https://github.com/paperclipai/paperclip)

<img src="https://raw.githubusercontent.com/tomismeta/paperclip-aperture/main/docs/assets/focus-demo.gif" alt="Paperclip Aperture" width="1400">
<p></p>
</div>

Paperclip Aperture adds a Focus surface to Paperclip that deterministically ranks approvals, issue activity, and other human-facing events into `now`, `next`, and `ambient`.

## Install

```bash
paperclipai plugin install @tomismeta/paperclip-aperture
```

That is the intended consumer install path once the package is published.

If you need Paperclip first:

```bash
npx paperclipai onboard --yes
paperclipai run
```

Then install the plugin with the command above.

If you are testing from source before npm publish:

```bash
git clone git@github.com:tomismeta/paperclip-aperture.git
cd paperclip-aperture
pnpm install
pnpm build

paperclipai plugin install /absolute/path/to/paperclip-aperture
```

After install, open Paperclip and use the `Focus` entry in the sidebar.

## Flow

```text
Paperclip events
  approvals / issues / human-facing signals
            |
            v
paperclip-aperture
  normalize host facts into Aperture inputs
            |
            v
Aperture Core SDK
  deterministically judge now / next / ambient
            |
            v
Focus in Paperclip
  sidebar / page / widget
            |
            v
human response
  approve / reject / request revision / acknowledge
            |
            v
Paperclip updates, Focus reshuffles
```

## What You Get

- a Focus surface inside Paperclip
- ranked `now`, `next`, and `ambient` attention lanes
- approval handling, including budget-specific approval semantics
- a sidebar entry, page, and dashboard widget

## Package Boundary

This plugin treats Paperclip as the host runtime and UI shell, while embedding [Aperture Core](https://github.com/tomismeta/aperture/tree/main/packages/core) through the npm package [`@tomismeta/aperture-core`](https://www.npmjs.com/package/@tomismeta/aperture-core).

It is a pure SDK integration: Aperture Core is used as-is inside a self-contained Paperclip plugin, with no changes to Aperture Core or Paperclip core.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Before publishing, run:

```bash
pnpm release:check
```

## Links

- Aperture GitHub repo: [tomismeta/aperture](https://github.com/tomismeta/aperture)
- Aperture Core on npm: [`@tomismeta/aperture-core`](https://www.npmjs.com/package/@tomismeta/aperture-core)
- Paperclip GitHub repo: [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
