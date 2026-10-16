# LLP 0501: Server inventory comparison and explicit missing-row sync

**Type:** RFC
**Status:** Draft
**Systems:** Sinks, CLI, Cache, Usage-Policy
**Date:** 2026-10-14
**Related:** LLP 0040, LLP 0305, LLP 0307, LLP 0345, LLP 0417

## Request

Introduce a command that compares retained local rows intended to sync with one
selected server and names dates and datasets that have gaps. Running it daily must not
run a full-history server query, count raw tables, replay history, or upload
rows. A daily schedule is outside this request.

@ref LLP 0040#watermark-contract: sync progress is a transport cursor, not inventory
@ref LLP 0345#central: historical replay is explicitly separate from checking
@ref LLP 0305#routing: use the same dataset forwarding eligibility as export

This request is independent of the open first-sync performance PRs, client
#2600 and server #1496. Their acknowledgements prove past delivery, not current
row availability. Neither those receipts nor the server's part-id dedup index
is an inventory suitable for this command.

## Proposed command {#command}

`hyp sync <instance> --check [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]`

Use the existing sink instance to select the destination and gateway identity,
and the matching server's existing read credential for inventory access. With
one capable configured destination, the instance may be omitted;
with several, require it and list their names. Reject combinations with
`--history`, `--yes`, and `--dry-run`, before any export path is entered.

Default to retained rows intended to sync to the selected server. The user
clarified this scope on 2026-10-14: pre-join history is backfilled when joining,
so joining is never a lower date boundary. Eligible pre-join history belongs
in the expected set, including when its initial upload has not completed.
Deliberately withheld rows do not count as gaps. A gap is called **not present
on this server**, not **data lost**; the check does not establish that a missing
row was ever delivered.

Current eligibility alone is not a record of past sync intent. In particular,
returning a client from local-only to sync does not itself authorize replay of
rows previously withheld under LLP 0345. Include that history when an explicit
replay makes it intended to sync. Reuse existing enrollment/backfill, policy,
and replay evidence; do not infer intent or successful delivery merely from a
watermark advancing. If existing state cannot establish the intended scope,
report that coverage as `unverified` rather than guessing inclusion or exclusion.

Dates are source dates, not upload dates. Use a dataset's existing date or
primary-timestamp semantics; an unresolvable date gets an explicit `undated`
bucket and is never dropped. Date filters exclude undated rows explicitly and
the result discloses their count.

Exit statuses:

- `0`: every row in the requested scope is covered by a completed comparison;
  no gaps were found. A completed empty scope is named as empty.
- `1`: a completed comparison found at least one gap. This says nothing about
  whether the row was ever sent.
- `2`: invalid invocation, unsupported destination/protocol/identity contract,
  unreadable state, stale or incomplete inventory, budget exhaustion, or ingest
  still pending. Results may include proven gaps, but the run is incomplete.

JSON must distinguish `complete`, `different`, `pending`, `excluded`, and
`unverified`; include selected destination, requested range, observed revision,
coverage, withheld-row count, and per-dataset/day results. No error, empty
response, absent summary, or unsupported dataset may turn into a zero count.

## What a match means {#meaning}

The check asks whether the server contains the local rows intended to sync, not whether
the server and this machine have identical histories. Extra remote rows are
normal: other gateways, longer server retention, and older local-only policy.

For `ai_gateway_messages`, use the existing `part_id` identity and compare a
set, across the authenticated organization. Replaying a row or receiving it
from a second gateway does not add a required copy. A match proves identity
coverage, not payload equality; the existing server dedup policy can retain a
different payload with the same identity. Missing or malformed identities must
be reported separately, never silently skipped.

For datasets without a stable dedup identity, a separate versioned comparison
contract is needed: compare a multiset of canonical exported row values, scoped
to the authenticated gateway. Canonicalization must use the existing schema,
normalize JSON and timestamp/int64 representations, distinguish meaningful
values, and undo only the documented server attribution rename. Schema skew,
unknown type semantics, and ambiguous stamp-name collisions are `unverified`.
Do not manufacture a universal row-id column. GitHub observations need their
existing versioned-observation equivalence, not an invented event-id rule.

