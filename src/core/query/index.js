// @ts-check

// Public query surface for plugins (resolved as `hypaware/core/query`).
// Reading parquet/Iceberg back from a BlobStore-backed query source is
// built on top of these helpers.

export { executeQuerySql } from './sql.js'
export { parquetDataSource } from './parquet-source.js'
export { whereToParquetFilter } from './parquet-pushdown.js'
export { unionSources, emptySource } from './union-source.js'

// Re-exported so callers of `hypaware/core/query` can catch a budget refusal
// (`executeQuerySql`'s execution budget, LLP 0054 #execution-budget) without
// importing the pinned `squirreling` engine directly.
// @ref LLP 0054#execution-budget [implements]: uniform surface re-export of the engine's typed refusal
export { QueryBudgetExceededError } from 'squirreling'
