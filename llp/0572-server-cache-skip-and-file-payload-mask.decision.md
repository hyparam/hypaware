# LLP 0572: The server cache skips record-time redaction, and a file mask covers the payload

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Sinks, Privacy
**Author:** Kenny / HypForge
**Date:** 2026-11-03
**Related:** LLP 0568, LLP 0503, LLP 0566

Extends [LLP 0568](0568-record-time-secret-redaction.decision.md) (#default:
record-time redaction gains one kernel option that turns it off, used by the
server cache, and a sensitive-file verdict masks the file's payload columns
rather than the whole row).

## The server cache skips the record pass {#server-skip}

`createQueryStorageService` in `src/core/cache/storage.js` takes
`recordRedaction`, default `true`. `createKernelRuntime` passes it through
when a caller sets it to `false`. With it off, the record pass of LLP 0568
#seam returns each batch unchanged.

The server cache sets it off. The rows it stores arrive from clients, and the
client redacts each row when it records it (LLP 0568), so the server does not
run the same rules a second time. The option is not gated on the client's
version.

This is a kernel API option, not a config key. LLP 0503 #config still has no
disable switch, and a client install has no way to turn the record pass off.
Export redaction (LLP 0503 #export-seam) is unchanged and still runs on every
exported row.

## A sensitive-file verdict masks the payload {#file-mask}

When a row names a known sensitive file (LLP 0503 #export-seam), the mask
covers three top-level columns: `content_text`, `tool_args` and `raw_frame`.
`tool_args` keeps its path keys, as before. Every other column (timestamps,
branch, versions, `attributes` and the rest) gets only the text rules of LLP
0566, the same as a row with no file verdict. At record time a date column
gets none of them (#spool-repair). The over-budget column walk of LLP 0568
#irreversible follows the same rule.

The row redactor is shared by the record and export seams, so the rule holds
on both.

Timestamps are kept because masking them whole wrote `'[REDACTED]'` into a
TIMESTAMP column, which the cache refuses, so the spool file holding the row
could not commit.

## A date is never redacted, and v1.48.0 masked dates are rebuilt {#spool-repair}

At record time a TIMESTAMP column is exempt by its type. The record pass hands
the redactor the dataset's TIMESTAMP column names, and the redactor keeps those
columns verbatim, past the text rules of LLP 0566 and past the file mask. A
text rule that happens to match a date's value cannot write the mask into it.

v1.48.0 masked the whole row on a file verdict, so its spool files can hold
`'[REDACTED]'` in a TIMESTAMP column. Those files would never commit. When a
spool chunk is flushed, before the settle hook runs, each such value is
rebuilt from another row of the same conversation (same `session_id` and
`conversation_id`) in that chunk: the same `message_id` first, else the row
nearest by `message_index` (by position when it has none). A rebuilt value
is a sibling's value, not the original one.

A row whose masked date cannot be rebuilt is dropped. A date is never set to
null. The flush counts rebuilt values (`reconstructed_count`) and dropped
rows (`dropped_count`) and logs them as `cache.record_redaction_unstorable`.
A masked value in any other typed column is set to null when the column is
nullable (`nulled_count`), else the row is dropped.

Donors come only from the chunk being flushed, so a conversation whose other
rows were committed earlier, or sit in another chunk, cannot donate. That
keeps the repair bounded to the chunk.

Kenny chose this repair on 2026-11-03: rebuilt values are acceptable, a row is
dropped only when it cannot be rebuilt, and date columns are never redacted.

## Cost {#cost}

The skip removes one redaction pass per row on the server's cache writes. The
narrower mask replaces fewer columns per masked row. Neither adds state.

The spool repair first checks each row's typed columns for the mask and
returns the chunk unchanged when none holds it. Otherwise it builds, per
masked date column, a sorted index of the chunk's donors (O(n log n)) and
finds each row's donor by a lookup and a binary search. The index lives only
for that flush.
