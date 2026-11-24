# LLP 0621: one entry point owns the machine

**Type:** Decision
**Status:** Draft
**Systems:** CLI, Daemon, Clients, Update
**Author:** Kenny / Claude
**Date:** 2026-11-24
**Related:** LLP 0309 (kernel auto-update), LLP 0405 (the unversioned global CLI install), LLP 0541 (the updater runs its own npm install), LLP 0380 (an installed copy yields to the bundled one: the same posture applied to plugins)

> A machine can carry more than one copy of the CLI, and each writes the
> service and the client hooks with its own path. One key in the local config,
> `entrypoint`, names the copy that owns the machine.
> Every other copy hands its command to that one before doing anything else,
> so the service, the hooks, and the package are only ever written by the
> owner.

## Context {#context}

The native macOS app (HypKit) bundles its own copy of HypAware and is
deployed by MDM. Many of the Macs it lands on already have an npm global
from `npm i -g hypaware` and `hyp setup`. Testing the app on such a Mac
(an Iru sandbox, 2026-11-17) found:

- The app takes over the service, but `~/.claude/settings.json` hooks still
  run the npm copy. `hyp client attach claude` answers "already attached" and
  leaves them, because the only stale-hook check is "is the recorded bin
  ephemeral", and an npm global is not. If the engineer later removes the npm
  package, Claude Code capture stops with no message.
- Nothing stops the npm copy taking things back. `hyp setup` from npm writes
  the service with its own path, and the npm copy's updater keeps updating a
  package the app no longer runs.

Fixing each command that writes a path (attach, daemon install, setup,
update) would leave every future command to remember the rule.

## Decision {#decision}

One pointer, read at the front door. The local config
(`hypaware-config.json`) gets a top-level `entrypoint` key holding `bin` (the
owning copy's `bin/hypaware.js`), optionally `node` (the runtime to start it
with, for an app that bundles one) and `owner` (a label for messages).

### The config key {#config-key}

It lives in the config rather than a state file of its own, so there is one
file to look at for how this machine is set up.

- **Read without the loader.** The front door parses the file with a bare
  `JSON.parse` and takes the one key, as the self-update lane already does for
  `auto_update` (LLP 0309#config-key). It follows the same path order as
  `resolveConfigPath`: `--config`, then `HYP_CONFIG`, then
  `<HYP_HOME>/hypaware-config.json`. A config that is missing or will not
  parse reads as no entry point; the loader still reports it.
- **Local only.** It names a path on one machine, so the merge takes it from
  the local layer and ignores a central value, as it does for `query`.
- **Written by merge.** `claim` and `release` read the file, set or drop the
  one key, and write it back atomically with an mtime check, leaving every
  other key alone. A command that rewrites the whole config (an attended
  `hyp setup`) can drop it; the installer claims again on its next pass.

### The front door {#front-door}

`bin/hypaware.js` checks the pointer right after `argv` is read, before the
self-update lane and dispatch. If a live entry point names a different file,
the command runs there (`spawnSync`, stdio inherited, exit code or `128 +
signal` passed back) and nothing runs here. Because the hand-off precedes
everything, `hyp setup`, `hyp daemon install`, `hyp client attach`,
`hyp update` and `daemon run` from a non-owner all run in the owner, with no
per-command rule.

- **Dead pointer.** When `bin` no longer exists (the app was deleted without
  its uninstaller, an nvm switch moved the npm prefix), the pointer reads as
  unset and the invoked copy runs as it would with none. It is not removed on
  read; the next `claim` replaces it.
- **No loops.** The child gets `HYP_ENTRYPOINT_HANDOFF=1` and runs whatever
  the pointer says.
- **Developer escape.** `HYP_NO_HANDOFF=1` runs the invoked copy.
- **Cost.** One `readFileSync` and `JSON.parse` of the local config per
  invocation, hooks included. The config is small, and the module uses node
  built-ins and `runtime/paths.js` only.

### Claiming {#claim}

`hyp entrypoint claim [--node <path>] [--owner <label>]` records the copy it
runs in. `entrypoint` is the one command never handed off, so an installer
can claim while another copy is named. The installer then installs the
service and attaches clients as it does today. `release` clears the pointer
from the owner, or from anywhere with `--force`; an uninstaller runs it.
With no pointer set, every copy behaves exactly as before this decision.

### Hooks {#hooks}

Client status reads a Claude marker as stale (`markerFormatStale`) when a
managed hook names a CLI other than the live entry point. That is the signal
attach already uses to rewrite hooks for a live daemon, so the next attach
(which, through the front door, runs in the owner) writes the owner's path.

### Updates {#updates}

No new rule. The npm copy's updater only runs inside `daemon run` and
`hyp update`, and both now run in the owner. An app bundle has no
`node_modules` in its path, so the provenance guard (LLP 0309) already reads
it as a checkout and never self-updates it; its updates come from MDM. An
engineer's hand-typed `npm i -g hypaware@latest` updates the npm copy on
disk and changes nothing that runs.

## Not decided here {#not-decided}

- The service unit is not checked against the pointer. A LaunchAgent written
  by npm before the claim still starts the npm bin, which hands off, so it
  works; the installer rewrites it with `daemon install`.
- Windows and Linux follow the same file; only macOS has an installer that
  claims today.
