# LLP 0568: Built-in secret rules run when content is recorded

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Sinks, Privacy
**Date:** 2026-11-02
**Related:** LLP 0503, LLP 0566, LLP 0027

Extends [LLP 0503](0503-export-content-redaction.decision.md) (#export-seam:
stored cache contents and local queries no longer keep what the built-ins
match) and [LLP 0566](0566-shared-secret-rules-and-entropy-heuristic.decision.md)
(#shared-rules: the record path is the second caller that LLP named).

## The write seam {#seam}

The built-in rules of LLP 0566 run on every row before it is persisted, in
`src/core/cache/storage.js`. Every cache write already passes through it:

- `appendRows`, before the row reaches the spool;
- `appendRowsToPartition`, `reconcileRows` and `reconcileRowsBatch`, before
  the commit;
- the flush-time settle hook, on what it returns, because a settlement
  enricher can rebuild a row from the source transcript;
- the compaction re-settle (LLP 0027), on the rows the hook upgraded.

Rows a step already redacted are passed through by identity, so each row is
scanned once per write. Rows are redacted with the export row redactor of LLP
0503 in a record mode, so top-level identities, provenance columns and
numeric usage are kept verbatim and dedupe keys stay stable. The redaction is
synchronous: rows reach the spool in the order they were appended, and a tool
call is seen before its result in the same order the capture produced them.

Export redaction is unchanged and still runs on every exported row, so rows
recorded before this change, and anything a later rule adds, are still masked
on the way out.

## Default {#default}

It is on by default and there is no opt-out. LLP 0503 #config has only
`redaction.custom_patterns` and settled that there is no disable switch; no
key is added here. Rows recorded before the change are not rewritten. `hyp
privacy purge` remains the way to remove them.

## Masking cannot be undone {#irreversible}

An export mask hides a value from one copy; the local cache still holds it. A
record-time mask is the only copy HypAware has. A false positive is lost to
HypAware, recoverable only from the client's own transcript where one exists.
That is why the LLP 0566 heuristic keeps its conservative thresholds, and why
record mode departs from export mode in three places:

- **Unknown-path reads are kept.** Export masks a named file read whose path it
  cannot establish. At record time the call may have been recorded by another
  process or an earlier run, so the read is kept. A read whose call named a
  sensitive file is still masked, including when the call was recorded in an
  earlier batch: the redactor lives as long as the storage service and keeps
  its bounded call verdicts across writes.
- **Over-budget rows are written.** Export refuses a row past the traversal
  budget. Refusing at record time would lose the row, so each top-level string
  gets the text rules once, a hidden file's content and a credential key's
  value are masked, and a nested value the walk could not finish is dropped.
  `cache.record_redaction_over_budget` is logged with the dataset and count.
- **Custom patterns stay export-only.** They are organization rules for what
  leaves the host, and LLP 0503 #custom-regex runs them in a worker with a
  deadline. They are not applied to the local cache.

## Out of scope {#out-of-scope}

Files HypAware does not write with this seam keep their content: the Claude
raw-body spool (written by Claude Code, read and deleted by HypAware), the
LangGraph outbox (written in the user's application process), and the Claude
session-context file (session ids and directories, no content). What
HypAware records from the first two goes through the seam.

## Cost {#cost}

The work runs where rows are written: in the daemon's processing child for
live capture and sweeps, at below-normal priority, and in the CLI process for
a manual backfill. The gateway process does none of it.

One pass per content value, linear in its length. A row with nothing to mask
is returned as is, and a batch with nothing to mask as the same array, so the
common case allocates no copy. The only state is at most 4096 call verdicts
per storage service, holding a key and a boolean, so nothing grows with
transcript length or uptime. Measured per row on an 8-CPU seat, one content
string of real prose and code:

| size | nothing masked | one secret |
|---|---|---|
| 1,000 chars | 6 us | 6 us |
| 16,000 chars | 87 us | 95 us |
| 1,048,576 chars | 6.8 ms | 8.0 ms |
| 8,388,608 chars | 45 ms | 50 ms |
