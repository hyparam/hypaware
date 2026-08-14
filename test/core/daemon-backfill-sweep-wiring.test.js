// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runDaemon } from '../../src/core/daemon/runtime.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

// The unit tests next door prove the driver's due-check and containment. This
// one proves the part no unit test can: that the daemon's own tick actually
// calls it. The sweep rides the sink tick rather than owning a timer, so a
// wiring regression here is silent - the driver still passes every test it has
// and simply never runs.
// @ref LLP 0172#lane-b-sweep [tests]: the sweep is called from `runTick()`, on the existing tick interval, with no timer of its own

const PLUGIN = '@third-party/sweeping-fixture'

/**
 * Stage a plugin whose backfill contribution opts into a once-a-minute sweep
 * and records each run by appending to a file. It yields nothing, so the run
 * exercises the runner's full lifecycle without needing a materializer or a
 * writable dataset.
 *
 * @param {string} hypHome
 * @param {string} marker
 * @returns {Promise<string>}
 */
async function stageSweepingPlugin(hypHome, marker) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', PLUGIN)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name: PLUGIN,
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }))
  await fs.writeFile(
    path.join(installDir, 'index.js'),
    `
import fs from 'node:fs'

export async function activate(ctx) {
  ctx.backfills.register({
    name: 'sweeping-fixture',
    plugin: '${PLUGIN}',
    datasets: ['ai_gateway_messages'],
    sweep: { cron: '* * * * *' },
    async *run() {
      fs.appendFileSync(${JSON.stringify(marker)}, 'swept\\n')
    },
  })
  ctx.sources.register({
    name: 'sweeping-fixture',
    plugin: '${PLUGIN}',
    async start() {
      return {
        async status() { return { state: 'ready', details: {} } },
        async stop() {},
      }
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
        installed_at: '2026-07-30T00:00:00.000Z',
      },
    },
  })
  const configPath = defaultConfigPath(hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: PLUGIN, config: {} }],
  }))
  return configPath
}

test('the daemon tick runs a sweep-bearing backfill contribution', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-sweep-tick-'))
  const marker = path.join(hypHome, 'sweeps.log')
  let handle
  try {
    const configPath = await writeInstall(hypHome, await stageSweepingPlugin(hypHome, marker))
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'sweep-tick',
      // Fast enough that a tick lands inside the wait below, slow enough that
      // the poll sees the first sweep rather than a dozen piled-up ones.
      tickIntervalMs: 200,
      installSignalHandlers: false,
    })

    const deadline = Date.now() + 20_000
    let swept = false
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      swept = await fs.readFile(marker, 'utf8').then((t) => t.includes('swept'), () => false)
      if (swept) break
    }
    assert.ok(swept, 'the daemon tick never ran the sweep-bearing provider')
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    // Sweeps are fired unblocked, so shutdown does not drain them: a run
    // started by the last tick can still be touching the state tree here.
    // Retry the teardown rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await fs.rm(hypHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
