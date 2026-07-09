# LLP 0095: graph projection reads the source table once per rule

**Type:** Issue
**Status:** Active
**Systems:** Plugins
**Author:** Phil / Claude
**Date:** 2026-07-09
**Related:** LLP 0023, LLP 0026, LLP 0073, LLP 0077

> `projectGraph` executes every contract rule as an independent full SQL scan
> of the source dataset. With 25 rules on the ai-gateway contract, one
> projection reads the source 25 times and JSON-parses the `attributes`
> column 25 times per row. Invisible on a small local cache; pathological at
> server scale, and fatal to automatic projection (PR #279) at any scale.

## Observed

On a production hypaware-server deployment:

- Source: `ai_gateway_messages`, ~700k rows, ~1.3GB live cache across ~1,300
  parquet files.
- A single org-scoped `graph project` dry run read **~35GB** from disk and
  had not finished after **45 minutes**, single core pegged, before it was
  aborted. 25 rules x 1.3GB accounts for ~33GB of that.
- The same corpus projects in seconds on a laptop (about 4x fewer rows,
  3x fewer files, faster storage). The cost curve is
  `rules x table-size x file-count`; local installs are on the same curve
  and merely earlier on it.

## Why

Three stacked multipliers in `context-graph/src/project.js` and the contract
shape it consumes:

1. **Per-rule scans.** The engine loops `for contract / for rule` and calls
   `executeQuerySql(rule.sql)` per rule. Every rule of the ai-gateway
   contract selects from the same table; nothing is shared between the 25
   queries (LLP 0023 settled the contract seam, not this execution shape).
2. **The aux filter rides every rule.** LLP 0026's tag-don't-drop filter
   wraps each rule: `withAttributes` prepends the `attributes` column
   (19% of table bytes) to every rule's SQL, and `auxKindOf` JSON-parses it
   again for every rule that sees the row. One row's `attributes` is parsed
   up to 25 times per projection.
3. **`refresh: 'always'` per rule.** Each rule query re-runs the partition
   refresh pass, multiplying per-partition overhead by rule count.

## Impact

- Server-side projection (hypaware-server LLP 0037) is effectively unusable
  on real orgs: the admin endpoint times out and burns ~2 cores for the
  better part of an hour per run.
- PR #279 (LLP 0086-0092, automatic projection on a daemon tick, Draft)
  assumes projection is cheap enough to run every 15 minutes. This issue is
  a blocker for that design's viability at any accumulated history.
- Adding a rule to a contract today costs one more full table scan per
  projection, which mis-prices what should be a cheap contribution
  (LLP 0023 §contract-contribution).

## Fix

Settled in [LLP 0096](./0096-shared-scan-projection.decision.md): one shared
scan per contract with declarative per-rule predicates evaluated in JS, the
aux filter evaluated once per row, raw-SQL rules retained as a standalone
path. Incremental (watermarked) projection is out of scope here; it belongs
to the automatic-derivation track (PR #279) as steady-state work atop this
fix.
