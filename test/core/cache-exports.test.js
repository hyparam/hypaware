// @ts-check

// The published `./core/cache` entry point. The server imports its cache table
// helpers through this specifier, so the names below are a contract with
// another repo: renaming one breaks that repo's build, not this one's.

import test from 'node:test'
import assert from 'node:assert/strict'
import * as cache from 'hypaware/core/cache'

test('./core/cache exports the helpers the server host uses', () => {
  assert.deepEqual(Object.keys(cache).sort(), [
    'CACHE_INTERNAL_FIELDS',
    'appendRowsToTable',
    'cacheTableExists',
    'createLocalIcebergIO',
    'discoverCachePartitions',
    'maintainCache',
    'normalizeMaintenanceConfig',
    'resolveCacheTableDir',
    'scanCacheTableRows',
    'tableUrlForDir',
    'tryReadCursorSync',
    'withPartitionMutationLock',
    'writeCursor',
  ])
})
