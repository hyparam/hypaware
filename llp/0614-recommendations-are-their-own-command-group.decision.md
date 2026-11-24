# LLP 0614: Recommendations are their own command group

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports
**Author:** Brendan / Claude
**Date:** 2026-11-17
**Extends:** LLP 0155 (#core-group: the `report` group keeps generate, save, publish, list, get and delete; its recommendation members move out), LLP 0248 (#tree: `recommendation list|get|publish|mark|delete` joins the journeys), LLP 0461 (#mark, #standalone: the verbs are spelled `recommendation mark` and `recommendation publish`), LLP 0414 (the read `fix` names is `hyp recommendation get <id>`), LLP 0604 (the standalone record's read, list and delete have their own commands)
**Related:** hypaware-server LLP 0705 (a standalone recommendation has its own record), LLP 0610 (`hyp fix` is top-level), LLP 0393 (#contract: six names join the finite command vocabulary), LLP 0494 (the MCP contracts' CLI equivalents)

> The server keeps a recommendation with or without a report around it, but
> every CLI command that touched one was spelled `hyp report ...`. This
> decision gives recommendations their own noun and leaves `report` for
> reports.

## Context {#context}

Five of the nine `report` commands were partly or wholly about
recommendations, three of them by argument shape: `report get` and
`report delete` took either a report's `<kind> <period> <id>` or a lone
recommendation id, and `report list` became a different listing under
`--recommendations` or `--status`. Since hypaware-server LLP 0705 a
recommendation published on its own is stored with no report at all, so
`hyp report recommend` published something that was not a report and
`hyp report delete <rec-id>` deleted something no report held.

## Decision {#decision}

```text
recommendation list [--status <state,...>] [--standalone] [--kind <kind>] [--period <period>] [--limit <n>] [--before <publishedAt>] [--json]
recommendation get <id> [--output <file>]
recommendation publish <file.md> [--title <title>]
recommendation mark <id> <open|in_progress|applied|dismissed> [--reason <text>] [--link <url>]...
recommendation delete <id> [--yes]
```

Each also takes `--org` and `--remote`, as the report commands do. `rec` is
an alias for the group and for each subcommand. The group is listed in
primary help under "Explore and share", between `report` and `fix`.

The commands call the routes and runners the `report` forms already used; no
request, receipt or exit code changes except the command name in messages.
`recommendation get` and `recommendation delete` take a recommendation id
and refuse anything else before a request is made, so a report's address is
not reachable through them.

### The listing {#list}

`recommendation list` is the flat listing `report list --recommendations`
gave: recommendations inside reports and standalone ones as one sequence, as
the server answers them. `--standalone` passes the server's
`standalone=true` filter through.

### The old forms {#aliases}

`report recommend` and `report mark` are compatibility aliases under the
LLP 0248 #aliases rules. `report list --recommendations`, `report list
--status`, and a lone recommendation id given to `report get` or
`report delete` are argument forms, not names, so they stay accepted by the
`report` commands and are no longer documented. Removing any of them takes a
future major-version LLP.

Messages, prompts and receipts print the new spellings, including the read
command `hyp fix` hands a client and the `cli` equivalents in the MCP tool
contracts (LLP 0494).

### Telemetry {#telemetry}

`recommendation` and its five subcommands join the finite command vocabulary
of LLP 0393 #contract; `report recommend` and `report mark` leave this
client's copy. A receiver should keep the retired names for older clients.
