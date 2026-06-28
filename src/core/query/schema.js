// @ts-check

/**
 * @import { DatasetRegistration, DatasetSchema, QueryRegistry } from '../../../collectivus-plugin-kernel-types.js'
 */

/**
 * Resolve the schema for a dataset by name. The kernel does not hard
 * code dataset names — the registry holds whatever the active plugin
 * set contributed — so `query schema <name>` simply asks the registry.
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
  lines.push(`columns: ${schema.columns.length}`)
  for (const column of schema.columns) {
    const nullability = column.nullable ? 'NULL' : 'NOT NULL'
    lines.push(`  ${column.name}  ${column.type}  ${nullability}`)
  }
  return lines.join('\n') + '\n'
}
