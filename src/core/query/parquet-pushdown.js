// @ts-check

// icebird's converter, re-exported rather than reimplemented. This module and
// `icebird/src/sql/whereFilter.js` both began as ports of the Hyperparam app's
// `lib/tools/parquetPushdownFilter.ts` and drifted in opposite directions:
// icebird gained constant-folding of typed literals (`TIMESTAMP '...'` bounds,
// which squirreling parses as a cast over a string literal) while this copy
// declined them and pushed nothing down; this copy gained SQL three-valued
// NULL semantics (#728, #730, #734, #743) while icebird's stayed wrong on
// nullable columns. Neither copy was adoptable by the other until the NULL
// work converged: squirreling >= 0.15.3 evaluates WHERE with Kleene
// three-valued logic, and icebird >= 0.8.22 pushes filters that agree with it
// (De Morgan instead of `$nor`, `$ne`/`$nin` null guards, never-match for a
// NOT IN list holding NULL, declines answered by the now-three-valued engine).
//
// Floor: hyparquet >= 1.28.2, whose `matchFilter` rejects null cells in the
// bare relational operators icebird emits ($lt/$lte/$gt/$gte). On 1.28.1
// those coerce a null cell to 0 and a bare bound leaks NULL rows, which is
// why the kernel's copy carried its own `$ne: null` guards. The floor also
// covers 1.28.1's `$in`/`$nin` matching through `equals()` rather than
// `Array.prototype.includes`, so plain-number literals match bigint-decoded
// INT64 columns and the old `coerceBigInt` shim is unnecessary.
//
// @ref LLP 0222 [implements]: one pushdown converter for the whole stack, owned by icebird
export { whereToParquetFilter } from 'icebird/src/sql/whereFilter.js'
