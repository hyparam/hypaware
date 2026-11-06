// @ts-check

// A dataset whose partition discovery throws is isolated so the others still
// ship, but the run has to say so: `hyp sync` otherwise reports the selected
// scope as sent and exits 0 (#976). These pin what the driver reports per
// dataset, and that the report is kept apart from the export acknowledgement.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createSinkDriver } from '../../src/core/sinks/driver.js'

/** @param {string} name @param {{ fail?: 'first' | 'rediscover' }} [opts] */
function dataset(name, opts = {}) {
  let calls = 0
  return {
    name,
    mode: opts.fail,
    async discoverPartitions() {
      calls += 1
      if (this.mode === 'first') throw new Error(`${name} unreadable`)
      // The second call in a run is the post-flush re-discovery.
      if (this.mode === 'rediscover' && calls % 2 === 0) throw new Error(`${name} rediscovery failed`)
      return [
        { dataset: name, partition: { p: 'a' }, tablePath: `/cache/${name}/a` },
        { dataset: name, partition: { p: 'b' }, tablePath: `/cache/${name}/b` },
      ]
    },
  }
}

/** @param {string} instanceName */
function sink(instanceName) {
  /** @type {string[][]} */
  const batches = []
  return {
    instanceName,
    plugin: '@hypaware/fake',
    kind: 'blob',
    config: { schedule: '* * * * *' },
    batches,
    sink: {
      async exportBatch(/** @type {any} */ batch) {
        batches.push(batch.partitions.map((/** @type {any} */ p) => p.tablePath))
        return { status: 'exported', partitionsExported: batch.partitions.length, bytesWritten: 10 }
      },
    },
  }
}

/** @param {any[]} datasets @param {any[]} sinks @param {string} stateRoot */
function driverFor(datasets, sinks, stateRoot) {
  return createSinkDriver({
    sinkRegistry: /** @type {any} */ ({ listHandles: () => sinks }),
    queryRegistry: /** @type {any} */ ({ listDatasets: () => datasets }),
    storage: /** @type {any} */ ({
      cacheRoot: path.join(stateRoot, 'cache'),
      tableExists: () => true,
      // Every partition has rows waiting, so each run flushes and re-discovers.
      hasPendingSync: () => true,
      async flushTable() {},
    }),
    stateRoot,
  })
}

test('discovery reports complete, failed and partial datasets per sink without failing the export', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sink-discovery-report-'))
  try {
    const healthy = dataset('traces')
    const broken = dataset('logs', { fail: 'first' })
    const late = dataset('metrics', { fail: 'rediscover' })
    const sinks = [sink('archive'), sink('central')]
    const driver = driverFor([healthy, broken, late], sinks, stateRoot)

    const report = await driver.tick({ force: true })

    assert.equal(report.sinks.length, 2)
    for (const r of report.sinks) {
      assert.equal(r.status, 'exported', 'the sink acknowledged what it was handed')
      assert.equal(r.partitionsExported, 4)
      assert.deepEqual(r.datasets, [
        { dataset: 'traces', partitions: 2, discovery: 'complete' },
        { dataset: 'logs', partitions: 0, discovery: 'failed' },
        { dataset: 'metrics', partitions: 2, discovery: 'partial' },
      ])
    }
    for (const s of sinks) {
      assert.deepEqual(s.batches, [['/cache/traces/a', '/cache/traces/b', '/cache/metrics/a', '/cache/metrics/b']])
    }
    // Incomplete discovery is not an export failure: no outbox evidence, so no
    // acknowledged partition is queued for a retry it does not need.
    await assert.rejects(fs.access(path.join(stateRoot, 'sinks', 'archive', 'outbox')))

    // Once the dataset reads again, the next run covers it.
    broken.mode = undefined
    late.mode = undefined
    const retry = await driver.tick({ force: true })
    for (const r of retry.sinks) {
      assert.ok(r.datasets?.every((d) => d.discovery === 'complete'))
      assert.equal(r.partitionsExported, 6)
    }
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('an empty dataset stays distinct from one whose discovery failed', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sink-discovery-empty-'))
  try {
    const empty = { name: 'quiet', async discoverPartitions() { return [] } }
    const driver = driverFor([empty, dataset('logs', { fail: 'first' })], [sink('archive')], stateRoot)
    const [r] = (await driver.tick({ force: true })).sinks
    assert.deepEqual(r.datasets, [
      { dataset: 'quiet', partitions: 0, discovery: 'complete' },
      { dataset: 'logs', partitions: 0, discovery: 'failed' },
    ])
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})
