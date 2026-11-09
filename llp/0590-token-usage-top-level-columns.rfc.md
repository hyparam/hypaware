# LLP 0590: Token usage as top-level columns

**Type:** RFC
**Status:** Draft
**Systems:** Gateway, Cache, Query, Plugins
**Author:** Kenny Daniel
**Date:** 2026-11-06
**Related:** LLP 0016, LLP 0029, LLP 0035, LLP 0390, LLP 0559

## Summary

Add nullable BIGINT columns for token counts to `ai_gateway_messages`:
`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
`reasoning_tokens`, and `total_tokens`. Fill them from the adapters'
`usage` object after settlement, using the meanings LLP 0035 already defines.
These six keys are the whole `usage` object in every recorded row, so the
columns replace `attributes.usage` without loss; the one adapter-only key,
`cost_usd`, stays in JSON (#cost-usd). During the transition both are written; once
old rows are backfilled and readers have switched, new rows stop carrying
`attributes.usage`.

## Motivation

Token accounting is the main reason queries read `attributes`, and reading one
number currently decodes the whole JSON value of every row in each row group.
A selective filter does not avoid this: on the local cache, a query filtered to
a `role` with no usage rows took 8.6 seconds, against 1.2 seconds for a scan
that does not read `attributes`.

The cost lands on queries agents really run. We parsed 9,454 SQL queries from
tool calls on the team remote (972 sessions, 18 gateways, May to November
2026). Of the 7,656 that read `ai_gateway_messages`, 606 extract usage, and the
four token paths are the four most extracted JSON paths in the set:

| Path | Extractions |
| --- | --- |
| `$.usage.output_tokens` | 584 |
| `$.usage.input_tokens` | 385 |
| `$.usage.cache_read_tokens` | 373 |
| `$.usage.cache_write_tokens` | 249 |
| `$.usage` (presence test or whole object) | 174 |
| `$.usage.reasoning_tokens` | 26 |
| `$.usage.total_tokens` | 6 |
| `$.usage.cost_usd` | 2 |

On the remote, counting usage rows for one person's seven gateways took 34.5
seconds, against 6.3 seconds to count their rows without reading `attributes`.

## Measurements

Prototype tables built from 300,000 real local rows (250,000 Codex, 50,000
Claude), written through icebird with 40,000 rows per append and queried with
squirreling directly. Best of two runs, in a fresh process. "Columns" is the
proposed shape with `attributes` left intact.

| Query | Today | Columns | Peak heap today | Peak heap columns |
| --- | --- | --- | --- | --- |
| Tokens per project, deduplicated per message | 2,504 ms | 366 ms | 437 MB | 178 MB |
| Output tokens per day | 2,163 ms | 65 ms | 331 MB | 18 MB |
| Usage with a selective `role` filter | 1,503 ms | 45 ms | 384 MB | 8 MB |
| Tokens for one session | 32 ms | 17 ms | 19 MB | 1 MB |

Table size went from 277 MB to 276 MB, a difference that also reflects moving
headers in that prototype, so treat it as "no meaningful change". Result rows
matched on their leading characters in all runs; a full equality check belongs
in the implementation tests.

Limits of this evidence: the rows are one Codex-heavy local cache, the remote
is mostly Anthropic, and the prototype also moved HTTP headers into a separate
column. The 1,290 ms result for moving headers alone puts the columns' own
contribution for the first query at about 3.5x, and the headers do not affect
the column-only aggregates at all.

## Design

### Columns {#columns}

Six nullable BIGINT columns, named exactly as their `attributes.usage` keys:

- `input_tokens`: net of cache, per LLP 0035#net-input.
- `output_tokens`
- `cache_read_tokens`
- `cache_write_tokens`
- `reasoning_tokens`
- `total_tokens`: the provider's raw total, per LLP 0035.

`total_tokens` is rarely queried (6 extractions), but recorded `usage` objects
hold nothing else, so including it is what lets the JSON copy go. NULL means
unknown, never zero, matching the existing guidance on missing usage.

Key census of every `attributes.usage` value, with these six keys and integer
values stripped: on the team remote, 1,417,418 rows from 2026-04-16 to
2026-11-08 across every recorded source (Claude, Claude Code, Claude Desktop,
Codex on both providers, OpenClaw, Hermes, LangGraph, loggate, and direct API
capture), and locally, 195,950 rows from 2026-08-01 on. Nothing was left in any
of them: no other key, and no non-integer value.

The adapters are not quite that tidy. Reading every adapter's usage builder:

- pi and opencode also write `cost_usd` (a float) into `usage`. No recorded row
  has one yet, but the code path exists.
- goose and pi accept any finite number, so a fractional count is possible in
  principle.
- Mastra Code keeps its counters under `attributes.mastracode`, and Claude keeps
  `cost_usd` under `attributes.claude`, so neither is affected.

### `cost_usd` stays in JSON {#cost-usd}

pi and opencode copy the client's own recorded cost into `usage.cost_usd` (pi
from `usage.cost.total` in its session file, opencode from the message's
`cost`). HypAware prices nothing, and the figure cannot be rebuilt from token
counts, so it must be kept. It gets no column: no recorded row carries it and
two queries in 9,454 asked for it. After the cutover, any `usage` key without a
column, `cost_usd` included, stays under `attributes.usage`, which then holds
only such leftovers.

### One derivation point {#derivation}

Derive the columns as the last step of `settleBatch` in the ai-gateway dataset
(`dataset.js`), after `retainClaudeUsageCarriers`. That step can strip usage
from a competing row (LLP 0559#usage-carrier), so deriving any earlier would
leave a counted value on a row whose usage was just removed. No adapter changes:
every adapter keeps writing `attributes.usage`, and the one-carrier rule
(LLP 0035#one-carrier) applies to the columns because they are read from the
surviving carrier.

A value that is not an integer becomes NULL (a fractional count stays only in
the JSON). While `attributes.usage` is
still written it keeps what the provider sent; after the cutover the
derivation must refuse to drop a `usage` key it has no column for, keeping the
whole object in `attributes` instead, so an unexpected key is never lost
silently.

Adapters keep producing a `usage` object; only the stored row changes. That
keeps the one-carrier and settlement logic in terms of one object, and the
cutover touches a single function rather than every adapter.

### Schema evolution {#evolution}

Adding nullable columns is the additive case LLP 0029 already supports: bump
`SCHEMA_VERSION` from 7 to 8 and declare the columns in `message_projector.js`.
Older data files read the new columns as NULL.

### Old rows {#old-rows}

This is the main risk. Files written before the change read as NULL, so
`SUM(output_tokens)` over mixed data would return a plausible low number with no
error, the same kind of wrong answer LLP 0035 exists to prevent.

Cache maintenance backfills them. A partition's table that was created
without the columns (its first schema lacks them) is due for one
whole-generation rewrite, which fills every row from its `attributes.usage`
and writes a fresh table created with the columns, so it is never due again.
The check reads table metadata maintenance already loads each tick, and a
partition created after the change is never due. The rewrite costs what a
forced compaction costs: 40 seconds and 894 MB peak for a 505 MB local Claude
partition of 233,000 rows, against 39 seconds and 882 MB without the backfill.
The daemon logs `daemon.cache_backfilled` for each partition it backfills.
Docs, skills, and `hyp query overview` keep using `attributes.usage` until the
backfill has covered every table. Only then do they switch.

### The backfill repairs double carriers {#dedupe}

Older data carries usage twice for some responses, and the columns would copy
that. On the team remote, Claude responses with more than one usage row added
about a third of output tokens in the first week of October 2026 (25,000
responses, 17 million of 52 million output tokens), about 4% the week after,
and almost none after PR #2826 (merged 2026-10-30) fixed new captures; about 13
a week remain. Almost all are the same response recorded by both Claude lanes
(`claude` from the transcript, `claude_code` from the client) under different
message ids, which is why a per-message check does not see them. Locally,
every row from 2026-08-01 to 2026-09-09 is also stored twice, inside the same
data files, all rewritten on 2026-09-09.

The backfill applies the one-carrier rule (LLP 0035#one-carrier) while it
fills the columns. A first, narrow scan of the partition groups its usage rows:
a Claude response by its request id (or API message id, the same keys
settlement uses for LLP 0559's carrier check), and any other row only with
exact copies of itself (same session, message and part), because other
adapters' request ids are not known to name one response. Only one row per
group gets the columns: the one with the largest `output_tokens`, first in scan
order on a tie. The others get NULL. When the copies differ, only `output_tokens` differs: the transcript copy
holds an early streaming count (5 against 5,517 in one case), and the larger is
the final count. `attributes.usage` is left as it was, so the repair can be
redone from it. Run on a copy of the local Claude partition, the backfill
counted exactly the usage rows less the duplicate copies found by SQL, in
every month (34,304 rows for October: 34,536 usage rows less 232 copies).

This is enough because the copies share a partition. On the remote, every
duplicated response from October 2026 has both copies on the same date, and
both Claude lanes share the `client_name` partition; 9 of about 27,000 span two
gateways and stay counted twice. The duplicated local rows keep their
duplicated content, which this RFC does not repair; only their usage is
counted once.

### Mixed client versions {#mixed-fleet}

Clients on older versions keep forwarding rows without the columns. The server
must derive them on ingest, from the same shared function, or those rows stay
NULL indefinitely and the old-rows gate never closes.

### Rollout {#rollout}

1. Write the columns on new rows, on clients and on the server, alongside
   `attributes.usage`.
2. Backfill old files through maintenance, repairing double carriers as it
   goes (#dedupe), and report per-table coverage.
3. Switch readers once coverage is complete: `overview.js`, the
   `hypaware-query` skill and `sql.md`, and the Claude carrier check in
   settlement (`retainClaudeUsageCarriers`, which today finds counted
   responses through `attributes.usage`). Update LLP 0035's canonical query
   surface with an `Extended-by` note in the same change.
4. Stop writing `attributes.usage` on new rows. Old rows keep their JSON copy;
   it is immutable, nothing reads it after step 3, and stripping it is not
   worth a second rewrite. Saved queries and reports that still extract
   `$.usage` keep working on old rows but see NULL on new ones, so this step
   ships with a release note.

## Alternatives

- **Keep `attributes.usage` forever.** Costs about 0.4% of `attributes` bytes
  and no query speed, since the columns skip the JSON. Rejected because two
  copies of the same counts can drift, and agents would keep finding both.
- **Drop `attributes.usage` immediately.** Breaks the overview, the skill,
  settlement, and every saved query on the first release, before old rows
  have columns. Rejected in favor of the staged cutover above.
- **Parquet variant shredding.** `hyparquet-writer` can shred `usage` inside the
  variant, which keeps one column and gives typed storage. The reader takes only
  whole top-level columns today, so it would still decode everything until that
  changes, and queries would still need JSON syntax. Not measured.
- **Skip unrequested keys while decoding `attributes`.** A prototype that decoded
  only the top-level `usage` key brought the first query to 789 ms, with no
  migration, and it would help every JSON path. It complements this RFC rather
  than replacing it, and belongs in its own proposal across hyparquet and
  squirreling.
- **Rollup table.** Faster again for dashboards, but it adds a dataset to keep
  consistent and does not help ad hoc per-session questions.

## Out of scope

Removing duplicated rows themselves, and double carriers that span partitions
or gateways (#dedupe).

Moving HTTP headers and `claude.tool_use_result` out of `attributes`. Each is
named by about one query in 9,454, and they are large (headers 70% of attribute
bytes in a 1% local sample; `tool_use_result` about 60% in a remote sample of
10,000 rows, which was capped and so is rough). This deserves its own decision.

## Open questions

- **Column names.** Bare names match the JSON keys and read well, but queries
  often alias a sum to `input_tokens`. A `usage_` prefix avoids any confusion
  at the cost of longer SQL.
- **Backfill cost on the server.** Measured locally (#old-rows), the backfill
  costs one forced compaction per partition. The server's 7.3 million rows
  have not been measured.
- **The server.** Its registry keeps only the dataset schema, and its mover
  writes forwarded rows without the settle step, so rows from upgraded clients
  arrive with the columns but nothing fills them for older clients or for rows
  already stored. Planned as a follow-up in the server repo: the mover calls
  the exported `withUsageColumns` for rows that lack the columns, and a
  one-off script rewrites the stored cache and archive rows with the same
  dedupe (there is one server). Until then, server queries over older dates
  still need the JSON.

## References

- [LLP 0029](./0029-additive-cache-schema-evolution.decision.md): additive schema changes
- [LLP 0035](./0035-token-usage-normalization.decision.md): usage meanings and the one-carrier rule
- [LLP 0559](./0559-claude-recording-identity-and-usage.spec.md#usage-carrier): committed carriers
