// @ts-check

import { compareStrings } from '../util/compare_strings.js'

/**
 * @import { DatasetRegistration, DatasetSchema, QueryRegistry } from '../../../hypaware-plugin-kernel-types.js'
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

  // @ref LLP 0311#declaration-split [constrained-by]: `sortOnly` demotes a
  // field out of the partition spec, and the drift guard reads a recorded
  // partition field the declaration has demoted as a pending migration
  // rather than drift. Demoting EVERY field is therefore two failures at
  // once: the cache table would be created unpartitioned (the grep walk
  // orders files by their partition `date`, which would no longer exist),
  // and `validatePartitionSpecStability` would have no expected field left
  // to check and no recorded field it could reject, so it would accept any
  // spec at all. Neither is a state a declaration should be able to reach
  // by omission, so refuse it where the declaration is registered.
  // @ref LLP 0311#declaration-split [constrained-by]: `sortOnly` moves a
  // field from the partition spec to the sort order, and a cache sort order
  // carries identity fields only (`sortColumnsForDeclaration`, which skips
  // anything else so a `day`/`bucket` transform is never silently recorded
  // as a sort on the raw column). A non-identity field marked `sortOnly` is
  // therefore in neither: it partitions nothing and sorts nothing, and the
  // declaration reads as though it does both. Refuse it rather than let a
  // future dataset declare a column that contributes nothing at all.
  for (const field of decl.iceberg.fields) {
    if (field.sortOnly && field.transform !== 'identity') {
      throw new Error(
        `registerDataset '${datasetName}': cachePartitioning field '${field.column}' is sortOnly with transform '${field.transform}' - sortOnly requires transform 'identity'`
      )
    }
  }

  if (decl.iceberg.fields.length > 0 && decl.iceberg.fields.every(f => f.sortOnly)) {
    throw new Error(
      `registerDataset '${datasetName}': cachePartitioning declares every Iceberg field sortOnly - at least one field must partition the cache table`
    )
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
 * @ref LLP 0015#query-is-intrinsic [implements]: core hard-codes no dataset names; plugins register every one
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
      return Array.from(datasets.values()).sort((a, b) => compareStrings(a.name, b.name))
    },
  }
}
