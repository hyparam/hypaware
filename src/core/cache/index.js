// @ts-check

// Public cache surface for kernel hosts (resolved as `hypaware/core/cache`).
// The server operates on the same on-disk cache tables as the kernel, so it
// borrows these rather than spelling its own layout, locks, or cursor format.

export { createLocalIcebergIO, tableUrlForDir } from './iceberg/resolver.js'
export { appendRowsToTable, tableExists as cacheTableExists, scanRowsFromTable as scanCacheTableRows } from './iceberg/store.js'
export { discoverCachePartitions, tryReadCursorSync, withPartitionMutationLock, writeCursor } from './partition.js'
export { maintainCache, normalizeMaintenanceConfig } from './maintenance.js'
export { resolveIcebergDir as resolveCacheTableDir } from './storage.js'
export { INTERNAL_FIELDS as CACHE_INTERNAL_FIELDS } from './streaming-reader.js'
