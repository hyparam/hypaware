// @ts-check

// icebird's converter, re-exported rather than reimplemented. This module and
// `icebird/src/sql/whereFilter.js` both began as ports of the Hyperparam app's
// `lib/tools/parquetPushdownFilter.ts`. icebird's copy kept moving and this one
// did not, and the drift cost both query time and correctness:
//
//  - Typed literals never converted. squirreling parses
//    `TIMESTAMP '2026-08-11T00:00:00Z'` as a `cast` node wrapping a string
//    literal. icebird constant-folds it (`staticLiteral`/`foldCast`); the local
//    copy required a bare `literal` operand and returned `undefined` for the
//    whole predicate, because AND is all-or-nothing. Every timestamp-bounded
//    query therefore pushed nothing down. Measured against the production
//    sessions list: one grouped scan took 11.4s bounded on `message_created_at`
//    versus 7.3s bounded on `date`, same rows, same projection.
//  - Any cast unwrapped at boolean position. The local copy rewrote
//    `WHERE CAST(a = 1 AS TEXT)` to `a = 1`, but the engine evaluates that cast
//    to the string `'false'`, which is truthy, so the pushdown dropped rows the
//    query selects. icebird gates the unwrap to the casts that preserve
//    truthiness (boolean and numeric targets).
//
// Dropped along with the local copy: its `coerceBigInt`, which turned every
// integer literal into a `bigint`. Nothing needed it. `filterStrict: false`
// (which parquet-source.js and icebird both pass) compares through `==`, so
// `5n == 5` holds either way, while hyparquet's bloom hashing REJECTS a bigint
// for INT32, FLOAT and DOUBLE columns: the coercion was quietly buying back
// nothing and costing bloom pruning on every non-INT64 numeric column.
//
// Floor: hyparquet >= 1.28.1, where `$in`/`$nin` match through `equals()`
// instead of `Array.prototype.includes`. On 1.27.x a number-valued `$in`
// against an INT64 column (hyparquet decodes those as bigint) matches no rows,
// which is precisely what `coerceBigInt` used to paper over.
//
// @ref LLP 0212 [implements]: one pushdown converter for the whole stack, owned by icebird
export { whereToParquetFilter } from 'icebird/src/sql/whereFilter.js'
