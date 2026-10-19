# LLP 0467: `hyp report list --json` stays remote-only; saved reports are `--local --json`

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports
**Author:** Brendan / Claude
**Date:** 2026-10-06
**Extends:** LLP 0465 (#list: replaces its one-array `--json` shape; the text section, `--local`, and the failure rules stand)
**Related:** LLP 0155 (#core-group: `list` and its `--limit` / `--before` paging), PR #2535 (review finding #5 and the author's choice of "split by flag")

> LLP 0465 made `hyp report list --json` one array: the remote's records,
> then a row per saved report. That broke the documented paging contract.
> This decision keeps `--json` the remote listing alone and gives saved
> reports their JSON through `--local --json`.

## Context {#context}

LLP 0465 #list appends one `{ source: 'local', ... }` row per saved report
(up to 100) to every non-flat `--json` run, whatever `--kind`, `--period`,
`--limit`, `--before`, `--org` or `--remote` say. Review of PR #2535 found
two failures in the paging that `docs/CLI_REFERENCE.md` documents:

- A script that pages with `--before "$(jq -r '.[-1].publishedAt')"` reads
  `null` from a saved row and stops.
- Every page repeats the same saved rows, so the array is no longer bounded
  by `--limit` and a script that collects pages counts each saved report once
  per page.

The same PR makes both report skills end with `hyp report save`, so any
machine that produces a report has saved rows. The author was offered three
options: drop saved rows whenever a remote filter is present, split by flag,
or accept the shape. The author chose to split by flag.

## Decision

### `--json` is the remote listing alone {#json-remote-only}

`hyp report list --json` prints the remote's records whole and nothing else,
the array it printed before LLP 0465. `--limit` bounds it, and its last row's
`publishedAt` is the next `--before`. A `--json` run does not read the store,
so an unreadable store raises no warning there.

`hyp report list --local --json` is the one JSON form of the saved reports:
`{ source: 'local', name, path, modifiedAt }` rows, as LLP 0465 #list
defines them, with no remote read. A script that wants both runs both.

Text output is unchanged. The saved section still follows the published
reports, and an implicit remote failure still degrades to it. A person
reading the terminal is not paging by the last row, so the section costs a
reader nothing, and the text form was never offered as a parse target.

## Consequences {#consequences}

- Scripts written against `--json` before LLP 0465 see the bytes they always
  did, and the paging example in `docs/CLI_REFERENCE.md` holds.
- A `source` field never appears in `--json`, so a consumer needs no filter
  for it.
- The JSON shapes of the two listings never mix: one call returns remote
  records, the other returns saved rows.

Tests cover: `--json` after a remote listing carrying no saved row while
`--local --json` returns them; and a `--kind --limit 2 --json` loop that pages
by the last row's `publishedAt` through `--before`, with every page within
`--limit`, no saved row, and every remote record seen once.

CPU and memory: a `--json` run no longer opens the store, so it drops one
`opendir`, one `lstat` per candidate, and up to 100 retained rows. Nothing
else changes.
