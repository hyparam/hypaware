// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createSinkDriver } from '../../src/core/sinks/driver.js'

// `exportBatch` is plugin code, and the driver try-wraps the call for exactly
// that reason: a sink that throws becomes a recorded `failed` plus an outbox
// entry while the tick carries on. A sink that *resolves* an object the kernel
// cannot read used to bypass all of it - every field was read after the catch
// closed, and the summary spread the plugin's own object - so the throw landed
// on the daemon tick instead, where it is swallowed as `daemon.tick_failed`
// and costs the sweep and every sink snapshot behind it (#1510).

const HOSTILE = 'hostile getter'

/**
 * A driver over the given sink handles, with no datasets (so a batch carries
 * no partitions) and a temp state root for the outbox.
 *
 * @param {string} stateRoot
 * @param {any[]} handles
 */
function driverOver(stateRoot, handles) {
  return createSinkDriver({
    sinkRegistry: /** @type {any} */ ({ listHandles: () => handles }),
    queryRegistry: /** @type {any} */ ({ listDatasets: () => [] }),
    storage: /** @type {any} */ ({ cacheRoot: stateRoot, tableExists: () => false }),
    stateRoot,
  })
}

/**
 * @param {string} instanceName
 * @param {() => any} exportResult
 * @returns {any}
 */
function handleReturning(instanceName, exportResult) {
  return {
    instanceName,
    plugin: '@third-party/hostile-sink',
    kind: 'request',
    config: { schedule: '* * * * *' },
    sink: { exportBatch: async () => exportResult() },
  }
}

async function tmpStateRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-export-'))
}

/**
 * @param {string} stateRoot
 * @param {string} instanceName
 */
async function outboxEntries(stateRoot, instanceName) {
  const dir = path.join(stateRoot, 'sinks', instanceName, 'outbox')
  return fs.readdir(dir).then((names) => names, () => [])
}

test('a sink whose export result cannot be read is recorded failed, not thrown out of the tick', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    const driver = driverOver(stateRoot, [
      handleReturning('unreadable', () => ({
        get status() { throw new TypeError(`${HOSTILE}: status`) },
      })),
    ])

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.equal(report.sinks.length, 1, 'the tick must still report the sink')
    assert.equal(report.sinks[0].status, 'failed')
    assert.match(String(report.sinks[0].error), /status/, 'the failure names what could not be read')
    assert.equal(
      (await outboxEntries(stateRoot, 'unreadable')).length,
      1,
      'an unreadable answer is a failed batch, so its partitions belong in the outbox',
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// The spread in the summary made *any* own enumerable accessor lethal, not
// only the five fields the driver names.
test('an own enumerable accessor beside the named fields does not reach the summary', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    const driver = driverOver(stateRoot, [
      handleReturning('spread', () => ({
        status: 'exported',
        partitionsExported: 3,
        bytesWritten: 17,
        get extra() { throw new TypeError(`${HOSTILE}: extra`) },
      })),
    ])

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.equal(report.sinks.length, 1)
    assert.equal(report.sinks[0].status, 'exported', 'the readable answer still reports what it said')
    assert.equal(report.sinks[0].partitionsExported, 3)
    assert.equal(report.sinks[0].bytesWritten, 17)
    assert.deepEqual(
      Object.keys(report.sinks[0]).sort(),
      ['bytesWritten', 'error', 'instance', 'partitionsExported', 'status'],
      'the summary carries only the fields the kernel builds',
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('an unreadable sink degrades only itself: the next sink in the tick still exports', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    /** @type {string[]} */
    const exported = []
    const driver = driverOver(stateRoot, [
      handleReturning('unreadable', () => ({
        get status() { throw new TypeError(`${HOSTILE}: status`) },
      })),
      handleReturning('healthy', () => {
        exported.push('healthy')
        return { status: 'exported', partitionsExported: 0, bytesWritten: 0 }
      }),
    ])

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.deepEqual(exported, ['healthy'], 'the sink behind the unreadable one never ran')
    assert.deepEqual(
      report.sinks.map((s) => [s.instance, s.status]),
      [['unreadable', 'failed'], ['healthy', 'exported']],
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// A non-ok answer is read the same way: the retry list and the error message
// used to be read off the plugin's object after the catch closed.
test('a partial answer whose retryPartitions cannot be read is still spooled to the outbox', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    const driver = driverOver(stateRoot, [
      handleReturning('partial', () => ({
        status: 'partial',
        partitionsExported: 1,
        get retryPartitions() { throw new TypeError(`${HOSTILE}: retryPartitions`) },
      })),
    ])

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.equal(report.sinks.length, 1)
    assert.equal(report.sinks[0].status, 'failed', 'an answer that cannot be finished reading is a failure')
    assert.equal((await outboxEntries(stateRoot, 'partial')).length, 1)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// The one place this hardening changes behaviour rather than only containing
// it: `error` is typed `string` in the kernel contract, so a sink that answers
// with anything else no longer has that value carried into the outbox JSON and
// the failure log. An `Error` was the likeliest off-contract answer and the
// worst outcome: `JSON.stringify` renders it `{}`, so the outbox recorded an
// empty object where an operator was looking for a reason.
test('a non-string error is replaced by the kernel sentence, not carried into the outbox', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    const driver = driverOver(stateRoot, [
      handleReturning('objecterror', () => ({
        status: 'failed',
        partitionsExported: 0,
        error: new Error('disk full'),
      })),
    ])

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.equal(report.sinks[0].status, 'failed')
    assert.equal(report.sinks[0].error, undefined, 'the summary carries only a string the kernel checked')
    const names = await outboxEntries(stateRoot, 'objecterror')
    assert.equal(names.length, 1)
    const payload = JSON.parse(
      await fs.readFile(path.join(stateRoot, 'sinks', 'objecterror', 'outbox', names[0]), 'utf8')
    )
    assert.equal(
      payload.error,
      'sink reported non-ok status',
      'the outbox records a readable sentence rather than the {} an Error serializes to',
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})
