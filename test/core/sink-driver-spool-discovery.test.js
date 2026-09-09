// @ts-check

// The cache write path commits rows that carry no client identity under
// `<dataset>/source=unknown`, not under the label they were spooled to, so a
// dataset that discovers only its spool label hands the sink a path holding
// nothing: the tick reports `exported` having exported no partition and written
// no bytes, indistinguishable from an idle tick (#1574).
//
// What makes the committed partition reachable at all is
// `discoverReadyPartitions` flushing the pending spool and re-running discovery
// inside the same tick. Before this test, deleting that re-discovery reddened
// only `test/core/sink-hostile-dataset-name.test.js`, which drives it over a
// stubbed storage (`hasPendingSync: () => true`, fake table paths) to prove a
// hostile flush failure cannot skip it. Nothing in `npm test` drove it over the
// real cache write path, where the spool label and the committed partition
// actually differ. The two sink-export smokes did, and CI runs no smokes
// (#1487).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { discoverCachePartitions } from '../../src/core/cache/partition.js'
import { createSinkDriver } from '../../src/core/sinks/driver.js'

/**
 * @import { ColumnSpec, QueryPartition } from '../../hypaware-plugin-kernel-types.js'
 */

const DATASET = 'dummy_rows'

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'value', type: 'STRING', nullable: false },
]

/**
 * A dataset that lists its spool label and every committed partition on disk.
 * That is the convention the cache-backed datasets follow: `@hypaware/otel`,
 * `@hypaware/ai-gateway`, `@hypaware/gascity`, `@hypaware/claude`'s telemetry
 * events and both graph plugins all list the label and then scan. It is a
 * convention rather than an invariant the kernel enforces: `@hypaware/github`
 * still returns its spool label alone and loses every row to the flush below
 * (#1593), which is why this drives the real driver rather than asserting the
 * shape at the dataset level.
 *
 * @param {string} cacheRoot
 * @param {string} spoolPath
 */
function scanningDataset(cacheRoot, spoolPath) {
  return {
    name: DATASET,
    async discoverPartitions() {
      /** @type {QueryPartition[]} */
      const partitions = [{ dataset: DATASET, partition: { partition: 'all' }, tablePath: spoolPath }]
      for (const part of await discoverCachePartitions(cacheRoot, { datasets: [DATASET] })) {
        if (part.path === spoolPath) continue
        partitions.push({ dataset: DATASET, partition: part.partition, tablePath: part.path })
      }
      return partitions
    },
  }
}

test('the driver flushes a pending spool and exports the partition that flush committed', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sink-spool-discovery-'))
  try {
    const cacheRoot = path.join(stateRoot, 'cache')
    const storage = createQueryStorageService({ cacheRoot })
    const spoolPath = storage.cacheTablePath(DATASET, ['all'])
    await storage.appendRows(spoolPath, COLUMNS, [{ id: 1n, value: 'v1' }, { id: 2n, value: 'v2' }])

    /** @type {string[][]} */
    const batches = []
    const driver = createSinkDriver({
      sinkRegistry: /** @type {any} */ ({
        listHandles: () => [{
          instanceName: 'archive',
          plugin: '@hypaware/local-fs',
          kind: 'blob',
          config: { schedule: '* * * * *' },
          sink: {
            async exportBatch(batch) {
              batches.push(batch.partitions.map((/** @type {any} */ p) => p.tablePath))
              return { status: 'exported', partitionsExported: batch.partitions.length }
            },
          },
        }],
      }),
      queryRegistry: /** @type {any} */ ({ listDatasets: () => [scanningDataset(cacheRoot, spoolPath)] }),
      storage: /** @type {any} */ (storage),
      stateRoot,
    })

    await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    const committed = storage.cacheTablePath(DATASET, ['source=unknown'])
    assert.deepEqual(batches, [[spoolPath, committed]], 'the flushed partition reached the sink in the same tick')
    assert.equal(storage.tableExists(committed), true, 'the flush committed under source=unknown')
    assert.equal(
      storage.tableExists(spoolPath),
      false,
      'the spool label the rows were appended to holds nothing once flushed',
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})
