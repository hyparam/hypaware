# LLP 0597: Consume query output inside its execution scope

**Type:** Spec
**Status:** Draft
**Systems:** Query
**Date:** 2026-11-11
**Related:** LLP 0015, LLP 0056, LLP 0097, LLP 0105

Extends [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md):
execution-budget exhaustion still refuses the query, but a caller may stop
consuming a correct output prefix without collecting the complete output.
This is output truncation, never truncation of an aggregate's input.

## Lifecycle

`streamQuerySql` is an async generator of result batches. Each batch carries
columns, rows, datasets, freshness notices, and the shared visibility report;
even an empty query yields one batch so metadata is not lost. `executeQuerySql`
collects this iterator into its existing result shape. SHOW TABLES uses the
same interface.

The iterator owns the heap guard, cancellation linkage, and query span until
exhaustion or closure. A for-await break or consumer exception closes it;
manual consumers must call return in finally. An abandoned iterator is not
auto-closed. No work starts before the first pull. The span context is restored
on each iterator operation without leaking into the consumer. Cancellation
and the terminal heap check run on early closure as well as exhaustion, before
success is recorded. Visibility counts remain live through consumption.

Output policy belongs to the caller, including byte encoding and truncation
metadata. The kernel does not impose server caps on local queries or internal
jobs. Visibility filtering still happens upstream and its counts describe
only rows actually scanned, as they already do for SQL LIMIT.

Squirreling's streamRowBatches preserves native column batches and resolves
fallback cells concurrently within bounded chunks. Chunk size bounds adapter
output, not Parquet pages, giant values, or blocking operator state. Consumers
must await downstream work instead of accumulating the chunks themselves.

## Validation

Regression checks cover early source closure, manually pulled iterators,
consumer failures, upstream abort, complete results through the collecting API,
SHOW TABLES, and terminal memory refusal. Existing visibility and budget
checks remain required. Server output policy is specified in its LLP 0701.

## Delivery

Ship a Squirreling release containing streamRowBatches before updating the
HypAware dependency pin. Local cross-repository verification uses linked
checkouts; it does not establish that the currently pinned npm version has
this export. No JSONL export or wire-streaming contract is introduced here.
