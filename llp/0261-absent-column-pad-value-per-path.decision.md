# LLP 0261: The gateway's absent-column pad value is per read path, not "null"

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Sources
**Author:** Phil / Claude
**Date:** 2026-08-18
**Related:** LLP 0015, LLP 0055, LLP 0241
**Extends:** LLP 0032 (#capture: the parenthetical "padding absent physical
columns to null" holds only on the column-stream path; the row path pads with
a cell that reads `undefined`)
**Extended by:** LLP 0294 (prepared batches are disabled across schema drift,
so this document's row and column-stream values remain authoritative)

> Corrects one sentence of [LLP 0032 §Capture](./0032-github-llm-graph-bridge.decision.md#capture)
> without changing what it decided. The guarantee 0032 needed, a
> declared-but-physically-absent column stays addressable and never throws,
> holds on both read paths. The **value** such a read yields is not one thing:
> `null` on the column stream, `undefined` on the row path. This document
> records what each path does and the evidence; it deliberately does **not**
> settle whether the two values should collapse into one.

## Context

<a id="compression"></a>

### What 0032's sentence compresses

LLP 0032 §Capture says the gateway data source "exposes its **declared**
schema columns (padding absent physical columns to null)". The load-bearing
half is correct and unchanged: `withSchemaColumns` in
`hypaware-core/plugins-workspace/ai-gateway/src/dataset.js` advertises the
dataset's declared schema over partitions that predate part of it, so a
contract or query naming a new column does not throw `ColumnNotFoundError`
over a pre-v7 partition. That is all 0032's design (additive nullable columns,
no partition-label bump, no cache wipe) actually depends on.

The parenthetical "to null" is the compression. It states one pad value where
the tree has two, one per read path. It is the same compression LLP 0015's
"Multi-partition union" section once carried ("reads as null, never throws",
corrected in #731 / PR #740) and that PR #821 uncompressed again after LLP
0241; after those corrections, this sentence in 0032 was the last remaining
prose asserting the two paths read the same value (issue #823 item 1).

## What each path actually does

<a id="column-stream"></a>

### Column-stream path: `null`, by normalization

`withSchemaColumns` forwards the `scanColumn` hook so single-column
aggregates stay on the engine's streaming fast path. A partition that
physically lacks the requested column surfaces its values as `undefined`
holes in the chunk, and the wrapper rewrites them to `null` before yielding
(`wrapped.scanColumn` in
`hypaware-core/plugins-workspace/ai-gateway/src/dataset.js`, the
`chunk[i] === undefined` rewrite). Pinned by
`test/core/ai-gateway-dataset.test.js` ("streams scanColumn with nulls for a
physically absent column"), which asserts `strictEqual(v, null)` per value:
"absent column streams null, not undefined". Here 0032's "pads to null" is
literally true.

<a id="row-path"></a>

### Row path: `undefined`, by padded cell

Post [LLP 0241 §alignment](./0241-scan-rows-carry-advertised-columns.decision.md#alignment),
a scan's rows carry the column list the scan advertised, and a column the
partition does not physically hold gets a **padded cell**: `absentCell` in
`src/core/query/union-source.js` resolves to `undefined`, and the row's
`resolved` map is left alone, so the padded column is absent from it. A
projection of that column answers `undefined` (dropped by `JSON.stringify`),
not `null`, and `IS NULL` filtering works because the engine evaluates SQL
null semantics over the `undefined` it reads. LLP 0241 chose `undefined`
deliberately, as the same value the engine already read for a
declared-but-absent column on the row path pre-alignment (measured in issue
#778), so that no query that already returned a value changed its answer.
Pinned by `test/core/star-expansion-drifted-union.test.js` and
`test/core/union-source.test.js`. Here 0032's "pads to null" is false.

The `withSchemaColumns` doc comment already states the honest form:
"the exact value a read of it yields depends on the read path (LLP
0015#multi-partition-union)", as does LLP 0015 itself after PR #740's
correction. This document brings 0032's prose in line with both.

## Decision

Read LLP 0032 §Capture's parenthetical as: *padding absent physical columns
so they stay addressable and never throw; the value a read yields depends on
the read path*, per this document. Nothing 0032 decided changes: the columns
are nullable, additive, and queryable over old partitions either way, and no
runtime behavior moves. 0032 is `Active`, so the correction lands as this
extending document plus a forward-ref on 0032's header, not an in-place
rewrite.

<a id="split-not-settled"></a>

## Not settled here: the `null`/`undefined` split

Whether the column-stream path (`null` after normalization) and the row path
(`undefined` padded cell) should collapse to one value remains an **open
design question**. [LLP 0241](./0241-scan-rows-carry-advertised-columns.decision.md#the-padded-cell-reads-undefined-and-this-decides-nothing-new)
explicitly declined to settle it ("Whether that split should be collapsed
remains an open design question, not settled here"), and issue #823 item 5
records it as open. Consumers must not branch on which of the two values they
read (the `scanColumn` comment in the ai-gateway dataset forbids exactly
that). Settling the split needs its own deliberate LLP; this document only
stops the last remaining prose from asserting the split does not exist.
