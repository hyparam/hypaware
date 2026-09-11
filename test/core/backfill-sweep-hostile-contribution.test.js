// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createBackfillRegistry } from '../../src/core/registry/backfills.js'
import { createBackfillSweepDriver } from '../../src/core/daemon/backfill_sweep.js'

// `BackfillRegistry.register` validates `name`, `plugin`, `datasets`, `run`
// and `plan`, and stores the contribution by reference. It never reads
// `sweep`, so a provider whose `sweep` is a throwing accessor registers
// cleanly and the sweep's own due-check is the first read of it - inside
// `tick()`, with no guard around the loop. The throw took the daemon tick with
// it, which is a sweep that never runs again for the daemon's life (#1510).

const OK = { ok: true, scanned: 0, rowsWritten: 0, skipped: 0 }

/**
 * A driver over a real `BackfillRegistry` holding the given contributions, so
 * the registration path is the shipped one rather than a fake `list()`.
 *
 * @param {any[]} contributions
 * @param {(args: any) => Promise<any>} runBackfill
 */
function driverOver(contributions, runBackfill) {
  const backfills = createBackfillRegistry()
  for (const contribution of contributions) backfills.register(contribution)
  return createBackfillSweepDriver({
    backfills,
    backfillMaterializers: /** @type {any} */ ({ register() {}, get: () => undefined, list: () => [] }),
    env: /** @type {any} */ ({ HYP_HOME: '/nonexistent-home' }),
    storage: /** @type {any} */ ({ cacheRoot: '/nonexistent-cache' }),
    query: /** @type {any} */ ({ getDataset: () => undefined }),
    runBackfill: /** @type {any} */ (runBackfill),
  })
}

/**
 * A contribution whose `sweep` cannot be read. Nothing here may copy it into
 * another object: a spread is itself one of the reads under test.
 *
 * @returns {any}
 */
function unreadableSweep() {
  return {
    name: 'a-unreadable',
    plugin: '@third-party/unreadable-sweep',
    datasets: ['ai_gateway_messages'],
    async *run() {},
    get sweep() { throw new TypeError('sweep is not readable') },
  }
}

/**
 * @param {string} cron
 * @returns {any}
 */
function readableSweep(cron) {
  return {
    // `list()` sorts by name, so this one sits behind the unreadable one and
    // is what the old throw skipped.
    name: 'z-readable',
    plugin: '@third-party/readable-sweep',
    datasets: ['ai_gateway_messages'],
    async *run() {},
    sweep: { cron },
  }
}

test('a contribution whose sweep cannot be read registers, and does not take the tick down', async () => {
  const driver = driverOver([unreadableSweep()], async () => OK)

  const report = await driver.tick({ now: new Date('2026-09-09T10:05:00.000Z') })

  assert.deepEqual(report.fired, [], 'a provider whose schedule cannot be read is not due')
})

test('an unreadable sweep degrades only itself: the providers behind it are still evaluated', async () => {
  /** @type {string[]} */
  const ran = []
  const driver = driverOver(
    [unreadableSweep(), readableSweep('*/5 * * * *')],
    async (args) => { ran.push(args.provider); return OK }
  )

  const report = await driver.tick({ now: new Date('2026-09-09T10:05:00.000Z') })

  assert.deepEqual(report.fired, ['z-readable'])
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.deepEqual(ran, ['z-readable'], 'the due provider behind the unreadable one never ran')
})

test('force does not read an unreadable sweep either', async () => {
  // `force` skips the cron comparison, but the sweep field is still what says
  // the provider opted in at all.
  const driver = driverOver([unreadableSweep(), readableSweep('0 0 1 1 *')], async () => OK)

  const report = await driver.tick({ now: new Date('2026-09-09T10:07:00.000Z'), force: true })

  assert.deepEqual(report.fired, ['z-readable'])
})

test('a sweep object whose cron cannot be read is skipped, not fired on every tick', async () => {
  /** @type {string[]} */
  const ran = []
  const driver = driverOver(
    [{
      name: 'unreadable-cron',
      plugin: '@third-party/unreadable-cron',
      datasets: ['ai_gateway_messages'],
      async *run() {},
      sweep: { get cron() { throw new TypeError('cron is not readable') } },
    }],
    async (args) => { ran.push(args.provider); return OK }
  )

  const report = await driver.tick({ now: new Date('2026-09-09T10:05:00.000Z') })

  assert.deepEqual(report.fired, [])
  assert.deepEqual(ran, [])
})
