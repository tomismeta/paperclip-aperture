<div align="center">

# Paperclip Aperture

**The live attention layer for Paperclip, powered by Aperture's deterministic attention engine.**

[![paperclip-aperture npm](https://img.shields.io/npm/v/%40tomismeta%2Fpaperclip-aperture?label=paperclip-aperture&color=2563eb)](https://www.npmjs.com/package/@tomismeta/paperclip-aperture)
[![aperture github](https://img.shields.io/badge/aperture-tomismeta%2Faperture-18181b)](https://github.com/tomismeta/aperture)
[![npm aperture core](https://img.shields.io/npm/v/%40tomismeta%2Faperture-core?label=aperture%20core&color=0f766e)](https://www.npmjs.com/package/@tomismeta/aperture-core)
[![paperclip](https://img.shields.io/badge/host-paperclip-2563eb)](https://github.com/paperclipai/paperclip)

<img src="https://raw.githubusercontent.com/tomismeta/paperclip-aperture/main/docs/assets/focus-demo.gif" alt="Paperclip Aperture" width="1400">
<p></p>
</div>

Paperclip Aperture adds a Focus surface to Paperclip that deterministically ranks approvals, issue activity, and other human-facing events into `now`, `next`, and `ambient`.

It is designed as a live attention layer, not an inbox clone:

- `now` shows the single most interrupting item
- `next` stages the queue behind it
- `ambient` keeps low-pressure awareness visible without demanding action

Put differently:

- Inbox tells you what changed
- Focus tells you what deserves attention now
- Inbox mirrors source records
- Focus re-stacks them into an operator-facing queue with recommended moves

## Install

```bash
npx paperclipai plugin install @tomismeta/paperclip-aperture
```

If you need Paperclip first:

```bash
npx paperclipai onboard --yes
npx paperclipai run
```

Then install the plugin with the command above.

After install, open Paperclip and use the `Focus` entry in the sidebar.

## Napkin Diagram

```text
+--------------+   +--------------+   +--------------+   +--------------+   +--------------+
| Arrive       |   | Translate    |   | Judge        |   | Show         |   | Respond      |
| events       |   | facts        |   | attention    |   | surface      |   | action       |
+--------------+   +--------------+   +--------------+   +--------------+   +--------------+
       |                  |                  |                  |                  |
       +----->            +----->            +----->            +----->            |

tool hooks         explicit facts      does this         what the          operator decision
from Paperclip     from raw payloads   deserve           operator          carried back
and agents                             attention now?    actually sees     to the tool
```

## What You Get

- a Focus surface inside Paperclip
- ranked `now`, `next`, and `ambient` attention lanes
- approval handling, including budget-specific approval semantics
- issue-aware operator language such as `review required`, `blocked`, and targeted recommended moves
- agent-aware routing that distinguishes known company agents from human/operator roles when issue text references them
- a plugin-local deterministic semantic mapping layer that interprets Paperclip issue, approval, and agent signals before publishing them into Aperture Core
- richer semantic continuity hints on mapped issue events, including `supersedes` and `resolves` relationships where Paperclip-specific intent is clear
- document-aware review interpretation for memo/spec-backed issues so Focus can tell the difference between `review is blocked on the artifact` and `the artifact is attached, monitor instead`
- dynamic re-stacking so items can move between `now`, `next`, and `ambient` as new evidence arrives
- inline issue commenting from the Focus surface when a Paperclip issue supports written response
- durable acknowledge/suppression behavior backed by plugin state and ledger replay
- a sidebar entry, page, and dashboard widget

## Package Boundary

This plugin treats Paperclip as the host runtime and UI shell, while embedding [Aperture Core](https://github.com/tomismeta/aperture/tree/main/packages/core) through the npm package [`@tomismeta/aperture-core`](https://www.npmjs.com/package/@tomismeta/aperture-core).

It is a pure SDK integration: Aperture Core is used as-is inside a self-contained Paperclip plugin, with no changes to Aperture Core or Paperclip core.

For `0.2.x`, the boundary works like this:

- the plugin worker owns Aperture ingestion, replay, review state, and display composition
- Paperclip remains the system of record for issue and approval writes
- approval transport still goes through same-origin Paperclip HTTP APIs from the plugin UI because the current plugin SDK does not expose approval read/write clients
- the plugin intentionally publishes `ApertureEvent`s today, using a Paperclip-specific semantic mapping layer and ontology, rather than switching fully to `SourceEvent`
- that semantic layer includes reusable intent detectors, actor resolution against real company agents, downstream blocker extraction, and shared operator-language generation inside the plugin

The plugin has been validated against [`@tomismeta/aperture-core@0.4.0`](https://www.npmjs.com/package/@tomismeta/aperture-core).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Before releasing, run:

```bash
pnpm release:check
```

For a live local Paperclip smoke test, start Paperclip first:

```bash
pnpm build
npx paperclipai run -i default
```

Then, in a second terminal:

```bash
npx paperclipai context set --api-base http://localhost:3100
npx paperclipai plugin uninstall tomismeta.paperclip-aperture --force
npx paperclipai plugin install --local .
```

Then open `http://127.0.0.1:3100/APE/aperture` and verify:

- `Acknowledge` hides the active card and survives refresh
- `Next` promotes into `Now`
- issue comments post successfully from Focus
- approval actions update Focus correctly
- resolved blocker comments downgrade stale `Now` items
- attached issue documents downgrade stale `share the memo/spec` review blockers into monitor-only follow-up

## Links

- Plugin on npm: [`@tomismeta/paperclip-aperture`](https://www.npmjs.com/package/@tomismeta/paperclip-aperture)
- Roadmap and releasing: [docs/ROADMAP.md](./docs/ROADMAP.md)
- Aperture GitHub repo: [tomismeta/aperture](https://github.com/tomismeta/aperture)
- Aperture Core on npm: [`@tomismeta/aperture-core`](https://www.npmjs.com/package/@tomismeta/aperture-core)
- Paperclip GitHub repo: [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
