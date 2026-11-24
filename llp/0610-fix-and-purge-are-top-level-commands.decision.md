# LLP 0610: `hyp fix` and `hyp purge` are top-level commands

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports, Usage-Policy
**Author:** Brendan / Claude
**Date:** 2026-11-17
**Extends:** LLP 0248 (#tree: `fix` and `purge` join the top-level journeys; #aliases: `purge` stops being an alias of `privacy purge` and the direction reverses), LLP 0414 (the verb that starts a client on a recommendation is spelled `hyp fix`), LLP 0155 (#core-group: `fix` leaves the `report` group's listing)
**Related:** LLP 0104 (`hyp purge` was the original spelling; its behaviour is unchanged), LLP 0393 (#contract: `fix` and `purge` replace `report fix` and `privacy purge` in the finite command vocabulary), LLP 0609 (the same shortening for `query graph` and `query vector`)

> Two commands people type on purpose, to act, sat one level down under a
> noun: `hyp report fix <id>` and `hyp privacy purge <target>`. Both become
> top-level: `hyp fix` and `hyp purge`.

## Context {#context}

LLP 0248 grouped `purge` under `privacy` and kept the bare word as a
compatibility alias. LLP 0414 added `fix` to the `report` group because a
recommendation comes from a report. In use, neither noun helps: `fix` takes a
recommendation id and starts a client in the current directory, and a
standalone recommendation has no report at all (LLP 0604); `purge` is the one
destructive verb in the privacy surface and was already reachable, and taught
in older docs, as `hyp purge`.

## Decision {#decision}

```text
fix [id] [--kind <kind>] [--period <period>] [--limit <n>] [--org <org>] [--remote <target>]
purge <path> | --session <id> [--remote <target> | --local-only] | --ignored | --all [--yes] [--json]
```

- `fix` is listed in primary help under "Explore and share", after `report`.
- `purge` is listed under "Control capture and movement", after `privacy`.
- `report fix` and `privacy purge` are compatibility aliases under the
  LLP 0248 #aliases rules: one registration and runner, omitted from help,
  removed only by a future major-version LLP.
- Arguments, confirmation, exit codes and output are unchanged. Messages and
  receipts that name the command print the new spelling, including the
  `purge.command` fields of the session ignore receipt.

### Consequences {#consequences}

- `hyp report --help` no longer lists `fix`, and `hyp privacy --help` no
  longer lists `purge`. Their group help text is where a reader is pointed
  across.
- Output that an installed skill or script matched on the old spelling
  (`hyp privacy purge ...`, `hyp report fix: ...`) changes text. The commands
  themselves keep working under either spelling.

### Telemetry {#telemetry}

`fix` and `purge` join the finite command vocabulary of LLP 0393 #contract
and `report fix` and `privacy purge` leave this client's copy, since an alias
reports as its canonical command. A receiver that validates against its own
copy needs the two new names added, and should keep the two retired names for
clients released before this change.
