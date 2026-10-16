# LLP 0206: Uninstalling the service detaches the clients it was serving

**Type:** Decision
**Status:** Draft
**Systems:** CLI, Daemon, Onboarding
**Author:** Kenny / Claude
**Date:** 2026-08-10
**Related:** LLP 0063 (#connection-levels: the ladder this adds a second cascade to), LLP 0045 (#part-3: the one disk undo this reuses), LLP 0138 (#marker-undo: asset reversal comes with that undo), LLP 0017 (daemon service lifecycle), LLP 0210 (#d1: the signature-only ownership rule that lets the sweep run from disk alone)
**Extended-by:** LLP 0232, Claude Code attaches through an HTTPS proxy rather than a repointed base URL (the cascade matters more under proxy mode: a leftover `HTTPS_PROXY` with nothing listening breaks all of Claude Code's HTTPS, not only its model calls, and a leftover CA is trusted key material with no owner)

> Extends [LLP 0063 #connection-levels](./0063-login-auto-provision-forward-sink.decision.md#connection-levels).
> The ladder and its verbs stand. What changes is that level 4's exit, like
> `leave`, cascades **down**: `hyp daemon uninstall` finishes the level-1 exit
> too, because the level-1 state it leaves behind is not merely stale, it is
> broken.

## Context {#context}

LLP 0063 gave the CLI four connection levels, each with a symmetric enter/exit
pair, and a rule that keeps the ladder legible: **each level exits with its own
verb**, with one deliberate exception (`leave` cascades down, never up).

Under that rule `hyp daemon uninstall` removes the launchd / systemd service and
nothing else, by design: "leaves config, recordings, exports, and client settings
untouched". A user who has attached Claude and Codex and then uninstalls the
daemon is left with `~/.claude/settings.json` still setting
`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and `~/.codex/config.toml` still
naming a `hypaware` model provider on that same port, with nothing listening.

That is the asymmetry with the rest of the ladder. Detaching a client that is
still capturing costs the user observability. **Uninstalling the daemon under a
live attach costs the user their coding agent**: a base URL pointed at a dead
local port does not degrade to talking to Anthropic directly, it fails every
request. The symmetric-verbs rule was written to keep the ladder from being
confusing; here it produces a machine that is broken by a command whose whole
job was to stop HypAware from being involved.

The user reaching for `hyp daemon uninstall` is saying "stop running HypAware on
this machine". Reading that as "and leave both my coding agents pointed at a
port that no longer answers" is a reading nobody wants.

## Decision {#decision}

<a id="d1"></a>**D1: `hyp daemon uninstall` detaches every attached client after
it removes the service.** The service teardown runs first and stays the command's
primary job; only once it succeeds does the sweep run. A failed uninstall leaves
a daemon still serving that port, and detaching from a working gateway would cost
capture for no reason.

The sweep reverses through the single core disk undo `hyp detach` and the daemon
reconciler's `reverse()` already share (LLP 0045 #part-3), so org-installed
assets come off with it (LLP 0138 #marker-undo) and there is no third
implementation to drift. It asks every known client rather than probing first:
the undo is already an honest no-op on a client that was never attached, so a
machine with nothing attached prints nothing extra.

The sweep depends on nothing from the daemon it just removed. Every format's
undo record lives in the client's settings file itself: the `json` marker key,
the `toml` managed block, and the `json_path` entry's own signature
(LLP 0210, which retired that format's live-origin ownership check precisely
because this sweep runs when no live origin exists). Teardown and detach are
therefore independent disk operations with no ordering constraint between
them beyond D1's teardown-first gate, and the sweep behaves identically
whether the daemon was running, stopped, or crashed when uninstall was
invoked.

The sweep runs the undo quiet and re-renders its result itself, warnings
included: a notice like "overridden externally; leaving in place" is the only
record that a detach reported here still leaves the user a file to fix, so
dropping it would turn a half-finished detach into a silent one.

Per-client failures are collected, not thrown. One wedged client must not leave
the rest attached; each failure names the client and the `hyp detach <client>`
that finishes it, and the command exits nonzero.

<a id="d2"></a>**D2: `stop` and `restart` still touch nothing.** Only
`uninstall` cascades. A stopped or restarting service is coming back, and its
port with it: detaching there would break capture on every restart and leave the
user re-attaching by hand. This keeps the cascade tied to the thing that makes it
necessary (the port is gone for good), not to daemon lifecycle generally.

## Consequences {#consequences}

- The `leave`-cascades-down exception in LLP 0063 #connection-levels is no
  longer the only one. The rule as amended: **an exit verb may cascade down when
  the lower-level state it would leave behind is broken rather than merely
  stale**, and never up.
- `hyp daemon uninstall` is no longer a pure service-level operation: it edits
  the settings file of every attached client (`~/.claude/settings.json`,
  `~/.codex/config.toml`, `~/.openclaw/openclaw.json`, and whatever clients are
  added later). It says which files it touched, by path, for exactly that
  reason, and user-facing text names no fixed client list, so a new client
  adapter joins the sweep without a docs change.
- A reinstall flow (`uninstall` then `install`) now needs `hyp attach` again.
  That is the honest cost of the trade, and the reason no opt-out flag exists:
  the flow that wants the attach preserved is `hyp daemon restart`, which never
  detaches (D2).
- `hyp leave` continues not to uninstall the daemon (LLP 0063), so nothing here
  changes the fleet path: leaving an org keeps local capture working.
