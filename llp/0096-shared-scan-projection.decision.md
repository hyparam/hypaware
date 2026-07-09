# LLP 0096: one shared scan per contract, declarative rule predicates

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins
**Author:** Phil / Claude
**Date:** 2026-07-09
**Related:** LLP 0095, LLP 0023, LLP 0026

> Fixes [LLP 0095](./0095-projection-read-amplification.issue.md) by changing
> how the projection engine executes a contract, not what a contract means:
> rules declare columns and a simple predicate instead of raw SQL, the engine
> scans the source once per contract, and the LLP 0026 aux filter becomes a
> contract-level row filter evaluated once per row.

## Decision

1. **`ContractRule` gains a declarative form.** A rule carries either
   `{ columns, where? }` or the legacy `{ sql }`, never both. `where` is a
   conjunction of the three predicate shapes the existing rules actually use:
   `eq` (column = value), `in` (column in list), `likePrefix`
   (column LIKE 'prefix%'). No general SQL parsing, no expression language.
2. **One scan per contract for declarative rules.** The engine unions the
   declarative rules' `columns` (plus the contract row filter's columns),
   runs a single `SELECT <union> FROM <sourceDataset>` per contract, and
   evaluates each rule's `where` in JS per row before `toRow`. Predicate
   semantics mirror SQL: a null or absent column never matches.
3. **Raw-SQL rules stay supported and run standalone**, grouped by identical
   SQL text so duplicate queries collapse. This keeps two escape hatches
   open: contracts in other repos migrate on their own schedule (the
   server's github contract, context-graph-enrich), and rules whose
   predicate must prune a heavy column server-side stay pushed down (the
   Skill surface rules' `content_text LIKE 'prefix%'` guards, which keep the
   largest column out of the shared scan's materialization).
4. **The aux filter moves to the contract.** `Contract` gains optional
   `rowFilter: { columns, keep(row) }`, evaluated once per row on both the
   shared scan and raw-SQL paths. The ai-gateway contract's per-rule
   `withAttributes`/`auxKindOf` wrapping (LLP 0026) is replaced by one
   `rowFilter` that parses `attributes` once per row instead of once per
   rule per row.
5. **`refresh: 'always'` runs once per distinct query**, which the shared
   scan reduces to approximately once per contract.

## Alternatives rejected

- **Temp slim-table**: materialize the union columns into a temp table and
  point the untouched rule SQL at it. Rejected: introduces temp-dataset
  plumbing with no other consumer, and still pays 25 query executions.
- **Group rules by identical WHERE text only**: no contract-shape change,
  but the ai-gateway contract still needs ~7 scans and the per-rule
  `attributes` parsing remains. Insufficient for LLP 0095's numbers.
- **Incremental (watermarked) projection**: complementary, not competing;
  belongs to the automatic-derivation track (PR #279). This decision makes
  every run cheap; a watermark would additionally shrink what a run reads.

## Consequences

- The registry validates the new shape (exactly one of `sql` or `columns`);
  `kind`/`type`/`toRow` validation is unchanged.
- Projection output is bit-identical: same rows reach the same `toRow`
  functions in the same contract order; only the read path changes. The e2e
  regression (test/plugins/context-graph-project-e2e.test.js) plus a
  shared-vs-sql equivalence test hold that line.
- Expected effect at LLP 0095's prod scale: 25 full scans to 1 slim scan
  plus 2 pushed-down prefix scans, and 25x fewer `attributes` parses;
  minutes, not the better part of an hour.
