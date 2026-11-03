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
0566, the same as a row with no file verdict. The over-budget column walk of
LLP 0568 #irreversible follows the same rule.

The row redactor is shared by the record and export seams, so the rule holds
on both.

Timestamps are kept because masking them whole wrote `'[REDACTED]'` into a
TIMESTAMP column, which the cache refuses, so the spool file holding the row
could not commit.

## Cost {#cost}

The skip removes one redaction pass per row on the server's cache writes. The
narrower mask replaces fewer columns per masked row. Neither adds state.
