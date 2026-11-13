# LLP 0604: A recommendation without a report

**Type:** Spec
**Status:** Draft
**Systems:** CLI, Reports
**Author:** Brendan / Claude
**Date:** 2026-11-12
**Related:** LLP 0414, LLP 0461

> The server can now hold a recommendation that belongs to no report
> (hypaware-server LLP 0705, a Draft in
> hyparam/hypaware-server#1707). The report
> commands read one wherever they read a recommendation today, and keep
> reading the older answers that always named a report.

## What the server answers {#no-report}

A recommendation published on its own with `hyp report recommend` is stored
by a current server as a recommendation, with no report made to hold it. Its
row has `standalone: true`, its own `publishedAt`, and no `report` member; the
resolve of its id answers the row with no report beside it. A recommendation
inside a report, and a one-page report an older server made for a standalone
recommendation, answer as before, with a `report`.

The commands follow the answer:

- `hyp report recommend` prints `published <id> (standalone)` when the answer
  names no report, and the report triple when an older server names one.
- `hyp report get <id>` and `hyp report fix <id>` accept a resolve answer with
  no report only when the row says `standalone: true`. Any other answer missing
  its report is still refused as incomplete, since the report triple is what
  the page address is built from.
- The page of a report-less recommendation is read at
  `_recommendations/<id>/page/<page>.md`, then `.html`. The CLI builds that
  address from the id it asked about. It does not follow the `url` the row
  carries, so a response cannot direct the credential to another path.
- `hyp report list --recommendations` shows the row's own publish time and
  `standalone` in the report column.
- The prompt `hyp report fix` hands a client says the recommendation was
  published on its own, where it otherwise names the report.

## The picker {#picker}

`hyp report fix` with no id offers reports first and then the picked report's
recommendations. Report-less recommendations are in no report, so the reports
listing cannot supply them. The picker asks the recommendation listing for
`standalone=true`, keeps the rows that carry no `report`, and offers them as
one final group, "Standalone recommendations". A row that does carry a report
is skipped here because it is already offered under that report, which also
makes an older server (one that ignores the filter and answers every row)
harmless. `--kind` and `--period` name reports, so with either the group is
not asked for. A server that cannot answer the request leaves the picker
exactly as it was.

## Deleting one {#delete}

`hyp report delete <id>`, with a recommendation id as its only argument,
deletes a report-less recommendation. It resolves the id as `get` does and
sends `DELETE _recommendations/<id>`, an address built from the id it asked
about. A recommendation that is a page of a report is not deleted: the command
says a report is deleted whole and prints the `<kind> <period> <id>` form that
deletes it. That covers an older server too, which answers a standalone
recommendation as a one-page report. A server whose answer is incomplete or
that does not know the id deletes nothing. The `<kind> <period> <id>` form is
unchanged.

## Out of scope {#out-of-scope}

The MCP tool contracts, whose input shapes do not change.
