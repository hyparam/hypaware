# LLP 0620: A Claude tool call both lanes recorded settles to one row by its tool id

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Sources, Cache, Plugins
**Author:** HypForge steward
**Date:** 2026-11-23
**Related:** LLP 0027 (#re-settle-sweep), LLP 0040 (#watermark-contract),
LLP 0301 (#bounded-resettle), LLP 0389 (#match-key-on-bodies), LLP 0390,
LLP 0435 (#tool-id-first), LLP 0559 (#usage-carrier), LLP 0590;
hypaware-server LLP 0001 (#idempotency-key), LLP 0152 (#org-scope),
LLP 0683 (#rows)
**Extends:** LLP 0301 (#local: pass 1 also records Claude tool keys, and
pass 2 holds and merges a claimed key's rows), LLP 0559 (#survivor: a
maintenance rewrite may move committed usage onto the survivor)

## Summary

A Claude tool call can be stored twice: once by the OTEL lane, under a
fallback hash, and once by the transcript sweep, under the transcript
line's uuid. The flush-time lookup that should join them (LLP 0389, LLP
0435) missed. Both rows carry the same `tool_call_id`. Their `part_id`s
differ, so neither the client's dedupe nor the server's ingest index can
see that they are the same call.

This doc settles what should happen once that lookup has missed:

- **The match.** Rows are the same call when they share the session, the
  `tool_call_id` and the part kind (call or result). Exactly one native row
  must hold that key.
- **The survivor.** Identity comes from the native row. Content and
  timestamps come from the earliest copy, so a later replay never replaces
  the original. Usage is carried once.
- **The local path.** The cache-maintenance re-settle rewrite, as a key
  match beside the transcript match (LLP 0301's two passes, extended).
- **The hosted path.** Server ingest records the key. A bounded,
  journaled server pass rewrites each pair and rebuilds the derived daily
  tables it touched. Whether pairs already stored are rewritten or hidden
  is the owner's decision (#questions).

The match and the survivor rule are one exported function in this repo,
which the server imports.

## Evidence {#evidence}

### The pair reproduces through the real code {#repro}

Built from the fixtures in `test/plugins/claude-otel-body-overlap.test.js`:
one `[tool_use]` response, one `tool_result`, and the real projection,
settlement and backfill code. The transcript is hidden at the OTEL flush,
then restored before the sweep runs.

1. **The OTEL flush.** The tool call commits as `3a39d0e53ae68dc0#0` and its
   result as `1b6f9cb7fc436b47#0`, both still fallbacks. The call row
   carries the response's usage (`input_tokens` 12, `output_tokens` 34).
2. **The sweep flush,** with those rows committed. It writes
   `5233b3fa-...#0` and `77ea6f90-...#0`. `dedupeSweepRows` compares
   `part_id` only, so nothing drops. The committed-carrier check (LLP 0559
   #usage-carrier) finds the fallback holding this response's usage under
   the same session and request id, and strips `usage` from the native call
   row.
3. **The re-settle,** transcript now present. The independent review reran
   this with the real storage service and `maintainCache`. The result is two
   native rows, with no usage and no `system_text` or `client_version`. A
   second maintenance run changes nothing.

| Where | Tool rows for the call | Usage for the response |
|---|---|---|
| Local cache, before maintenance | 2 (fallback and native) | once, on the fallback |
| Local cache, after maintenance | 1, the native copy | **none**: `resettleFallbackRows` drops the upgraded live row ("the native twin wins"), and with it the only carrier |
| Hosted archive | 2, for good | once, on the fallback |

**The reverse order.** The native row commits first, and a later live flush
misses. The native row then carries the usage and the live row is stripped.
Maintenance without the transcript leaves both rows. That was also
reproduced by the review.

**The hosted copy cannot heal from the client.** A row's `_hyp_ingest_seq`
is row-resident and survives every rewrite (LLP 0040), so the forward sink
never re-sends a row maintenance upgraded. The server's part-id index
(hypaware-server LLP 0152) accepts both rows of a pair.

The local usage loss is new to this doc. The survivor rule below fixes it
for tool rows.

### Why the lookup can miss {#why-the-lookup-misses}

The flush lookup succeeds only when the daemon can read the session's
transcript and finds exactly one single-block line for the tool id
(`findOtelToolMatch`). Each of these breaks it. The code admits all of
them, and the report's records cannot tell them apart:

1. **The line is not on disk yet at the flush.** A flush runs at any query
   once two minutes have passed since the last one (`QUERY_FLUSH_DEBOUNCE_MS`),
   on `flushAll`, and at the 512 MiB spool threshold. The window is seconds.
2. **The transcript is not on this machine at all.** The session's OTEL
   export reached a daemon on one host or container, while the sweep ran
   where the transcript lives. The two rows of such a pair carry different
   `gateway_id`s.
3. **A replay after a restart.**
   - Every `api_request_body` carries the whole history. The writer's guard
     against re-projecting it is process memory (`seenMessages`, not seeded
     on this lane). The pre-write check looks for fallback `part_id`s that
     flush settlement has since renamed.
   - So after a daemon restart, the first request body re-emits every
     earlier tool block as a fresh fallback row. Its `message_created_at`,
     and so its `date`, is the replay's (`gapMessage`).
   - If the lookup also misses at that flush, the pair spans two dates.
4. **A multi-block line.** For example a user line `[tool_result, text]`.
   `findOtelToolMatch` accepts single-block lines only. On one HypForge
   host's transcripts this was 14 lines in about 25,000 tool results.
5. **A server tool's result.** A `web_search_tool_result` block has the
   assistant role, and neither arm of `findOtelToolMatch` takes it.

A related shape is not this doc's. A forked subagent's transcript copies
the parent's spawning call and its result under new uuids, so the sweep
stores them twice, **both rows native** (hyparam/hypaware#3056). This doc
treats such a key as ambiguous and leaves it alone (#unambiguous).

**What would name the cause.** Each hosted pair already holds the evidence:

- whether the two rows' `gateway_id` match (mechanism 2);
- the gap between their `message_created_at`: seconds for mechanism 1,
  minutes to days for mechanism 3;
- whether their `date`s differ;
- their part kind and role (mechanism 5).

That read needs server data access, so it is an operator's, and it is not
blocking. The client also gains a settle-miss counter by reason (no
transcript entries, no line for the tool id, a multi-block line, a kind
neither arm takes), readable in the maintenance report. The next field
report then names its own cause.

**The design below does not depend on which mechanism it is.** It
reconciles where the two rows meet, whatever kept them apart.

## Decision

### The key {#tool-identity}

A row takes part when all of these hold:

- `client_name` is `claude` or `claude-desktop`;
- `provider` is `anthropic`;
- `tool_call_id` is non-empty;
- `part_type` is `tool_call` or `tool_result`.

Its key is `(session_id, tool_call_id, part_type)`. The server prefixes the
org from the verified claim (hypaware-server LLP 0152 #org-scope). Locally
the cache is the org.

- A row is the **live** side when it carries the existing fallback marker,
  `attributes.gateway.identity_source = 'gateway_fallback'`. Its
  `message_id` is the 16-hex fallback hash.
- It is the **native** side when it carries no marker. That includes a live
  row flush settlement already upgraded.

No column, attribute or config key is added. Every input is already stored
by every client version that writes these rows.

### Only an unambiguous key merges {#unambiguous}

- A key merges only when it has **exactly one native `part_id`** and at
  least one live row.
- Any number of live rows may match it. A replay hashes to a second live
  row whenever a later request carried the block with different content.
- A key with two or more native `part_id`s (the forked copy,
  hyparam/hypaware#3056) is ambiguous. Nothing merges, and the ambiguity is
  counted.
- A fork copy that arrives **after** a merge makes the key ambiguous: the
  survivor carries no marker, so it counts as native. Nothing is undone, and
  nothing more merges.
- A call and its result never meet: `part_type` is in the key.
- Other sessions and other orgs never meet: the session and the org are in
  the key.
- A row only one lane captured has no pair, and is untouched.
- Each `tool_use` block has its own id, so two blocks of one multi-block
  message never share a key. Text and thinking rows have no tool id and are
  out of scope.

### The survivor {#survivor}

The survivor is built from the rows of one key. It keeps the `part_id`
every copy should have had, and each field comes from the copy that holds
it best.

**Identity, from the native row.** These are the fields
`assignTranscriptIdentity` copies from a transcript line, plus the
recomposed key:

- `message_id`, `provider_uuid`, `part_index`, the recomposed `part_id`;
- the thread links;
- `agent_id` and `is_sidechain`;
- the minimized frame.

**Content and timestamps, from the earliest copy.** That is the row with
the smallest `message_created_at`, native included, with ties going to a
live row. It supplies the content (tool input or result),
`message_created_at` and `date`.

- A replay's `message_created_at` is the replay's request time (`gapMessage`
  stamps the body event's timestamp), which is always later than the call.
  So a replay never replaces the original content, even when it is the only
  live row left. That happens when the original live row was already settled
  at flush.
- The earliest copy is the original either way: the body's copy or the
  transcript's.

**From the earliest live row:**

- `conversation_source`;
- the columns only the OTEL lane fills: `system_text`, `client_version`,
  `entrypoint`, `status`, and `model` on a result row;
- on the server, the stamped `gateway_id`. In a cross-machine pair, usage
  then stays with the host that captured it live, which is usually the
  carrier's host.

**Fallback provenance:** the marker and the match key are removed, as
`upgradeRow` does.

**Usage.**

- Today the carrier is whichever copy committed first (LLP 0559
  #usage-carrier). That is usually the live row; when the sweep committed
  first, it is the native row.
- The survivor carries exactly the usage the key's rows carried. When one
  row carried it, that copy moves onto the survivor.
- When more than one carried it (a client before LLP 0559, or two
  machines), the earliest live row's copy is kept and the others are
  discarded, never summed. These keys are counted, because they are the
  only ones whose token sums change (#hosted, verification).
- The token columns are re-derived from the result (LLP 0590).

**Every other row of the key is removed.**

### The local path: cache maintenance {#local}

The client cannot reconcile at flush. The flush path has no row delete (LLP
0027 point 4), and the copy that must go is often the committed one.

Maintenance already rewrites a whole source table's generation, every date
in it, when the table holds fallback rows (LLP 0027 #re-settle-sweep). It
does so in LLP 0301's two streaming passes. This doc extends both passes for
qualifying tool rows. Text and thinking rows, and tool rows with no native
twin, keep today's path exactly.

**Pass 1, the narrow identity pass.**

- Today it projects `attributes`, `part_id`, `message_id` and `part_index`,
  and records every native `part_id`.
- It now also projects `client_name`, `provider`, `session_id`,
  `tool_call_id` and `part_type`. For qualifying rows it records each native
  tool key's `part_id` (or marks the key ambiguous) and each live tool key's
  row count.
- When the pass ends, it keeps only the keys that have a live row and
  exactly one native `part_id`: the **claimed** keys.
- Memory during the pass is short strings per native Claude tool row. That
  is the same order as the native `part_id` set the pass already holds
  (O(native rows)), not O(pending fallbacks). After the pass it is
  O(claimed keys).

**Pass 2, the full-row rewrite.**

- A row whose key is claimed is **held**, native and live alike, instead of
  being emitted or put in the transcript batch.
- Once a key's native row and all its live rows (counted in pass 1) are
  held, the survivor is built, emitted, and the held rows are released.
- Identity and usage therefore come from the held rows themselves: no third
  pass, and no transcript.
- Held bytes are bounded by `compact_batch_bytes`, the cap LLP 0301 already
  applies to the fallback batch.
  - The cap is checked before a new key is admitted. A key already admitted
    completes, which mirrors LLP 0301's single-row exception.
  - A key not admitted is **deferred**. Its rows are emitted unchanged: the
    native row as it is, and the live rows still as fallbacks. They do not
    go to the transcript batch, whose de-twin would drop the carrier.
  - Deferred keys are counted. A rewrite that deferred any key does not
    record its new data-file count as the re-settle baseline. LLP 0027 point
    4's gate then sees a changed count and sweeps again on the next tick,
    rather than waiting for new data. A large backlog converges over several
    ticks.

**What does not change.** The transcript match, and its de-twin of non-tool
rows ("the native twin wins"), are unchanged. By the same reading of the
code, a text row that carried usage may be lost by that de-twin too. That is
not measured, and it is out of scope here.

**Both arrival orders converge.** Whichever copy committed first, the
generation then holds both, and the next re-settle merges them.

**Pairs on different dates are reached.** Mechanism 3 is covered locally,
because the rewrite spans the whole source table.

**Not reached:** a pair whose two rows have different `client_name` (one
`claude`, one `claude-desktop`). Those rows live in two source tables. Such
a pair has not been seen, and it is left and counted.

### The hosted path: ingest index and a bounded server pass {#hosted}

The server owner designs this in hypaware-server's own LLP. This section is
the contract that design needs.

**Options considered:**

| Option | Reaches | Cost | Verdict |
|---|---|---|---|
| Drop the later copy at ingest | new pairs only | one lookup per row | rejected: when the fallback came first it keeps the fallback's identity, against the acceptance criteria |
| Hide at query time | every pair | every reader must filter (#questions) | the owner's choice (#questions) |
| Ingest index plus a server pass that rewrites each pair | new and stored pairs, cross-machine pairs | O(batch) per ingest; a pair budget per tick | recommended, under the conditions in #questions |

**What the server needs, for either option:** **a key index beside the
part-id index.** Per org, it maps `(session_id, tool_call_id, part_type)`
to each `part_id` seen.

- Each entry is marked live or native, with its **location**: the cache
  tier (partitioned by received day) or the archive (partitioned by message
  day), and the partition.
- Only qualifying rows enter it.
- It persists and rebuilds as the part-id index does: an fsynced file after
  the spool append, and a background rebuild at boot (hypaware-server LLP
  0638 #background).
- When a key gains a second identity, the key is queued.

**What the rewrite also needs** (the four obligations the server design
cannot skip):

1. **A direct partition append for the survivor.** Its `part_id` is the
   native id, already in the part-id index, so ingest would accept it and
   drop it. The pass appends the survivor itself, as
   `src/repair/restore-rows.js` does.
2. **A durable per-key journal.**
   - Order: the survivor is appended before any copy is deleted, and each
     step is recorded.
   - A re-run of a journaled key is idempotent: it resumes where the journal
     stopped.
   - Rollback: an older server has no journal and no pass, and leaves each
     in-flight key as it was. A key stopped after the append and before the
     deletes shows three rows (two with the native `part_id`) until the new
     image returns. Deleting before appending is never allowed, because a
     crash there loses the call.
3. **The derived daily tables are rebuilt** for every (org, date) the pass
   touched: `session_summaries_daily` (`part_count`, `message_count`) and
   `usage_rollup_daily`.
   - `usage_rollup_daily.message_count` counts distinct `message_id`s of
     assistant rows per (org, date) (hypaware-server LLP 0683 #rows). A
     merged call pair has two (the 16-hex hash and the uuid), and the
     survivor has one. So that day's count drops by one per merged call
     pair. Results are user rows and do not count.
   - When the copies were on two dates (mechanism 3), both dates change.
   - Days already rolled up keep the old count until rebuilt. The usage
     rollup already has a per-(org, date) rebuild (`/v1/admin/usage-rollup/rebuild`,
     runbook `docs/runbooks/usage-rollup-rebuild.md`). The pass triggers the
     same rebuild for each touched date, and the session summaries'
     re-derivation likewise.
4. **Deletes scoped to the partition's files.** The purge's position-delete
   helper (`deleteMatchingRowsAtUrl`) scans every live data file of the
   table unless it is given `files`. The pass groups keys by archive
   partition, using the index's locations, and passes that partition's
   files. Otherwise each tick costs O(the org's table).

Also for the rewrite:

- **The part-id index keeps every superseded `part_id`.** A re-sent
  fallback or native copy from any client still drops at ingest. A replay
  of both inputs therefore leaves one row.
- **Pairs already stored.** A one-time discovery fills the key index from
  the archive. It goes one date partition per step, newest first, under a
  per-tick budget, and reads plain columns only (`session_id`,
  `tool_call_id`, `part_type`, `part_id`, `message_id`, `date`, `role`).
  - A 16-hex `message_id` is expected to mark the live side. That is to be
    checked against stored rows, with a count, before it is built.
  - The pass confirms the `attributes` marker before acting on any row.
- **A dry run counts candidate pairs per org** before any write. The
  report's 332 and 864 calls are the baseline.
- **Server tests pin the survivor** that the shared function returns. A
  later hypaware bump can then not change hosted merges silently.

**How corrected counts are verified,** per org and per date:

- **Tool rows** (`part_type` in `tool_call`, `tool_result`) equal the
  distinct `(session_id, tool_call_id, part_type)` count, plus, for each
  counted ambiguous key, its rows minus one.
- **Token sums** per column are unchanged, except for the counted keys where
  more than one row carried usage. Each of those lowers the sum by exactly
  the discarded copies' counts, which the pass records.
- **`message_count`** in `usage_rollup_daily` falls by the merged call pairs
  dated that day, once the day is rebuilt.
- **The report's two orgs** for 2026-11-16 to 2026-11-22 read 0 outside
  ambiguous keys after the pass.

**Versions.** No row shape on the wire changes, so the two sides do not
gate each other:

- **An older server with the new client** stores what it stores today: the
  pairs remain on the hosted path. The client change is local and never
  re-sends a row (LLP 0040).
- **The new server with older clients** works, because the rule reads only
  columns every client already sends.
- **The server image** builds with hypaware master. The exported function
  lands here first, and the server-suite gate applies to that PR.

### Durable formats {#formats}

**Client.** Nothing changes in these:

- the spool envelope;
- the cache schema or partition declaration;
- the generation or cursor format. `pendingFallbacks` keeps its meaning: the
  rewrite still resets it to the exact remainder, deferred keys included.

**Client maintenance output changes:** a merged key keeps one row, built by
#survivor, and usage moves onto it. LLP 0430 retired the manual
durable-cache upgrade procedure, and this doc does not revive it. The
validation is what LLP 0027 asks of the re-settle sweep:

- a second pass is a no-op;
- a row no rule claims is never dropped.

LLP 0301's bounded-memory verification extends to the held keys.
Traditional tests pin all of that over a generation written in today's
shape. A hermetic smoke asserts the SQL counts and token sums for the repro
session.

**Server.** The hosted side adds two durable files: the key index and the
pass journal. Both follow the part-id index's rules: fsync after the spool
append, a background rebuild, and a format an older image ignores. The
server's archive output changes under the rewrite option.

### CPU and memory {#cost}

- **Flush:** one counter increment per unresolved live row. No new reads.
- **Maintenance, pass 1:** five more plain columns in the narrow projection.
  It holds short key strings per native Claude tool row, the same order as
  the native `part_id` set it already holds, then O(claimed keys).
- **Maintenance, pass 2:** held rows bounded by `compact_batch_bytes`.
  Nothing grows with uptime. A table with no qualifying live rows pays only
  the wider narrow projection.
- **Queries:** no added work on either path under rewrite. Under hide,
  every hosted read pays the filter.
- **Server ingest:** one key and one index lookup per qualifying row,
  O(batch).
  - The key index grows with the distinct Claude tool parts per org. Each
    entry is at least as large as the same row's part-id entry. The part-id
    index's note on residual growth applies to both.
- **Server pass:** bounded per tick by a pair budget. Each delete is scoped
  to one partition's files. The history discovery is bounded per tick.

### Pull requests and order {#order}

1. **hypaware A.** The exported match and survivor function, with
   traditional tests for every case in #unambiguous and #survivor (a replay
   never replaces content; usage is kept once; ambiguity). Also the
   settle-miss counters. Server-suite gate.
2. **hypaware-server.** Its LLP against #hosted, then the ingest index, and
   under the owner's answer to question 1 the journaled pass and the
   discovery, or the filter. These need A on master.
3. **hypaware B.** The two maintenance passes, with the hermetic smoke.
   This needs only A, so it can run beside step 2.

## Questions {#questions}

### 1. Stored hosted pairs: rewrite or hide? (the owner's)

Published reports are frozen documents. Neither option changes them; only
regenerating a report does.

**Rewrite.** The pass deletes the copies and appends the survivor.

- What it gives: every hosted reader is right with no filter: SQL, MCP,
  reports, the Ask chat, the usage and session pages, and search.
- Conditions, all four required:
  1. a per-org dry run that counts the candidate pairs first;
  2. the per-key journal, with append before delete;
  3. the rebuilds of `session_summaries_daily` and `usage_rollup_daily` for
     every (org, date) touched;
  4. the restore window stated: deleted rows can be read back from earlier
     snapshots until archive reclamation (hypaware-server LLP 0437
     #archive-reclamation) reaches the table; after that, only an external
     backup or bucket versioning, where the deployment has one.
- What it costs: stored rows are deleted automatically, without a request.
  Whether the privacy, security and DPA pages need to say so is for the
  legal-page owner.

**Hide.** Rows stay. Every hosted reader of `ai_gateway_messages` filters
the superseded copies using the key index:

- SQL through /v1, including the MCP SQL tool;
- report generation (the evidence, activity-inventory and
  connected-evidence stages);
- the Ask chat transcript;
- the session-summary combine and the usage rollup;
- grep search;
- any future reader.

What it gives: fully reversible, and nothing is deleted.

What it costs:

- SQL users still see both rows unless the table name itself becomes a
  filtered view.
- One reader that forgets the filter double counts.
- Every hosted read pays the filter.

### 2. Pairs the local path does not reach

Settled by the orchestrator as leave and count, unless the review showed
otherwise. Since that answer, the code shows the local rewrite spans every
date of a source table, so date-split pairs (mechanism 3) are reached
locally. What is left is pairs split across source tables (`claude` and
`claude-desktop`), not seen so far, and deferred keys, which converge over
later ticks.
