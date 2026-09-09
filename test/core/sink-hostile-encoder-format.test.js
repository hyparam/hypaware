// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createSinkDriver } from '../../src/core/sinks/driver.js'

// The encoder on a blob sink handle is the writer plugin's own object, and
// `SinkEncoder.format` is the one field neither `SinkRegistry.instantiate` nor
// the driver validates: the registry threads `args.encoder` onto the handle by
// reference, so the driver's read of `format` is a call into plugin code on
// every tick. It used to sit above `withSpan` and outside every try, so an
// encoder that answers with a throw stopped the whole tick rather than its own
// batch - the daemon swallows that as `daemon.tick_failed`, which freezes every
// sink's `lastTickAt` while `hyp status` still reads healthy (#1514, the shape
// #1510 closed for the export result in this same function).

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
 * A sink handle carrying the given encoder, the shape `instantiate` builds for
 * a writer+destination pair. A handle with no encoder is a request sink.
 *
 * @param {string} instanceName
 * @param {any} encoder
 * @param {(ctx: any) => void} [onExport]
 * @returns {any}
 */
function handleWith(instanceName, encoder, onExport) {
  return {
    instanceName,
    plugin: '@third-party/hostile-destination',
    kind: encoder ? 'blob' : 'request',
    config: { schedule: '* * * * *' },
    encoder,
    sink: {
      async exportBatch(_batch, ctx) {
        onExport?.(ctx)
        return { status: 'exported', partitionsExported: 0, bytesWritten: 0 }
      },
    },
  }
}

async function tmpStateRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-format-'))
}

/**
 * @param {string} stateRoot
 * @param {string} instanceName
 */
async function outboxEntries(stateRoot, instanceName) {
  const dir = path.join(stateRoot, 'sinks', instanceName, 'outbox')
  return fs.readdir(dir).then((names) => names, () => [])
}

test('a sink whose encoder format cannot be read is recorded failed, not thrown out of the tick', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    const driver = driverOver(stateRoot, [
      handleWith('unreadable', { get format() { throw new TypeError(`${HOSTILE}: format`) } }),
    ])

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.equal(report.sinks.length, 1, 'the tick must still report the sink')
    assert.equal(report.sinks[0].status, 'failed')
    assert.match(String(report.sinks[0].error), /format/, 'the failure names what could not be read')
    assert.equal(
      (await outboxEntries(stateRoot, 'unreadable')).length,
      1,
      'a batch that never reached the sink is a failed batch, so its partitions belong in the outbox',
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('an unreadable encoder format degrades only its own sink: the next sink still exports', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    /** @type {string[]} */
    const exported = []
    const driver = driverOver(stateRoot, [
      handleWith('unreadable', { get format() { throw new TypeError(`${HOSTILE}: format`) } }),
      handleWith('healthy', { format: 'parquet' }, () => exported.push('healthy')),
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

test('a readable encoder still hands its format to the sink, and a sink with no encoder still gets native', async () => {
  const stateRoot = await tmpStateRoot()
  try {
    /** @type {unknown[]} */
    const formats = []
    const record = (/** @type {any} */ ctx) => formats.push(ctx.format)
    const driver = driverOver(stateRoot, [
      handleWith('encoded', { format: 'parquet' }, record),
      handleWith('request', undefined, record),
    ])

    const report = await driver.tick({ force: true, now: new Date('2026-09-09T00:00:00.000Z') })

    assert.deepEqual(formats, ['parquet', 'native'])
    assert.deepEqual(report.sinks.map((s) => s.status), ['exported', 'exported'])
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})
