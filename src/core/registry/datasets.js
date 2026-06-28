// @ts-check

/**
 * @import { DatasetRegistration, DatasetSchema, QueryRegistry } from '../../../collectivus-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration } from '../../../src/core/cache/types.js'
 */

/**
 * @param {CachePartitioningDeclaration} decl
 * @param {DatasetSchema} schema
 * @param {string} datasetName
 */
function validateCachePartitioning(decl, schema, datasetName) {
  const colNames = new Set(schema.columns.map(c => c.name))

  for (const col of decl.source.columns) {
    if (!colNames.has(col)) {
      throw new Error(
        `registerDataset '${datasetName}': cachePartitioning source column '${col}' not found in schema`
      )
    }
  }

  for (const field of decl.iceberg.fields) {
    if (field.required && !colNames.has(field.column)) {
      throw new Error(
        `registerDataset '${datasetName}': cachePartitioning required Iceberg field '${field.column}' not found in schema`
      )
    }
  }
}

/**
 * In-memory dataset registry. Built-in core registers **zero** datasets;
 * every dataset (`logs`, `traces`, `metrics`, `ai_gateway_messages`,
 * `gascity_messages`, …) is contributed by a plugin during activation.
 *
 * The kernel surfaces this registry through `ctx.query` on every
 * activation context and as `kernel.query` for the dispatcher.
 *
 * @returns {QueryRegistry}
 * @ref LLP 0015#query-is-intrinsic [implements] — core hard-codes no dataset names; plugins register every one
 */
export function createQueryRegistry() {
  /** @type {Map<string, DatasetRegistration>} */
  const datasets = new Map()

  return {
    registerDataset(dataset) {
      if (!dataset || typeof dataset.name !== 'string' || dataset.name.length === 0) {
        throw new Error('registerDataset: dataset.name is required')
      }
      if (datasets.has(dataset.name)) {
        throw new Error(`registerDataset: dataset '${dataset.name}' already registered`)
      }
      if (dataset.cachePartitioning) {
        validateCachePartitioning(dataset.cachePartitioning, dataset.schema, dataset.name)
      }
      datasets.set(dataset.name, dataset)
    },
    getDataset(name) {
      return datasets.get(name)
    },
    listDatasets() {
      return Array.from(datasets.values()).sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}