Counts alone are insufficient. An equal-cardinality replacement must change
the fingerprint. A matching SHA-256 digest of a sorted, length-delimited key
sequence (including multiplicities where applicable) provides cryptographic
assurance, not a mathematical proof or a check of every stored payload byte.
The version and identity/canonicalization contract are inside the digest domain.

## Comparison protocol {#protocol}

Add an org-read-authenticated surface, scoped through the existing query/read
authorization. An ingest-only gateway credential must not acquire org-wide
inventory access as a side effect of this feature. Resolve the selected sink
to its matching remote read credential using existing URL/credential handling;
if absent, report the existing remote-login command. Organization is derived
from verified read claims. Gateway-specific comparison scope is checked against
the selected enrollment identity and the reader's existing authorization.
Reuse the established refresh flow. Never place credentials or row content in
the request body, and do not implement this as arbitrary SQL.

Partition the inventory by dataset, source day, comparison scope, and a prefix
of the SHA-256 row-key digest. The first request reads bounded pages of small
bucket summaries: distinct key count, required multiplicity count, fingerprint,
coverage, and an inventory revision. Missing local buckets are explicit empty
requests so an omitted server response cannot be interpreted as empty.

For each bucket:

1. Equal counts and fingerprints settle equal key multisets.
2. Different summaries do not prove a gap: the server may contain a strict
   superset. Reconcile only that bucket using sorted hash/count pages.
3. Merge the local and remote streams to find local keys with insufficient
   remote multiplicity. For AI identities, one remote occurrence is sufficient.
4. Persist a completed subset proof keyed by destination identity, protocol,
   local fingerprint, and remote revision/fingerprint. An unchanged day with
   legitimate server extras should not download its keys again tomorrow.

Every page must belong to one inventory revision. A revision change aborts that
comparison as `unverified`; never combine pages from before and after deletion.
Page limits, body limits, concurrency limits, and an operation deadline apply.
Budget exhaustion returns a continuation or incomplete coverage, never success.
Hash prefixes can split further when one bucket exceeds its admitted size.
Only mismatch buckets disclose row-key hashes; no row payloads are transferred.

## Local side {#local}

Read through the same privacy-aware storage seam used by central export,
including client opt-outs, directory policy, session fences, unattributed-row
rules, and dataset-level withholding. Never build summaries directly from raw
cache files and thereby bypass that seam. The check must not clear the first
sync hold, move export cursors, register datasets remotely, or send an ingest.
Apply the intended-sync scope above as well as these current privacy gates.
Pre-join dates remain in scope; a still-held first sync or unfinished backfill
is pending work, not evidence of server data loss.

A retained-history local scan is an explicit first implementation cost. Stream
it into bounded temporary hash buckets instead of retaining all rows or IDs in
memory. External sorting/merging provides sorted unique identities and counted
generic values. Snapshot and policy changes during the scan invalidate the
affected proof. The command can report completed unaffected buckets, but cannot
claim a globally stable scan when it has no stable source view.

No incremental local cache of privacy-filtered results may be reused solely
because its ingest watermark is unchanged: policy, purge, retention, compaction,
or canonicalization changes can change the eligible set without new rows.

## Server side {#server}

Server LLP 0610 owns maintenance, lifecycle, bootstrap, and the read endpoint.
The source of truth is the current logical cache/archive inventory, with pending
spool work disclosed separately. Summaries are rebuildable projections tied to
current storage state; acceptance ledgers are not their backing authority.

The existing per-file session index and bounded metadata cache are useful
precedents, but cannot themselves answer this check: postings contain sessions
and row-group locations, not row identities, and their missing-index fallback
reads raw files. The check's fallback must instead be `unverified`.

## Costs and boundaries {#costs}

Let B be requested summary buckets, F the relevant current file metadata,
Nnew rows in new or rewritten files, and K keys in changed mismatch buckets.

- Normal server check: O(B) summary IO plus bounded metadata freshness checks.
  No raw row decoding. An implementation that walks F every request must name
  that O(F) term and cannot advertise constant cost.
- Normal maintenance: read new/rewritten files, O(Nnew); changed delete masks
  invalidate their affected file summaries. Update only affected day buckets.
  Recombining those buckets can read their compact identity indexes and must
  account for that cost separately from raw-row IO.
