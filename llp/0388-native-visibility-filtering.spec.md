# LLP 0388: Native batches for SQL visibility withholding

**Type:** Spec
**Status:** Draft
**Systems:** Query, Usage-Policy
**Date:** 2026-09-07
**Related:** LLP 0105, LLP 0294

## Scope

Extend LLP 0294's visibility row fallback for schema-aligned sources with
`cwd` and no declared content columns. The visibility rule from LLP 0105 is
unchanged. Sources requiring content suppression, schema drift, and
prepared-only sources retain their existing row fallback or refusal.

## Batch filter {#batch-filter}

The visibility wrapper requests `cwd` as a required column even when SQL
does not select it. Each batch resolves provenance before yielding anything,
uses the shared usage-policy resolver, and selects only rows whose class
does not outrank the caller. Missing provenance continues to pass through
on these withholding-only datasets. Resolver failures propagate.

Selection composes with the source's existing row selection, including
position deletes. Output columns retain their base row domain and deferred
reads address the original batch, so withholding cannot misalign values.
The extra provenance column is absent from the returned schema and columns
unless requested. Abort checks run between batches and during filtering.

Source WHERE negotiation is preserved because these sources do not suppress
content. LIMIT/OFFSET remain residual work after visibility and SQL filtering.
Neither `numRows` nor prepared `exactRows` is forwarded: COUNT must count the
visible rows. A source's `maxRows` remains a valid upper bound.

## CPU and memory

No per-row AsyncRow objects, cell promises, or object copies are introduced.
Only provenance is read eagerly; output columns stay deferred. A batch with
no withheld rows allocates no selection array. A batch with withheld rows
uses Uint32Array selection storage bounded by that batch's selected row count,
including composition with an existing selection. No new
query-wide or process-lifetime policy cache is introduced.

Content suppression and predicate-specific improvements remain outside this
change. They require separate proof that predicates cannot reveal suppressed
values through row presence.
