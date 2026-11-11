# LLP 0595: a row filter may carry its own SQL for the shared scan

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins
**Author:** Kenny / HypForge
**Date:** 2026-11-11
**Extends:** LLP 0096#decision (items 2 and 4)
**Related:** LLP 0023, LLP 0026, LLP 0095

> LLP 0096 put the aux filter on the contract as `rowFilter: { columns, keep(row) }`
> and selected its columns in the shared scan so `keep` could run there. For
> the gateway that column is `attributes`, which carries whole tool outputs,
> so the shared scan held it for every source row. On a large cache the
> projection peaked at 8.9 GB and was killed. This doc lets a row filter state
> the same test in SQL, so the scan filters before it materializes anything.
> Shipped in hypaware #2963.

## Decision {#decision}

1. **`rowFilter` gains optional `sql`** {#sql-field}: a SQL predicate over the
   contract's source dataset that keeps exactly the rows `keep` keeps.
   `columns` and `keep` stay required. The registry rejects a `sql` that is
   not a non-empty string.
2. **With `sql`, the shared scan filters in SQL** {#shared-scan}: it runs
   `SELECT <union> FROM <sourceDataset> WHERE (<sql>)`, leaves the row
   filter's `columns` out of the union, and does not call `keep` on its rows.
   The filter is applied once, never twice. This replaces, for such a
   contract, LLP 0096 item 2's "plus the contract row filter's columns" and
   the shared-scan half of item 4.
3. **Raw-SQL rules still use `keep`** {#raw-sql}: they select the filter's
   columns and call `keep` per row, as LLP 0096 item 4 says. A contract
   without `sql` behaves exactly as before.
4. **The predicate must not fail the scan** {#total}: a row the engine cannot
   read as the filter expects is kept, as `keep` keeps it. One malformed row
   must cost that row's classification, not the whole projection. The
   gateway predicate guards with a substring test, `JSON_VALID` and
   `JSON_EXTRACT_SCALAR` (which reads null from JSON that is not an object)
   rather than `JSON_VALUE`, which throws on both.
5. **Where the two forms differ, the SQL form is the intended reading**
   {#divergence}. The gateway's `keep` treats `attributes` over 64 KiB as
   non-aux without parsing it (the `auxKindOf` size guard), while the SQL form
   classifies it. An aux exchange stays aux at any size, so the SQL result is
   the correct one; the size guard is a parse-cost bound, not a rule. A
   `claude` value stored as a JSON string is kept by SQL and dropped by
   `keep`; no writer produces that shape.

## Why {#why}

LLP 0096 item 3 already keeps heavy-column guards pushed down for the same
reason: a column the shared scan selects is held for every row it reads. The
row filter was the one heavy column item 3 did not reach. Pushing it into
WHERE keeps the rows the filter drops from ever being materialized, and with
squirreling 0.17.8 the row path also releases source rows as it collects
them.

## Alternatives rejected {#alternatives}

- **Turn the gateway's shared-scan rules into raw-SQL rules.** Puts the
  filter in SQL, but gives back LLP 0096's one-scan-per-contract win.
- **Replace `keep` with `sql`.** Raw-SQL rules from other repos run their own
  SQL and cannot have a second predicate spliced in safely, so `keep` stays
  the filter there.

## Consequences {#consequences}

- A contract that sets `sql` owns keeping it equal to `keep`. The e2e test
  pins that the gateway's shared scan carries the predicate and never selects
  `attributes`, and that rows whose `attributes` is not a JSON object are kept.
- Most gateway rows now pay one linear substring test instead of a JSON
  parse; only rows containing `"aux_kind"` are parsed.
- Projection output is unchanged except on the two divergences above.
