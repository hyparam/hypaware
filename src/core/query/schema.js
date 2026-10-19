// @ts-check

/**
 * @import { DatasetSchema, QueryRegistry } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Resolve the schema for a dataset by name. The kernel does not hard
 * code dataset names; the registry holds whatever the active plugin
 * set contributed; so `query schema <name>` simply asks the registry.
 *
 * Returns `undefined` if the dataset is not registered; callers
 * surface that as a user-facing error.
 *
 * @param {QueryRegistry} registry
 * @param {string} name
 * @returns {DatasetSchema | undefined}
 */
export function schemaForDataset(registry, name) {
  return registry.getDataset(name)?.schema
}

/**
 * What an empty column list establishes, and no more. A registration with no
 * declared columns (an S3 source with no `schema`, say) can still be queried:
 * SQL reads the source's own columns when a query runs. The registry cannot
 * tell an omitted declaration from an empty one, so this states only that
 * nothing is declared and that the source was not opened to describe it,
 * never that the dataset has zero columns. Shared by the CLI rendering and the
 * MCP schema resource so both say the same thing.
 */
export const UNDECLARED_SCHEMA_NOTE =
  'none declared (the source schema is not inspected here; SQL resolves its columns when a query runs)'

/**
 * Render a `DatasetSchema` as a stable, line-oriented text block.
 * Used by `hyp query schema <name>` and surfaced verbatim in tests
 * that snapshot CLI output.
 *
 * @param {string} name
 * @param {DatasetSchema} schema
 */
export function renderSchema(name, schema) {
  const lines = []
  lines.push(`dataset: ${name}`)
  if (schema.columns.length === 0) {
    lines.push(`columns: ${UNDECLARED_SCHEMA_NOTE}`)
    // Not offered as a cheap probe: an S3 parquet source reads whole objects
    // to set up any query, LIMIT or not. A dataset name need not be a bare
    // SQL identifier (`sales-events`, `select`), so it is double-quoted, and
    // the statement is single-quoted for the shell it will be pasted into.
    const sql = `select * from "${name.replaceAll('"', '""')}" limit 1`
    lines.push(`  to see them: hyp query sql '${sql.replaceAll("'", "'\\''")}' (this reads the source)`)
    return lines.join('\n') + '\n'
  }
  lines.push(`columns: ${schema.columns.length}`)
  for (const column of schema.columns) {
    const nullability = column.nullable ? 'NULL' : 'NOT NULL'
    lines.push(`  ${column.name}  ${column.type}  ${nullability}`)
  }
  return lines.join('\n') + '\n'
}
