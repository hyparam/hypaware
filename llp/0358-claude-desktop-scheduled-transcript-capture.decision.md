# LLP 0358: Claude Desktop capture is a scheduled transcript backfill

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Backfill, Sources, Onboarding
**Author:** Phil / Codex
**Date:** 2026-08-31
**Related:** LLP 0012, LLP 0115, LLP 0133, LLP 0140, LLP 0170, LLP 0224 (#repair-surface: the incomplete-setup prompt this retires for Desktop), LLP 0229 (#diagnostic-is-out-of-scope: the exception this closes), LLP 0297
**Extended-by:** LLP 0359 (scheduled passes are serialized, retention-bounded,
and skip unchanged transcript bodies with candidate-scoped cache dedupe)

> Claude Desktop capture no longer depends on attaching its inference path.
> Selecting Desktop enables the Claude transcript reader, and the daemon
> reruns that backfill every five minutes. The existing profile and install
> commands remain available as an explicit, optional live-capture experiment,
> but onboarding never invokes them and transcript capture needs no credential,
> browser login, plist write, sudo prompt, or Desktop restart.

## Problem {#problem}

Claude Desktop's third-party-inference attach has proven too fragile to be the
capture prerequisite. It depends on private app behavior, a credential helper,
root-owned managed preferences, stale container residue, and a restart. Any one
of those can leave the product configured while turns remain uncaptured.

The durable evidence already exists independently of that path. Desktop writes
JSONL transcripts into the shared Claude projects tree and, for attached builds,
into per-session homes under the `Claude-3p` container. The Claude backfill
reader already discovers both locations, classifies them as Desktop through LLP
0140's entrypoint and container-owner rules, projects their native identities,
and deduplicates them against rows already in the cache.

The daemon also already owns a generic scheduled-backfill driver. OpenClaw uses
it to rerun an idempotent transcript provider. Building another watcher, parser,
or Desktop-specific cache path would duplicate both mechanisms.

## Decision {#decision}

### The transcript is the primary capture lane {#transcript-primary}

Claude Desktop is captured from its on-disk transcripts. The capture contract
is transcript fidelity within the sweep interval, not wire fidelity in real
time. The inference attach is not a prerequisite and its success or failure
does not affect scheduled imports.

The existing `@hypaware/claude` provider remains the one reader and the one
backfill contribution. `@hypaware/claude-desktop` remains the manifest owner of
Desktop entrypoints and container roots, so the LLP 0140 consent gate and
`client_name = 'claude-desktop'` attribution stay intact.

### The daemon reruns Claude backfill every five minutes {#scheduled-sweep}

The Claude contribution opts into the existing daemon sweep with a default
cron of `*/5 * * * *`. Operators may change it with
`claude.backfill.sweep_cron`; validation uses the same five-field cron grammar
as sinks and the OpenClaw sweep.

Each tick reruns the normal provider and materializer. Native `part_id` dedupe,
including the materializer's scan of rows still waiting in the spool, makes an
unchanged transcript a zero-write pass. The provider's existing structured
`scan_started` and `scan_complete` events and the driver's
`backfill.sweep_due`, `backfill.sweep_finished`, and
`backfill.sweep_failed` events are the operational surface.

There is no Desktop quiesce window. A fresh transcript is the only primary
lane, and delaying every open conversation until inactivity would defeat the
continuous-backfill goal. The reader is already best effort over appended or
truncated JSONL: it imports complete lines and ignores an incomplete tail until
the next pass. Claude Code can still overlap the same provider through its OTEL
lane; its native identity settlement and the shared materializer dedupe remain
the convergence mechanism.

### Onboarding selects capture, not setup {#onboarding}

The Claude Desktop picker row is visible and no longer declares `needs_setup`
or a `configure_command`. Selecting it composes `@hypaware/claude`, which owns
the scheduled reader, plus `@hypaware/claude-desktop`, which owns admission and
attribution. It does not compose `@hypaware/claude-account` and does not run a
privileged command.

The Desktop adapter therefore treats `hypaware.anthropic-credential` as
optional. Its legacy profile, helper, install, status, and verify commands stay
registered for an operator who explicitly configures the credential plugin and
wants to test the live route. Without that capability they fail locally with a
repair message; plugin activation and transcript capture continue.

## Consequences {#consequences}

- A detected Desktop install can be selected like the other clients. The user
  can uncheck it before config is written; no history is read unless the
  Desktop ownership plugin is in the effective config.
- New complete transcript lines normally appear within five minutes. A daemon
  restart loses no cursor because the sweep is a deterministic rescan and the
  cache dedupe is durable.
- The scan currently walks the available Claude transcript trees on every
  pass. This is deliberately the smallest reliable implementation. A durable
  file cursor is a later optimization only if measurements show the rescan is
  material.
- LLP 0115 and LLP 0133 still describe the optional managed-profile experiment,
  not the capture prerequisite. LLP 0297's reason for hiding the row no longer
  applies because onboarding invokes no browser, plist, residue, or sudo work.

## Verification {#verification}

- Unit tests pin the default and configured cron plus malformed config.
- Manifest composition tests prove Desktop selects the Claude reader and no
  credential plugin or setup command.
- The `backfill_claude_fixture` smoke runs the real Claude provider through the
  generic driver, observes Desktop-attributed transcript rows on the first
  tick, and observes zero new rows on the second tick.