- First indexing/backfill: O(retained server rows), once per source file and
  format version, with restartable checkpoints. This cost is not hidden in the
  first daily check. Until finished, covered and uncovered scope are explicit.
- Mismatch narrowing: O(K) compact hashes, no full-history raw query. A first
  comparison against a large server superset can be large; subsequent unchanged
  comparisons reuse the revision-bound subset proof.
- Client: initially O(retained eligible local rows), with bounded sort chunks,
  temporary disk proportional to local keys, and cleanup on success/failure.
- CPU and memory must have enforced limits, not merely streaming APIs. Include
  serialized/decoded buffer sizes, sort buffers, bucket maps, page queues,
  file-metadata residency, background work slices, and cache eviction in review.

No new runtime dependency, config system, or captured dataset column is part of
this request. The necessary sidecar/protocol version is a derived index format,
not a new recording schema.

## Implementation and validation gates {#gates}

1. Freeze identity/canonicalization vectors and the read protocol in paired
   tests. Include same count/different keys, reordered rows, duplicates, int64,
   timestamp and JSON normalization, schema skew, and missing identities.
2. Build the server index against current snapshots, with explicit completeness,
   then prove restart, torn checkpoint, late historical data, and corrupt index
   behavior. Prove a warm read opens zero raw data files.
3. Prove spool-only rows yield pending; duplicate ingest across gateways does not
   become a gap; cache/archive overlap does not double count; cache eviction
   retains coverage; purge and delete files invalidate every affected proof.
4. Add the read endpoint with tenant/auth tests, response and concurrency bounds,
   revision-pinned paging, cancellation, and old-server behavior.
5. Add the local comparison capability and `--check` path with privacy tests,
   scope completeness, exit-status tests, and a test that no ingest/export path
   is invoked. Add a hermetic end-to-end smoke with a stable run ID and assert
   both its report and structured telemetry.
   Cover pre-join history, unfinished join-time backfill, deliberate withholding,
   a return from local-only without replay, explicit history replay, and missing
   historical intent evidence. No test may use the join date as a scope cutoff.
6. Run both repositories' full tests and typechecks. Record a bounded synthetic
   benchmark separately for initial indexing, unchanged daily reads, new-day
   data, and historical backfill. Do not present it as a production measurement.

## Initial implementation, 2026-10-14 {#initial}

The initial implementation is deliberately narrower than the target design:

```sh
hyp sync central --check --dataset ai_gateway_messages --json
hyp sync central --check --dataset ai_gateway_messages --from 2026-10-01 --to 2026-10-14
```

Both the named sink and the dataset are required. The selected server must
have a matching configured read remote and a current inventory prepared by
its operator. Other datasets are explicitly unsupported. Exit 0 means matched
IDs in the stated scope, 1 means differences, and 2 means incomplete.

This version checks **currently retained, currently export-eligible local AI
rows**, using `readRowsSince` with the same privacy gates as export. Pre-join
dates are included without an enrollment cutoff. Historical intent and
unfinished backfill are not yet reconstructed. A difference is therefore an
absent ID in that event-day bucket, with a warning that backfill, purge,
differing event dates, or data loss can explain it. It is not a loss verdict.
Server purge classification and cross-day identity reconciliation remain open.

Local metadata, cursor readability, export policy, purge fences, and pending
spool state are checked around the comparison. A changed view is incomplete.
The first-sync hold is preserved. The command never exports or refreshes the
server. Only hashes and bucket names travel; the local proof cache stores at
most 1,000 content-bound subset proofs and is an optional optimization.

Instead of the proposed external sort, this first version admits at most
400,000 distinct local keys, 100,000 keys per bucket, 4,096 local partitions,
2,000,000 scanned rows, 512 HTTP requests, and 128,000 response bytes per request.
A budget refusal is incomplete. `--from`/`--to` reduce retained keys, but the
local scan still visits history to apply the privacy filters. There is no
incremental local inventory yet. Existing storage readers still determine
row-group decoding memory; the key cap is not a whole-process RSS guarantee.

