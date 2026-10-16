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
 * @param {Record<string, unknown>} [storageOverrides]
 */
function driverOver(stateRoot, datasets, sinkOverrides = {}, storageOverrides = {}) {
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
      ...storageOverrides,
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

test('a flush that rejects with a value with no primitive conversion still lets the post-flush re-discovery run', async () => {
  // `storage.flushTable` runs the owning dataset's `settleBatch` hook, so the
  // value in the flush catch is plugin-owned like the other two. Rendering it
  // with the bare idiom raised out of that handler into the per-dataset catch
  // below it: contained, so the tick survived, but the failure was recorded as
  // a discovery failure with no `tablePath`, and the re-discovery that
  // publishes what the *other* flushes just committed never ran - so those
  // partitions went unexported for as long as one sibling kept failing.
  const stateRoot = await tmpStateRoot()
  try {
    const settled = { dataset: 'z_healthy', partition: { source: 'test' }, tablePath: '/t/settled' }
    const failing = { dataset: 'z_healthy', partition: { source: 'other' }, tablePath: '/t/failing' }
    let discoveries = 0
    const { driver, batches } = driverOver(
      stateRoot,
      [{
        name: 'z_healthy',
        plugin: '@hypaware/otel',
        discoverPartitions() {
          discoveries += 1
          return discoveries === 1 ? [settled, failing] : [settled, failing, HEALTHY_PARTITION]
        },
      }],
      {},
      {
        hasPendingSync: () => true,
        async flushTable(/** @type {string} */ tablePath) {
          if (tablePath === '/t/failing') throw Object.create(null)
        },
      },
    )

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.equal(discoveries, 2, 'the flush catch threw, so the post-flush re-discovery never ran')
    assert.deepEqual(report.sinks.map((s) => s.status), ['exported'])
    assert.deepEqual(
      batches[0]?.map((/** @type {any} */ p) => p.tablePath ?? p.partition.source),
      ['/t/settled', '/t/failing', 'test'],
      'the partition the second discovery pass added was never exported',
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a partition whose tablePath stops being readable still lets the post-flush re-discovery run', async () => {
  // The same shape as the test above, one property over. The flush catch named
  // the partition by reading `part.tablePath` off the plugin's own object
  // again, from inside the handler that exists to contain the flush's throw. An
  // accessor that answered the flush and then stopped answering therefore
  // raised out of that handler into the per-dataset catch below it: the failure
  // was filed as a discovery failure with no path on it, and the re-discovery
  // that publishes what the other flushes committed never ran.
  const stateRoot = await tmpStateRoot()
  try {
    // Readable for every read up to and including the one that reaches
    // `flushTable`, and unreadable from the flush onwards - so the only read
    // that can still fail is the one the catch used to make.
    let flushAttempted = false
    const failing = {
      dataset: 'z_healthy',
      partition: { source: 'other' },
      get tablePath() {
        if (flushAttempted) throw new TypeError('tablePath is not readable')
        return '/t/failing'
      },
    }
    const settled = { dataset: 'z_healthy', partition: { source: 'test' }, tablePath: '/t/settled' }
    let discoveries = 0
    const { driver, batches } = driverOver(
      stateRoot,
      [{
        name: 'z_healthy',
        plugin: '@hypaware/otel',
        discoverPartitions() {
          discoveries += 1
          // A plugin builds its answer fresh on each call, so the second pass
          // is honest objects and only the first pass carries the accessor.
          return discoveries === 1
            ? [settled, failing]
            : [settled, { dataset: 'z_healthy', partition: { source: 'other' }, tablePath: '/t/failing' }, HEALTHY_PARTITION]
        },
      }],
      {},
      {
        hasPendingSync: () => true,
        async flushTable(/** @type {string} */ tablePath) {
          if (tablePath !== '/t/failing') return
          flushAttempted = true
          throw new Error('flush is broken')
        },
      },
    )

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.equal(discoveries, 2, 'naming the partition inside the flush catch threw out of it')
    assert.deepEqual(report.sinks.map((s) => s.status), ['exported'])
    assert.ok(
      batches[0]?.includes(HEALTHY_PARTITION),
      'the partition the second discovery pass added was never exported',
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a partition is flushed at the path it was just checked for pending rows at', async () => {
  // `hasPendingSync` and `flushTable` asked the plugin's accessor separately,
  // so it could report rows waiting at one table and have the kernel flush
  // another one it named at that instant.
  const stateRoot = await tmpStateRoot()
  try {
    let reads = 0
    const shifty = {
      dataset: 'z_healthy',
      partition: { source: 'other' },
      get tablePath() { reads += 1; return `/t/p${reads}` },
    }
    /** @type {string[]} */
    const asked = []
    /** @type {string[]} */
    const flushed = []
    const { driver } = driverOver(
      stateRoot,
      [{ name: 'z_healthy', plugin: '@hypaware/otel', discoverPartitions() { return [shifty] } }],
      {},
      {
        hasPendingSync(/** @type {string} */ tablePath) { asked.push(tablePath); return true },
        async flushTable(/** @type {string} */ tablePath) { flushed.push(tablePath) },
      },
    )

    await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.deepEqual(flushed, asked, 'the kernel flushed a table path other than the one it found rows waiting at')
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('the driver reads a partition tablePath once in each loop that visits it', async () => {
  // The count is the contract, the same one `registerDataset` keeps for
  // `name`: `keep` used to test one path for existence and record a different
  // one as seen, so the dedup it exists for stopped holding.
  const stateRoot = await tmpStateRoot()
  try {
    let reads = 0
    const counted = {
      dataset: 'z_healthy',
      partition: { source: 'other' },
      get tablePath() { reads += 1; return '/t/counted' },
    }
    const { driver } = driverOver(
      stateRoot,
      [{ name: 'z_healthy', plugin: '@hypaware/otel', discoverPartitions() { return [counted] } }],
    )

    await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.equal(reads, 2, 'one read for the keep filter and one for the flush guard, and no more')
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a partition the outbox cannot serialize is a failed batch, not a failed tick', async () => {
  // `persistOutbox` reads the plugin's own partition objects and serializes
  // them, so a throwing getter (or `toJSON`) below them lands in its own catch
  // carrying whatever the plugin threw. Rendering that with the bare idiom
  // raised out of `persistOutbox`, which both of its callers await from inside
  // `runSink` - one of them the export catch itself - so it left the tick
  // entirely and the daemon swallowed it as `daemon.tick_failed`.
  const stateRoot = await tmpStateRoot()
  try {
    const hostilePartition = {
      dataset: 'z_healthy',
      get partition() { throw Object.create(null) },
      tablePath: null,
    }
    const { driver } = driverOver(
      stateRoot,
      [{ name: 'z_healthy', plugin: '@hypaware/otel', discoverPartitions() { return [hostilePartition] } }],
      { exportBatch() { throw new Error('the destination refused the batch') } },
    )

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.equal(report.sinks.length, 1, 'the tick must still report the sink')
    assert.equal(report.sinks[0].status, 'failed')
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})
