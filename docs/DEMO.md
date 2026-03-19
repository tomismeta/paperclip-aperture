# Demo

This is the fastest way to demo `paperclip-aperture` live inside Paperclip.

## Demo Thesis

Paperclip already knows about approvals, issues, and operator actions.

Aperture adds judgment:

- what deserves attention now
- what should wait next
- what should stay ambient

The demo should prove that `Focus` is not just another inbox. It is a judgment surface.

## What To Show

In 3-5 minutes, show:

1. `Focus` exists as a first-class destination inside Paperclip.
2. Pending approvals rise to the top as `now` and `next`.
3. Lower-salience issue activity stays `ambient`.
4. The operator can act from the Focus surface without leaving the plugin.
5. The plugin is powered by Aperture, but still behaves like a native Paperclip plugin.

## Demo Environment

Use the local sandboxed Paperclip instance:

- App: `http://127.0.0.1:3100`
- Focus page: `http://127.0.0.1:3100/CAM/aperture`

Recommended demo company:

- `Camera Paper Corp`
- prefix: `CAM`

## Pre-Demo Checklist

Before demoing, confirm:

- Paperclip is running
- the plugin is installed and `ready`
- the left sidebar shows `Focus`
- the Focus page loads without errors
- there is at least:
  - one pending approval
  - one additional queued approval
  - one low-salience issue visible as ambient

If you do not already have live data in the sandbox:

- create a new agent while board approval is enabled
- create a second approval-generating action
- create or update one normal issue that should remain ambient

## Suggested Live Flow

### 1. Start At The Sidebar

Open Paperclip and point out:

- `Focus` appears in the main navigation
- it sits naturally beside Inbox
- it is not a separate app or sidecar

Suggested line:

> This is Aperture embedded inside Paperclip as a normal plugin. The operator opens `Focus`, not a separate runtime.

### 2. Open Focus

Navigate to `http://127.0.0.1:3100/CAM/aperture`.

Point out:

- `Focus` is the user-facing destination label
- `Powered by Aperture` is secondary
- the surface is organized into:
  - `now`
  - `next`
  - `ambient`

Suggested line:

> Paperclip is the host shell and workflow system. Aperture is the judgment engine deciding what belongs in now, next, and ambient.

### 3. Explain The Top Item

Use the active frame.

Point out:

- title
- urgency / risk badges
- operator actions
- details disclosure

Suggested line:

> The top slot is reserved for the one thing the system thinks should own the operator right now.

### 4. Show The Queue

Move to `Next`.

Point out:

- ranked rows
- compact treatment
- lower visual weight than `Now`

Suggested line:

> This is not just a list of raw events. It is a ranked staging area behind the current focus.

### 5. Show Ambient

Move to `Ambient`.

Point out:

- low visual weight
- quieter presentation
- still visible for awareness

Suggested line:

> Ambient items are still visible, but they do not interrupt the operator.

### 6. Take An Action

Approve, reject, or request revision on one approval.

Point out:

- the action happens from inside Focus
- the surface updates live
- the operator does not need to go hunt in Inbox first

Suggested line:

> The goal is not to replace Paperclip. It is to add a judgment layer on top of Paperclip's existing control-plane primitives.

## Backup Narrative

If the live data is quiet, explain the architecture with this one-liner:

> Paperclip emits host facts, the plugin normalizes them, Aperture judges them, and Focus renders the result back inside Paperclip.

## Architecture Napkin

```text
Paperclip host facts
approvals / issues / failures
            |
            v
paperclip-aperture plugin
translate host facts into Aperture events
            |
            v
@tomismeta/aperture-core
judge now / next / ambient
            |
            v
Focus inside Paperclip
operator reviews and responds
            |
            v
Paperclip host actions
approve / reject / request revision / acknowledge
```

## What To Say If Asked

### "Did this require changing Aperture core?"

No. Aperture core was embedded as-is. The integration work lives in the plugin layer.

### "Did this require changing Paperclip core?"

No for the current working path. The plugin uses Paperclip's normal plugin model and trusted same-origin UI.

### "What is the product boundary?"

- Paperclip = runtime, event source, host UI, host actions
- Aperture = deterministic attention and judgment engine
- `paperclip-aperture` = adapter + persistence + UI

## After The Demo

Good follow-up prompts:

- Should `Focus` become the default operator surface for certain roles?
- Which Paperclip events deserve first-class treatment next?
- How much of Aperture's `Why this?` reasoning should be exposed in the UI?
