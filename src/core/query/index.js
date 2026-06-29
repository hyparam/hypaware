// @ts-check

// Public query surface for plugins (resolved as `hypaware/core/query`).
// Reading parquet/Iceberg back from a BlobStore-backed query source is
// built on top of these helpers.

export { executeQuerySql } from './sql.js'
export { parquetDataSource } from './parquet-source.js'
export { whereToParquetFilter } from './parquet-pushdown.js'
export { unionSources, emptySource } from './union-source.js'
