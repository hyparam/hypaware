// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runDaemon } from '../../src/core/daemon/runtime.js'
import { readStatusFile } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

// The unit tests next door prove each seam reads a plugin's value inside a
// guard. This one proves what the guard is *for*, on the daemon's own tick:
// the throw was contained as `daemon.tick_failed`, so the daemon went on
// reporting itself healthy while the scheduled backfill sweep never ran again
// and every sink's `lastTickAt` / `lastSuccessAt` stayed frozen at boot (the
// silent capture degradation in #1510).
//
// One fixture plugin carries both hostile values, because either one alone
// used to produce this outcome: the sink tick is awaited before the sweep, and
// the sink-snapshot loop is after both.

const PLUGIN = '@third-party/hostile-values-fixture'
const SINK_INSTANCE = 'hostile'

/**
 * Stage a plugin with three contributions:
 *
 * - a request sink whose `exportBatch` resolves an object with a throwing
 *   accessor (site 1),
 * - a backfill provider whose `sweep` is a throwing accessor (site 2), named
 *   so the registry's sorted `list()` reaches it first,
 * - a backfill provider that really does sweep, and records each run.
 *
 * @param {string} hypHome
 * @param {string} marker
 * @returns {Promise<string>}
 */
async function stageHostilePlugin(hypHome, marker) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', PLUGIN)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name: PLUGIN,
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    provides: { capabilities: { 'hypaware.http-endpoint': '1.0.0' } },
    contributes: { sinks: [{ name: 'hostile', supports: [] }] },
  }))
  await fs.writeFile(
    path.join(installDir, 'index.js'),
    `
import fs from 'node:fs'

export async function activate(ctx) {
  ctx.sinks.register({
    name: 'hostile',
    plugin: '${PLUGIN}',
    supports: [],
    async create() {
      return {
        async exportBatch() {
          return {
            partitionsExported: 0,
            get status() { throw new TypeError('status is not readable') },
          }
        },
        async close() {},
      }
    },
  })
  ctx.backfills.register({
    name: 'a-unreadable-sweep',
    plugin: '${PLUGIN}',
    datasets: ['ai_gateway_messages'],
    get sweep() { throw new TypeError('sweep is not readable') },
    async *run() {},
  })
  ctx.backfills.register({
    name: 'z-sweeping',
    plugin: '${PLUGIN}',
    datasets: ['ai_gateway_messages'],
    sweep: { cron: '* * * * *' },
    async *run() {
      fs.appendFileSync(${JSON.stringify(marker)}, 'swept\\n')
    },
  })
}
`
  )
  return installDir
}

/**
 * @param {string} hypHome
 * @param {string} installDir
 */
async function writeInstall(hypHome, installDir) {
  await writeLock(path.join(hypHome, 'hypaware'), {
    schema_version: 1,
    plugins: {
      [PLUGIN]: {
        name: PLUGIN,
        version: '0.1.0',
        source: { kind: 'local-dir', raw: installDir, path: installDir },
        install_dir: installDir,
        content_hash: 'a'.repeat(64),
        manifest_hash: 'b'.repeat(64),
        installed_at: '2026-09-09T00:00:00.000Z',
      },
    },
  })
  const configPath = defaultConfigPath(hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: PLUGIN, config: {} }],
    sinks: { [SINK_INSTANCE]: { plugin: PLUGIN, config: { schedule: '* * * * *' } } },
  }))
  return configPath
}

test('a tick that cannot read a plugin value still sweeps and still advances the sink snapshots', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hostile-tick-'))
  const marker = path.join(hypHome, 'sweeps.log')
  const stateRoot = path.join(hypHome, 'hypaware')
  let handle
  try {
    const configPath = await writeInstall(hypHome, await stageHostilePlugin(hypHome, marker))
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'hostile-tick',
      tickIntervalMs: 200,
      installSignalHandlers: false,
    })

    const deadline = Date.now() + 20_000
    let swept = false
    let ticked = false
    while (Date.now() < deadline && !(swept && ticked)) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      swept = await fs.readFile(marker, 'utf8').then((t) => t.includes('swept'), () => false)
      const sink = /** @type {any} */ (readStatusFile(stateRoot)?.sinks?.[0])
      ticked = typeof sink?.lastTickAt === 'string'
    }

    assert.ok(swept, 'the scheduled sweep never ran: an unreadable plugin value disabled it')
    const status = /** @type {any} */ (readStatusFile(stateRoot))
    assert.equal(status.state, 'healthy', 'the daemon reports itself healthy either way, which is the point')
    assert.equal(status.sinks[0].instance, SINK_INSTANCE)
    assert.ok(ticked, `sink ${SINK_INSTANCE} never recorded a tick, while hyp status reported the daemon healthy`)
  } finally {
    // The removal is nested inside the shutdown's own finally so a stop that
    // rejects still surfaces and still leaves no temp HYP_HOME behind. This
    // test writes a plugin tree and a whole daemon state root, and the run
    // that would leak one is the failing run nobody is watching.
    try {
      if (handle) {
        await handle.stop()
        await handle.done
      }
    } finally {
      // Sweeps are fired unblocked, so shutdown does not drain them: a run
      // started by the last tick can still be touching the state tree here.
      await new Promise((resolve) => setTimeout(resolve, 100))
      await fs.rm(hypHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})
