// @ts-check

/**
 * Public surface for blob-sink destination plugins. Re-exports the
 * kernel's `sink.encode_partition` wrapper plus the incremental-read
 * helpers so plugins can drop in the common observability and
 * watermark contracts instead of re-implementing them.
 *
 * Plugins import via:
 *
 * ```js
 * import { encodePartition, openIncrementalRows } from 'hypaware/core/sinks'
 * ```
 */

export { encodePartition, clusterColumnsForDataset } from './encoder.js'
export { SYNC_INVENTORY_VERSION, SYNC_INVENTORY_DATASET, SYNC_INVENTORY_MAX_KEYS,
  SYNC_INVENTORY_PAGE_KEYS, inventoryDay, inventoryKey, inventoryBucket,
  validInventoryBucket, summarizeInventoryKeys } from './sync-inventory.js'
export {
  createInstanceWatermarkStore,
  openIncrementalRows,
  watermarkKeyFor,
  withSeqRangeFilename,
} from './incremental.js'
