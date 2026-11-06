# LLP 0445: Restore canonical backfill commands

**Type:** Spec
**Status:** Accepted
**Extended-by:** LLP 0447 (remove the client history import alias)
**Extended-by:** LLP 0446 (remove backfill planning; use import dry runs)
**Systems:** CLI
**Author:** Brendan / Codex
**Date:** 2026-09-28
**Related:** LLP 0009, LLP 0248

## Request {#request}

The `client history import` journey spelling adds typing to a frequent
operation without clarifying what `backfill` already names. Restore the short
commands as the names taught by help, onboarding, and current documentation.
This extends LLP 0248's canonical tree and compatibility direction for history
commands only.

## Canonical commands {#canonical}

- `hyp backfill [provider...]` imports history.
- `hyp backfill plan [provider...]` requests provider planning information.
- `hyp backfill list` lists providers.

Keep `client history import`, `client history plan`, and
`client history providers` as aliases of those same registrations and runners.
Expose `backfill` in the Control capture and movement help section. Its help
shows import usage and the `list` and `plan` subcommands; client help no longer
advertises a history group. Canonical telemetry command names follow the short
registrations. Flags, boot profiles, JSON output, and import behavior stay the
same. No provider planning implementation is added by this change.

## Validation {#validation}

Check canonical and alias dispatch, help visibility, argument contracts,
onboarding hints, and the telemetry command allowlist through the existing
traditional test suite. This changes static command metadata and strings, with
no new per-record processing or persistent memory.
