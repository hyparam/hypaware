// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createSinkDriver } from '../../src/core/sinks/driver.js'

// `discoverReadyPartitions` reports a dataset whose `discoverPartitions` threw
// by logging it, and that record used to name the dataset by reading
// `dataset.name` off the live registration - plugin code, run from inside the
// catch that exists to contain the plugin's first throw. A name that answers
// with a throw therefore threw a second time out of the handler, out of
// `runSink` and out of the daemon tick, which swallows it as
// `daemon.tick_failed`: every sink stops exporting for the daemon's life while
// `hyp status` still reads healthy (#1524, the shape #1509 closed for the
// backfill sweep). The thrown value itself is the other plugin-owned value in
// those catches, and `String()` raises on anything with no primitive
// conversion.

const HEALTHY_PARTITION = { dataset: 'z_healthy', partition: { source: 'test' } }

/**
 * A driver over one recording request sink and the given datasets.
 *
 * @param {string} stateRoot
 * @param {any[]} datasets
 * @param {{ exportBatch?: (batch: any) => any }} [sinkOverrides]
 */
function driverOver(stateRoot, datasets, sinkOverrides = {}) {
  /** @type {any[][]} */
  const batches = []
  const driver = createSinkDriver({
    sinkRegistry: /** @type {any} */ ({
      listHandles: () => [{
        instanceName: 'recorder',
        plugin: '@third-party/sink-destination-fixture',
        kind: 'request',
        config: { schedule: '* * * * *' },
        sink: {
          async exportBatch(batch) {
            if (sinkOverrides.exportBatch) return sinkOverrides.exportBatch(batch)
            batches.push(batch.partitions)
            return { status: 'exported', partitionsExported: batch.partitions.length, bytesWritten: 0 }
          },
        },
      }],
    }),
    queryRegistry: /** @type {any} */ ({ listDatasets: () => datasets }),
    storage: /** @type {any} */ ({
      cacheRoot: stateRoot,
      tableExists: () => true,
      hasPendingSync: () => false,
    }),
    stateRoot,
  })
  return { driver, batches }
}

/** A dataset that discovers one exportable partition. */
function healthyDataset() {
  return {
    name: 'z_healthy',
    plugin: '@hypaware/otel',
    discoverPartitions() { return [HEALTHY_PARTITION] },
  }
}

/**
 * A dataset whose discovery fails and whose `name` cannot be read, the pairing
 * that turns one failed discovery into a failed tick.
 *
 * @param {unknown} thrown
 */
function hostileDataset(thrown) {
  return {
    get name() { throw new TypeError('name is not readable') },
    plugin: '@third-party/hostile-dataset',
    discoverPartitions() { throw thrown },
  }
}

async function tmpStateRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-dataset-name-'))
}

test('a dataset whose name cannot be read is logged, not thrown out of the tick', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    const { driver, batches } = driverOver(stateRoot, [
      hostileDataset(new Error('discovery is broken')),
      healthyDataset(),
    ])

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.deepEqual(
      report.sinks.map((s) => [s.instance, s.status]),
      [['recorder', 'exported']],
      'the sink behind the unreadable dataset never exported',
    )
    assert.deepEqual(batches, [[HEALTHY_PARTITION]], 'discovery stopped at the hostile dataset')
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a discovery failure thrown as a value with no primitive conversion is still only that dataset\'s failure', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    const { driver, batches } = driverOver(stateRoot, [
      hostileDataset(Object.create(null)),
      healthyDataset(),
    ])

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.deepEqual(report.sinks.map((s) => s.status), ['exported'])
    assert.deepEqual(batches, [[HEALTHY_PARTITION]])
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a sink that throws a value with no primitive conversion is recorded failed, not thrown out of the tick', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    const { driver } = driverOver(stateRoot, [healthyDataset()], {
      exportBatch() { throw Object.create(null) },
    })

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.equal(report.sinks.length, 1, 'the tick must still report the sink')
    assert.equal(report.sinks[0].status, 'failed')
    assert.equal(
      (await fs.readdir(path.join(stateRoot, 'sinks', 'recorder', 'outbox')).then((n) => n.length, () => 0)),
      1,
      'a batch the sink refused is a failed batch, so its partitions belong in the outbox',
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})
