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
    /**
     * `name` and `cachePartitioning` are each read once, and every later step
     * uses what this registry took.
     *
     * The registration is stored by reference, so a plugin's `name` is free to
     * be an accessor answering differently each time it is asked, and it is
     * both the key `getDataset` addresses a dataset by and the key
     * `listDatasets` orders by. Reading it again for the `set` stored the
     * dataset under a name nothing had validated: `getDataset` stopped
     * reaching it, the order came from a string nobody checked, and a second
     * answer naming an already-registered dataset displaced that dataset
     * instead of being refused as a duplicate.
     */
    registerDataset(dataset) {
      const name = dataset?.name
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('registerDataset: dataset.name is required')
      }
      if (datasets.has(name)) {
        throw new Error(`registerDataset: dataset '${name}' already registered`)
      }
      const cachePartitioning = dataset.cachePartitioning
      if (cachePartitioning) {
        validateCachePartitioning(cachePartitioning, dataset.schema, name)
      }
      datasets.set(name, dataset)
    },
    getDataset(name) {
      return datasets.get(name)
    },
    /**
     * Every registered dataset, ordered by name.
     *
     * The order comes from the keys, not from `a.name`: the key is the name
     * this registry validated, while `dataset.name` is a live plugin property.
     * Reading it here would run plugin code inside a comparator, where a throw
     * escapes into every caller of `listDatasets()` before a single entry has
     * been handed back - `hyp query`, `hyp status`, the sync preview, and the
     * sink driver's partition discovery, which runs on the daemon's own tick
     * where the throw is swallowed as `daemon.tick_failed` and costs every
     * sink its export while `hyp status` still reads healthy (issue #1524).
     * `compareStrings` refuses a non-string as well, so an accessor that
     * merely stopped answering with a string was the same outage as one that
     * raised.
     */
    listDatasets() {
      return Array.from(datasets.keys())
        .sort(compareStrings)
        .map((name) => /** @type {DatasetRegistration} */ (datasets.get(name)))
    },
  }
}
