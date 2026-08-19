# LLP 0294: Native prepared batches survive the query source stack

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache, Sources
**Author:** Kenny / Codex
**Date:** 2026-08-18
**Related:** LLP 0015, LLP 0055, LLP 0097, LLP 0098, LLP 0105, LLP 0241, LLP 0261

> Squirreling 0.16.1 and Icebird 0.8.23 add schema-addressed native batch
> scans. Hypaware forwards that path through semantically transparent source
> wrappers, concatenates only compatible partition schemas, keeps ranges
> global to a union, and retains the established row fallback wherever schema
> drift or visibility filtering needs row-level semantics.

## Context

Icebird now exposes `schema` plus `prepareScan()`. Squirreling uses them in
preference to `scan()` so parquet vectors and deferred columns can flow through
execution without allocating one `AsyncRow` and one promise per cell. A source
must expose both properties for the native path to light.

Hypaware wrapped every Icebird source several times before execution:

- storage removes internal cache fields;
- multi-partition datasets concatenate sources;
- ai-gateway advertises declared columns over old physical schemas;
- the execution budget samples heap growth while rows or column chunks flow;
- local-only visibility may filter or suppress individual rows.

Those wrappers predated prepared scans and exposed only `scan()` and
`scanColumn()`. Updating package versions alone therefore produced correct
queries but could not reach the new path.

## Decision

### Transparent wrappers {#transparent-wrappers}

Storage forwards `schema` and `prepareScan()` after removing internal fields
from the advertised schema. Squirreling derives field demands from that public
schema, so an internal field cannot enter a prepared request.

The heap-budget wrapper forwards prepared metadata and samples after native
batch production and after each deferred column materializes. It also accepts
a prepared-only third-party source, matching Squirreling's widened
`AsyncDataSource` contract. Hypaware names the stronger shape used by its own
storage and parquet layers `ScannableDataSource`: those sources always retain
`columns` and `scan()` for wrappers whose semantics require rows.

The visibility wrapper does not forward prepared scans. It needs each row's
`cwd`, may suppress selected content cells, and must apply LIMIT/OFFSET after
withholding. A governable prepared-only third-party source is refused when a
non-top caller needs the visibility wrapper, rather than bypassing the privacy
rule.

### Partition union {#partition-union}

`unionSources` advertises a prepared schema only when every child has a
prepared scan and the schemas have identical ordered names, data types, and
nullability. Field ids may differ between separately created Iceberg tables;
the union uses the first schema as its logical schema and remaps each demand by
field name to the child's id.

The union strips LIMIT/OFFSET before preparing children. Those hints apply once
to the concatenated stream, as LLP 0015 already requires for row and column
scans. A filter is forwarded to each child for file and row-group pruning. The
native batches are concatenated only when every child reports the same filter
residual. If residual contracts differ, the prepared result adapts the union's
established row scan back into batches and leaves the full filter and range as
residual work.

Prepared `exactRows` and `maxRows` are summed only when every child knows the
corresponding value. The union's legacy `numRows` follows the same rule: one
unknown child makes the total unknown instead of silently contributing zero.

### Schema drift {#schema-drift}

A partition union with different logical schemas does not expose
`prepareScan()`. The row path remains authoritative for absent-field padding,
including the `undefined` versus `null` split recorded by LLP 0261. Native
batches do not invent a third representation.

The ai-gateway declared-schema wrapper follows the same gate. It forwards a
prepared scan only when the physical schema already contains every column the
wrapper advertises. If an old partition lacks a declared field, the existing
row and `scanColumn` paths retain control.

Icebird 0.8.23 has a pre-existing row-scan defect when a pushed filter and
position deletes coexist: filtering loses physical row ordinals before delete
application, so a live matching row can be dropped. This is tracked in
[icebird#41](https://github.com/hyparam/icebird/issues/41). The prepared path
avoids the defect by withholding the filter when deletes exist, but visibility
wrappers, `scanColumn` aggregates, and schema-drift fallbacks remain exposed
until Icebird fixes its row path.

## Consequences

- Current, schema-aligned Iceberg partitions reach native batch execution end
  to end through storage, union, ai-gateway, and heap-budget wrappers.
- Additive schema drift retains the established absent-column semantics and
  stays on the older paths until all participating physical schemas align.
- LIMIT/OFFSET and residual filters remain globally correct over
  multi-partition datasets.
- Internal cache fields remain absent from planning and query results.
- Third-party prepared-only datasets work when no row-level visibility filter
  is required. A privacy-sensitive prepared-only dataset must also implement
  `scan()` before a restricted caller can query it.
