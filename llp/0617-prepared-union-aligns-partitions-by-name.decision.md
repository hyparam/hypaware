# LLP 0617: The prepared union aligns partitions by name

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Sources
**Author:** Kenny
**Date:** 2026-11-19
**Related:** LLP 0294, LLP 0261
**Extends:** LLP 0294 (#partition-union)

> A partition union keeps native prepared batches when its partitions hold the
> same column names in any order, when one side types a column `unknown` where
> the other names a type, and when nullability differs. Different name sets and
> conflicting known types still take the row path.

## Context

LLP 0294 exposes one prepared scan over a union only when every partition has
identical ordered names, data types, and nullability. The union already remaps
each demand to the child's field id by name, so the ordering rule protected
nothing the remap did not already handle.

On the server, `ai_gateway_messages` unions per-day cache tables with one
long-lived archive table. The archive grew by schema evolution, so columns
added later sit after the server-stamped columns, while each cache day is
created fresh in catalog order. The archive's export sink stores JSON columns
as Iceberg `string`; the cache stores them as `variant`, which reaches the
query layer as `unknown`. Either difference sent the whole union down the row
fallback, where Icebird builds an object per row. On a 7.7M-row dump that made
a bare `count(*)` take 12 s instead of under 1 s.

## Decision {#name-alignment}

`unionSources` merges partition schemas by name:

- The name sets must match exactly. Order may differ; the union keeps the
  first partition's order, which is also its column list.
- Equal data types merge to themselves. A column that is `unknown` in any
  partition is `unknown` in the union. Two different known types conflict and
  the union declines a prepared scan.
- A column is nullable in the union when it is nullable in any partition.

Advertising `unknown` makes no promise about value representation, which
matches what the row path already yields for these columns: each partition's
values pass through as that partition produced them.

## Unchanged

LLP 0294 #schema-drift stands. A partition missing a column, or holding an
extra one, still takes the row path so absent-field padding keeps the
undefined versus null split from LLP 0261.
