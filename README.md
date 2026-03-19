<div align="center">

# Paperclip Aperture

**A Paperclip plugin powered by Aperture's deterministic attention engine.**

[![aperture github](https://img.shields.io/badge/aperture-tomismeta%2Faperture-18181b)](https://github.com/tomismeta/aperture)
[![npm aperture core](https://img.shields.io/npm/v/%40tomismeta%2Faperture-core?label=aperture%20core&color=0f766e)](https://www.npmjs.com/package/@tomismeta/aperture-core)
[![paperclip](https://img.shields.io/badge/host-paperclip-2563eb)](https://github.com/paperclipai/paperclip)

<img src="https://raw.githubusercontent.com/tomismeta/paperclip-aperture/main/docs/assets/focus-demo.gif" alt="Paperclip Aperture" width="1400">
<p></p>
</div>


Paperclip Aperture treats Paperclip as the host runtime and UI shell, while importing [Aperture Core](https://github.com/tomismeta/aperture/tree/main/packages/core) via the npm package [`@tomismeta/aperture-core`](https://www.npmjs.com/package/@tomismeta/aperture-core).

It turns Paperclip approvals, issue activity, and other operator-facing events into a Focus surface that ranks what deserves attention now, next, and ambient.

## Install

This plugin is not yet published to npm.

Today, the supported path is a local-path install into a running Paperclip instance.

If Paperclip is already running, the shortest path is:

```bash
git clone git@github.com:tomismeta/paperclip-aperture.git
cd paperclip-aperture
pnpm install
pnpm build

cd /path/to/paperclip
pnpm paperclipai plugin install /absolute/path/to/paperclip-aperture
```

If you need to start Paperclip first:

```bash
git clone git@github.com:tomismeta/paperclip-aperture.git
cd paperclip-aperture
pnpm install
pnpm build
```

Then, from a Paperclip checkout with a running local instance:

```bash
cd /path/to/paperclip

PAPERCLIP_HOME=/path/to/paperclip-sandbox \
PAPERCLIP_INSTANCE_ID=aperture-dev \
pnpm paperclipai run
```

In another terminal, install the plugin by local path:

```bash
cd /path/to/paperclip

PAPERCLIP_HOME=/path/to/paperclip-sandbox \
PAPERCLIP_INSTANCE_ID=aperture-dev \
pnpm paperclipai plugin install /absolute/path/to/paperclip-aperture
```

Then open Paperclip and navigate to:

- `Settings -> Plugins -> Paperclip Aperture`
- `/<company-prefix>/aperture`

Once this plugin is published to npm, the install shape becomes:

```bash
pnpm paperclipai plugin install @tomismeta/paperclip-aperture
```

Before publishing, run:

```bash
pnpm release:check
```

## What This Plugin Is

Paperclip Aperture is an alternative operator attention surface for Paperclip.

It takes Paperclip-native events such as:

- approvals
- budget override requests
- issue lifecycle changes
- issue comments
- run failures

and feeds them into Aperture's deterministic judgment loop so one operator can see:

- what deserves attention **now**
- what should wait until **next**
- what should remain **ambient**

## Why It Exists

Paperclip already has the host pieces:

- agent workflows
- approvals
- operator UI surfaces
- plugin lifecycle and event subscriptions

Aperture already has the judgment piece:

- deciding what deserves attention now
- what should wait until next
- what should stay ambient

This plugin is the bridge between those two systems.

## Guardrails

This plugin stays inside Paperclip's current plugin model and core governance boundaries.

What it does not do:

- it does **not** change Aperture core
- it does **not** override Paperclip approval, auth, issue, or budget invariants
- it does **not** patch Paperclip core routes or host business logic

What it does do:

- subscribes to Paperclip host events through the plugin runtime
- stores plugin state inside Paperclip's plugin state APIs
- renders UI through Paperclip plugin slots
- sends approval decisions back through Paperclip's existing approval APIs from the trusted same-origin plugin UI

Important current runtime caveat:

- Paperclip plugin UI currently runs as trusted same-origin code, so UI-triggered HTTP calls are part of the host's current plugin trust model, not a new capability bypass invented by this plugin

## Current Product Shape

What is real in this repo today:

- a real Paperclip plugin repo, not a Paperclip core patch
- embedded `@tomismeta/aperture-core` inside the plugin worker
- a Paperclip event-to-Aperture mapping layer
- a company-scoped attention page
- a dashboard widget
- a sidebar entry
- approval handling, including budget-specific approval semantics
- tests covering the main event loop and approval mapping paths

## Repo Structure

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
pnpm dev
pnpm test
```

This repo uses the published Paperclip SDK packages directly and is being prepared for npm distribution as a normal installable plugin artifact.

## Links

- Aperture core on npm: [`@tomismeta/aperture-core`](https://www.npmjs.com/package/@tomismeta/aperture-core)
- Aperture GitHub repo: [tomismeta/aperture](https://github.com/tomismeta/aperture)
- Paperclip GitHub repo: [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
- Demo guide: [docs/DEMO.md](./docs/DEMO.md)

## Status

This is a working integration prototype.

It is ready for review as:

- a plugin architecture pattern
- an embedded Aperture judgment path inside Paperclip
- an alternative operator attention surface

It should not yet be framed as fully production-hardened or complete.
