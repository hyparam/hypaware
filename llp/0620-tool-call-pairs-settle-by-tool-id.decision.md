# LLP 0620: A Claude tool call both lanes recorded settles to one row by its tool id

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Sources, Cache, Plugins
**Author:** HypForge steward
**Date:** 2026-11-23
**Related:** LLP 0027 (#re-settle-sweep), LLP 0040 (#watermark-contract),
LLP 0252 (#projection-unchanged), LLP 0301, LLP 0389 (#match-key-on-bodies),
LLP 0390, LLP 0435 (#tool-id-first), LLP 0559 (#usage-carrier), LLP 0590;
hypaware-server LLP 0001 (#idempotency-key) and LLP 0152 (#org-scope)

## Summary

A Claude tool call can be stored twice: once by the OTEL lane, under a
fallback hash, and once by the transcript sweep, under the transcript
line's uuid. The flush-time lookup that should join them (LLP 0389, LLP
0435) missed. Both rows carry the same `tool_call_id`. Their `part_id`s
differ, so neither the client's dedupe nor the server's ingest index can
see that they are the same call.

This doc settles what should happen once that lookup has missed:

- **The match.** Two rows are the same call when they share the session,
  the `tool_call_id` and the part kind (call or result). Exactly one native
  row must hold that key.
- **The survivor.** The result is the row flush settlement would have
  written had the lookup hit: the live row under the native identity. It
  keeps the response's usage, whichever copy carried it.
- **The local path.** Cache maintenance reconciles, as a second matcher
  after the transcript in the re-settle sweep.
- **The hosted path.** Server ingest records the key, and a bounded server
  pass rewrites each pair. The same pass works through pairs already
  stored.

The match and the survivor rule are one exported function in this repo,
which the server imports.

## Evidence {#evidence}

### The pair reproduces through the real code {#repro}

Built from the fixtures in `test/plugins/claude-otel-body-overlap.test.js`:
one `[tool_use]` response, one `tool_result`, and the real projection,
settlement and backfill code. The transcript is hidden at the OTEL
flush, then restored before the sweep runs.

1. **The OTEL flush.** The tool call commits as `3a39d0e53ae68dc0#0` and
   its result as `1b6f9cb7fc436b47#0`, both still fallbacks. The call row
   carries the response's usage (`input_tokens` 12, `output_tokens` 34).
2. **The sweep flush,** with those rows committed. It writes
   `5233b3fa-...#0` and `77ea6f90-...#0`. `dedupeSweepRows` compares
   `part_id` only, so nothing drops. The committed-carrier check (LLP 0559
   #usage-carrier) finds the fallback holding this response's usage, under
   the same session and request id. It strips `usage` from the native call
   row.
3. **The re-settle hook,** transcript now present. It upgrades both fallback
   rows to the native `part_id`s.

So, from code at 07cdafd3:

| Where | Tool rows for the call | Usage for the response |
|---|---|---|
| Local cache, before maintenance | 2 (fallback and native) | once, on the fallback |
| Local cache, after the re-settle sweep | 1, the native copy | **none**: `resettleFallbackRows` drops the upgraded live row ("the native twin wins") and with it the only carrier |
| Hosted archive | 2, for good | once, on the fallback |

The hosted copy cannot heal from the client. A row's `_hyp_ingest_seq` is
row-resident and survives every rewrite (LLP 0040), so the forward sink
never re-sends a row the re-settle sweep upgraded. The server keeps the
fallback it was first sent. It also keeps the sweep's native copy when that
was forwarded first, and its part-id index (hypaware-server LLP 0152) accepts both.

The usage loss in the second line is local and new to this doc. It has the
same root as the duplicate, and the survivor rule below fixes both.

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
3. **A replay after a restart.** Every `api_request_body` carries the whole
   history. The writer's guard against re-projecting it is process memory
   (`seenMessages`, not seeded on this lane), and the pre-write check looks
   for fallback `part_id`s that flush settlement has since renamed. So after
   a daemon restart, the first request body re-emits every earlier tool
   block as a fresh fallback row. Its `message_created_at`, and so its
   `date`, is the replay's. A miss here leaves the pair in two date
   partitions, out of reach of the single-partition re-settle sweep.
4. **A multi-block line.** For example a user line `[tool_result, text]`.
   `findOtelToolMatch` accepts single-block lines only. On one HypForge
   host's transcripts this was 14 lines in about 25,000 tool results.
5. **A server tool's result.** A `web_search_tool_result` block has the
   assistant role, and neither arm of `findOtelToolMatch` takes it.

A related shape is not this doc's. A forked subagent's transcript copies
the parent's tool lines under new uuids. The sweep then stores the call
twice, **both rows native**: one HypForge host has 14 such tool parts in one
session. The index's last-write-wins map hands either copy to a lookup. This
doc treats such a key as ambiguous (#unambiguous) and leaves it alone.

**What would name the cause.** Each hosted pair already holds the evidence:

- whether the two rows' `gateway_id` match (mechanism 2);
- the gap between their `message_created_at`: seconds for mechanism 1,
  minutes to days for mechanism 3;
- whether their `date`s differ;
- their part kind and role (mechanism 5).

That read needs server data access, so it is an operator's (#questions).
Meanwhile the client gains a counter for each settle miss, by reason (no
transcript entries, no line for the tool id, a multi-block line, a kind
neither arm takes). The next field report then names its own cause.

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
org from the verified claim (hypaware-server LLP 0152 #org-scope). Locally the cache is the
org.

- A row is the **live** side when it carries the existing fallback marker,
  `attributes.gateway.identity_source = 'gateway_fallback'`. Its
  `message_id` is the 16-hex fallback hash.
- It is the **native** side when it carries no marker. Its `message_id` is
  the transcript uuid.

No column, attribute or config key is added. Every input is already stored
by every client version that writes these rows.

### Only an unambiguous key merges {#unambiguous}

- A key merges only when it has **exactly one native `part_id`**. Any
  number of live rows may match it: a replay whose tool result Claude Code
  cleared makes a second fallback hash for the same call.
- A key with two or more native `part_id`s (the forked copy above) is
  ambiguous. Nothing merges, and the ambiguity is counted.
- A call and its result never meet: `part_type` is in the key.
- Other sessions and other orgs never meet: the session and the org are in
  the key.
- A row only one lane captured has no pair, and is untouched.
- Each `tool_use` block has its own id, so two blocks of one multi-block
  message never share a key. Text and thinking rows have no tool id and
  are out of scope.

### The survivor {#survivor}

**The survivor is the row flush settlement would have written had the
lookup hit: the live row, with the native row's identity.** That is the
same outcome LLP 0252 #projection-unchanged and hyparam/hypaware#2879 already reach when the
two lanes agree on a `part_id`: the live copy is kept.

- **Identity, from the native row:** `message_id`, `provider_uuid`,
  `part_index`, the recomposed `part_id`, the thread links, `agent_id` and
  `is_sidechain`, and the minimized frame. These are the fields
  `assignTranscriptIdentity` copies from a transcript line.
- **Kept from the live row:**
  - its content (the body's full tool input or result);
  - `conversation_source`;
  - the columns only the OTEL lane fills: `system_text`, `client_version`,
    `entrypoint`, `status`, and `model` on a result row.
- **Fallback provenance:** the marker and the match key are removed, as
  `upgradeRow` does.
- **Usage:** the survivor carries the pair's usage once.
  - Today the carrier is the first of the two to commit (LLP 0559
    #usage-carrier). That is usually the live row. When the sweep committed
    first, it is the native row.
  - After the merge, the survivor holds whichever copy carried it.
  - When both carried it (a client before LLP 0559, or two machines), the
    live row's copy is kept and the other is discarded, never summed.
  - The token columns are re-derived from the result (LLP 0590).
- **The other copies:** every other row of the key is removed.

### The local path: cache maintenance {#local}

The client cannot reconcile at flush. The flush path has no row delete (LLP
0027 point 4), and the copy that must go is often the committed one.
Maintenance already rewrites a partition holding fallback rows (LLP 0027
#re-settle-sweep, LLP 0301), so the reconciliation goes there:

1. The transcript upgrade runs first, unchanged.
2. A live tool row it leaves unresolved is matched by its key against the
   native rows of the same partition. The narrow identity pass (LLP 0301)
   reads `session_id`, `tool_call_id` and `part_type` alongside the identity
   columns it already reads. It keeps only the keys that this partition's
   pending live rows ask for, so memory is O(pending fallbacks), not
   O(partition).
3. Upgraded live rows are emitted before the native stream. A native row
   whose `part_id` a survivor claimed is not emitted. Only that ordering lets
   the live row win without holding the native stream in memory.
4. The existing transcript-matched de-twin follows the same survivor rule.
   It no longer drops the carrier, which fixes the usage loss in
   #evidence. LLP 0027 is Draft. Its point 3 ("the native twin wins") and
   its safety line ("a row whose identity did not change is never dropped")
   are narrowed in the same PR: a native row is dropped only when a live
   row has taken its identity. The identity survives and only the copy
   goes.

**Both arrival orders converge.** Whichever copy committed first, the
partition then holds both, so the next re-settle sweep merges them. The
sweep copy's flush adds data files, which moves the re-settle baseline and
triggers that sweep.

**Not reached:** a pair split across date partitions (mechanism 3). The
local path leaves it and counts it. Whether to add a session-scoped lookup
across partitions is a question below, best decided from the miss counters.

### The hosted path: ingest index and a bounded server pass {#hosted}

The server owner designs this in hypaware-server's own LLP. This section is
the contract that design needs.

**Options considered:**

| Option | Reaches | Cost | Verdict |
|---|---|---|---|
| Drop the later copy at ingest | new pairs only | one lookup per row | rejected: when the fallback came first it keeps the fallback's identity, against the acceptance criteria |
| Hide at query time | every pair | an anti-join per session on every query; every query surface (SQL, reports, MCP, summaries) must apply it | rejected: hosted SQL is open-ended, and one path that forgets it double counts |
| Ingest index plus a server pass that rewrites each pair | new and stored pairs, cross-machine pairs | O(batch) per ingest; a pair budget per tick | **chosen** |

**What the server needs:**

1. **A key index beside the part-id index.** Per org, it maps
   `(session_id, tool_call_id, part_type)` to the `part_id`s seen, each
   marked live or native, with its `date`. Ingest computes the key for each
   qualifying row (O(batch)). When a key gains a second identity, the key is
   queued.
2. **A merge pass.** A bounded pass reads each queued key's rows, scoped by
   org, session and date. It calls the shared function for the survivor,
   writes the survivor, and deletes the other copies. The deletes use the
   same position-delete machinery the privacy purge uses. Between ingest and
   the pass, a pair counts twice; the window is the pass interval.
3. **The part-id index keeps every superseded `part_id`.** A re-sent
   fallback or native copy from any client still drops at ingest. A replay
   of both inputs therefore leaves one row. The survivor's `part_id` is the
   native one, already recorded.
4. **Pairs already stored.** A one-time discovery fills the key index from
   the archive. It goes one date partition per step, newest first, under a
   per-tick budget, and reads plain columns only (`session_id`,
   `tool_call_id`, `part_type`, `part_id`, `message_id`, `date`). A 16-hex
   `message_id` marks the live side without parsing `attributes`, and the
   merge pass confirms the marker before acting. Discovered pairs go
   through the same merge pass.

**How corrected counts are verified**, per org and per date:

- The tool rows (`part_type` in `tool_call`, `tool_result`) equal the
  distinct `(session_id, tool_call_id, part_type)` count, plus the counted
  ambiguous keys.
- The sums of each token column are **unchanged** by the pass, since a merge
  moves usage and never adds or drops it.
- The report's two orgs for 2026-11-16 to 2026-11-22 (332 and 864 calls
  stored twice) are the baseline. After the pass, both read 0 outside
  ambiguous keys.

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

Nothing changes in these:

- the spool envelope;
- the cache schema or partition declaration;
- the generation or cursor format. `pendingFallbacks` keeps its meaning:
  the rewrite still resets it to the exact remainder.

**Maintenance output changes:** which row of a pair survives, where usage
lands, and that a claimed native copy is dropped. LLP 0430 retired the
manual durable-cache upgrade procedure, and this doc does not revive it.
The validation is what LLP 0027 asks of the re-settle sweep:

- a second pass is a no-op;
- a row no rule claims is never dropped.

Traditional tests pin both, over a partition written in today's shape. A
hermetic smoke asserts the SQL counts and token sums for the repro session.

### CPU and memory {#cost}

- **Flush:** one counter increment per unresolved live row. No new reads.
- **Maintenance:** only partitions with pending live tool rows pay.
  - The narrow pass reads three more plain columns and keeps the keys the
    pending rows asked for: O(pending fallbacks).
  - The claimed-`part_id` set is the same size.
  - Nothing grows with uptime. A partition with no pending fallbacks reads
    nothing new.
- **Queries:** no added work on either path.
- **Server ingest:** one key and one index lookup per qualifying row,
  O(batch).
  - The key index grows with the distinct tool parts per org, the same order
    as the part-id index. The part-id index's note on residual growth
    applies to both.
  - The merge pass and the history discovery are bounded per tick.

### Pull requests and order {#order}

1. **hypaware A.** The exported match and survivor function, with
   traditional tests for every case in #unambiguous and #survivor. Also the
   settle-miss counters. Server-suite gate.
2. **hypaware-server.** Its LLP against #hosted, then the ingest index, the
   merge pass and the history discovery. These need A on master.
3. **hypaware B.** The maintenance matcher, the survivor rule in the
   de-twin, and the LLP 0027 narrowing, with the hermetic smoke. This needs
   only A, so it can run beside step 2.

## Questions {#questions}

1. **Stored hosted pairs: rewrite or hide?**
   - Rewrite (chosen above): permanent, and every query path is right.
     Rows are deleted, so it is not reversible except by restore.
   - Hide: reversible. But every hosted query path must filter, and SQL
     users still see both rows.
2. **Pairs split across date partitions on the local path.**
   - Leave and count (chosen above): no added I/O.
   - A session-scoped lookup into other partitions: more reads per sweep.
3. **An operator read of the hosted pairs** (`gateway_id` equality, the
   time gap, the dates) would name the field cause. It does not block this
   design.
4. **The forked-subagent copy** (both rows native) is a separate defect with
   the same symptom. Track it on its own, or leave it?
