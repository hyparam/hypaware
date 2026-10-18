# LLP 0539: An unsupervised self-update refusal reaches hyp status

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, CLI
**Author:** neutral
**Date:** 2026-10-18
**Extends:** LLP 0365 (#restart-needs-a-supervisor: the refusal it settles
now leaves a line in `hyp status`)
**Related:** issue #1258

## Context {#context}

LLP 0365 has the automatic self-update lanes probe and install nothing when no
service manager will relaunch the daemon. The pass logs
`self_update.unsupervised` and returns. Nothing it records says so, so
`hyp status` shows a newer version as available, day after day, with no hint
why it never arrives. The person reading the status has no way to learn that
the daemon is declining on purpose or that `hyp update` would apply it.

## Decision {#record}

The self-update state gains one optional field, `refusal`, whose only value is
`unsupervised`.

- The automatic pass that declines at the unsupervised gate records it.
- The first automatic pass a supervised daemon makes clears it, before the
  rollback and probe gates, so a replacement daemon under a service manager
  does not wait a day for its next refusal to clear the last one.
- `hyp update` neither records nor clears it. It runs in a terminal, whose
  environment says nothing about how the daemon was started.
- `hyp status` reads it only while the daemon that wrote the state is alive,
  the same scoping `running_version` already has, so a stopped daemon's
  leftover is not shown as a refusal nobody is making.
- While an update is available and the refusal holds, the self-update line
  says automatic updates are unavailable because the daemon is not running
  under a service manager, and names `hyp update`. With nothing available
  there is no line to add to, so a manual update ends the message.
- `hyp status --json` carries the field under the same conditions.

## What this does not do {#non-goals}

It does not change how a supervisor is detected, and it adds no config key: a
person who wants automatic updates installs the daemon under its service
manager, as before.