Validation: hash vectors, replay deduplication, equal-count replacements,
server supersets and proof reuse, truncated pages, revision changes, exit
codes, incompatible flags, and a real-storage CLI fixture covering pre-join
history, private rows, pending spool, and absence of upload/refresh calls.
Both repositories' typechecks pass. The full client run passed 8,082 tests,
with four skipped and one timing-sensitive daemon test failing; that test
passed in isolation. The server run passed 381 tests, with two updater tests
failing on macOS because `/proc/meminfo` is unavailable; the failures also
reproduce on the unchanged baseline. Focused tests were rerun after final edits.

The broader lifecycle, scheduling, intent reconstruction, generic dataset,
and production performance gates above remain requirements for a daily
production feature. This initial slice does not claim those are complete.

## Missing-only sync foundation, 2026-10-15 {#missing}

The comparison can optionally return the exact missing hashes by day bucket,
alongside the pinned inventory revision. It returns a selection only after all
pages and the final revision check succeed. Ordinary checks do not retain or
serialize this selection. The selection reuses admitted local hashes and is
bounded by the existing local key and request budgets.

These are candidates, not upload authorization: a hash absent from one day can
be present under another day, and server purge fences still apply. The server
currently retains archived rows without a time limit (server LLP 0003);
configured retention evicts cached copies only after archive acknowledgement.
An accepted but truly absent row can therefore indicate storage loss, while
the persistent acceptance index can still reject its ordinary resend. A
missing-only uploader must resolve those cases before claiming repair success.

The user confirmed that repair should also restore rows previously accepted
but now genuinely missing. The initial explicit upload command is:

```sh
hyp sync central --missing --dataset ai_gateway_messages --dry-run
hyp sync central --missing --dataset ai_gateway_messages --yes
```

It reuses the comparison and current privacy gates, includes pre-join history,
and requires confirmation as an explicit history export. This authorizes the
selected currently eligible retained history, including rows normal cursors
already passed. It never releases the first-sync hold or changes those cursors.
`--missing` cannot combine with `--check` or `--history`. Date filters and JSON
reports are supported. A preview reports candidates, since purge and cross-day
classification happen on the server during the conditional upload.

One run admits at most 1,000 candidate identities and 4 MiB of serialized rows.
Larger selections refuse before sending; narrow the date range. The client
rereads selected payloads through the privacy-aware export reader after
confirmation and revalidates local snapshots, policy, purges, pending rows,
and the hold before every transport attempt. It verifies that the sink's
gateway identity belongs to the org established by the inventory read.

The optional sink capability sends one batch to the server's dedicated
missing-row endpoint. Ordinary transport authentication, bounded retries,
shutdown cancellation, and stable per-attempt batch identity are reused.
An old server's generic response cannot count as repair success. Server
LLP 0610 owns all-date presence checking, the acceptance-index exception,
purge exclusion, serialized admission, and fsynced acknowledgement.

Success reports restored, already-present, and purge-excluded counts. A
lost-ack retry can report that the batch was already accepted without claiming
the original counts. This is a durable ingest acknowledgement; materialization
still follows the ordinary mover. Subsequent inventory checks require the
mover to finish and an operator to refresh the projection. No daily schedule,
automatic refresh, or automatic multi-batch repair is enabled.

CPU and memory review: candidate membership uses sets, so the second local
scan does constant-time selection work per row. It retains at most one bounded
batch, not historical payloads. Initial comparison and storage row-group costs
remain as described above; 4 MiB is a wire budget, not a whole-process RSS cap.

Validation for this slice: 135 focused client tests passed, as did both
typechecks and the client declaration build. Six focused server tests passed,
including ordinary-ingest regression coverage, and a subsequent real
client-to-server roundtrip verified one missing public row was restored while
an existing row and a private row were not sent. The server test also covers
accepted-but-lost identities, cross-day presence, purge exclusion, concurrent
normal ingestion, and acknowledged retry after daemon restart. Compact-index
tests assert no raw reads and the structured restoration signal.

Full runs executed 8,090 client tests and 386 server tests. Client results were
8,082 passed, four skipped, and four failures: three timing-sensitive process
assertions passed in isolation, and a newly occupied LLP number was corrected
using the refreshed cross-branch allocator. Server results were 382 passed
and four failures: graph and usage-rollup timing assertions passed in isolation;
the two Linux `/proc/meminfo` updater failures remain the previously reproduced
macOS baseline limitation. Both design documents were renumbered to avoid
newly claimed numbers, and both cross-branch checks now pass.
