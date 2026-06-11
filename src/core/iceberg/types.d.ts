// Shared Iceberg partitioning types. Promoted out of `src/core/cache/` because
// the declaration is dataset-owned core surface, not a cache internal: the
// dataset registry validates it, the public plugin surface types it
// (`DatasetRegistration.cachePartitioning`), the intrinsic cache derives a spec
// from it, and the `@hypaware/format-iceberg` export reuses it for its sort
// axis. See LLP 0003 (core vs plugin surface) and LLP 0022#shared-core-helpers.

/**
 * A dataset's declared partitioning. Consumed by the cache (to partition its
 * tables) and by the iceberg export (to derive a within-partition sort key from
 * the identity columns). The name is cache-historical; the type is core surface.
 */
export interface CachePartitioningDeclaration {
  source: {
    columns: string[]
    fallback?: string
  }
  iceberg: {
    fields: CachePartitionField[]
  }
}

export interface CachePartitionField {
  column: string
  transform: 'identity' | 'day' | 'month' | 'year' | string
  required?: boolean
}
