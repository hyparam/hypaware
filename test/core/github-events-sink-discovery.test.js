// @ts-check

// `@hypaware/github` spools `github_events` under the `all` label, but the rows
// carry no client identity and the plugin declares no `cachePartitioning`, so
// the cache commits them under `github_events/source=unknown`. Discovery that
// returns the spool label alone therefore hands the sink the one path the
// driver's own flush just emptied: the tick reports `exported` having exported
// nothing and written no bytes, indistinguishable from an idle tick (#1593).
//
// Driven through the real `createSinkDriver` rather than asserted at the
// dataset level, because the dataset-level call looks correct in isolation -
// the label path is real, it just holds nothing by the time the sink runs.
// `test/core/sink-driver-spool-discovery.test.js` pins the driver's
// flush-then-re-discover pass over a synthetic dataset; this pins the shipped
// `github_events` registration against it.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createSinkDriver } from '../../src/core/sinks/driver.js'
import {
  DATASET_NAME,
  GITHUB_EVENTS_COLUMNS,
  githubEventsDatasetRegistration,
  githubEventsTablePath,
} from '../../hypaware-core/plugins-workspace/github/src/dataset.js'

const ROWS = [
  {
    event_id: 'issue:hyparam/hypaware:1593',
    event_type: 'issue',
    repo: 'hyparam/hypaware',
    actor_login: 'philcunliffe',
    actor_type: 'User',
    number: 1593n,
    state: 'open',
    created_at: '2026-09-09T00:00:00.000Z',
    payload: { locked: false },
  },
  {
    event_id: 'review:hyparam/hypaware:9001',
    event_type: 'review',
    repo: 'hyparam/hypaware',
    actor_login: 'neutral',
    actor_type: 'Bot',
    review_id: 9001n,
    review_state: 'APPROVED',
    pr_number: 1586n,
    created_at: '2026-09-09T00:01:00.000Z',
    payload: null,
  },
]

/**
 * Total size of the parquet files the cache committed under a partition.
 *
 * @param {string} tablePath
 * @returns {Promise<number>}
 */
async function partitionBytes(tablePath) {
  const dataDir = path.join(tablePath, 'table', 'data')
  let names = /** @type {string[]} */ ([])
  try {
    names = await fs.readdir(dataDir)
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) total += (await fs.stat(path.join(dataDir, name))).size
  return total
}

test('a sink tick exports the github_events partition the driver flush commits', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-github-sink-discovery-'))
  try {
    const cacheRoot = path.join(stateRoot, 'cache')
    const storage = createQueryStorageService({ cacheRoot })
    const spoolPath = githubEventsTablePath(storage)
    await storage.appendRows(spoolPath, [...GITHUB_EVENTS_COLUMNS], ROWS)

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
            async exportBatch(/** @type {any} */ batch) {
              batches.push(batch.partitions.map((/** @type {any} */ p) => p.tablePath))
              // Stand in for a blob or S3 sink reading what it was handed:
              // only a partition holding committed rows contributes bytes.
              let bytesWritten = 0
              for (const part of batch.partitions) bytesWritten += await partitionBytes(part.tablePath)
              return { status: 'exported', partitionsExported: batch.partitions.length, bytesWritten }
            },
          },
        }],
      }),
      queryRegistry: /** @type {any} */ ({ listDatasets: () => [githubEventsDatasetRegistration()] }),
      storage: /** @type {any} */ (storage),
      stateRoot,
    })

    const summary = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    const committed = storage.cacheTablePath(DATASET_NAME, ['source=unknown'])
    assert.equal(storage.tableExists(committed), true, 'the flush committed under source=unknown')
    assert.equal(
      storage.tableExists(spoolPath),
      false,
      'the spool label the rows were appended to holds nothing once flushed',
    )
    assert.deepEqual(
      batches,
      [[spoolPath, committed]],
      'the committed github_events partition reached the sink in the same tick',
    )
    const archive = (summary.sinks ?? []).find((/** @type {any} */ s) => s.instance === 'archive')
    assert.equal(archive?.partitionsExported, 2)
    assert.ok(
      (archive?.bytesWritten ?? 0) > 0,
      `the tick wrote bytes, not an idle-looking zero: ${JSON.stringify(archive)}`,
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})
