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

/**
 * @import { PluginLockEntry } from '../../hypaware-plugin-kernel-types.js'
 */

// The unit tests next door prove the registry orders `listDatasets()` by its
// own keys and the driver names a dataset from a string it holds. This one
// proves what that is for, on the daemon's own tick: the sink driver calls
// `listDatasets()` before every batch, so a dataset whose `name` cannot be read
// threw from inside the comparator, before the first sink had been reached. The
// daemon contained it as `daemon.tick_failed`, so it went on reporting itself
// healthy while no sink exported again and every `lastTickAt` stayed frozen at
// boot - the silent export failure in #1524, and in #1505, #1509, #1510 and
// #1514 before it.
//
// One fixture plugin contributes all three parts: a dataset whose `name`
// accessor starts throwing as soon as it is registered, a second readable
// dataset (a one-element sort never calls its comparator, which is part of why
// this stayed latent), and a request sink that records every export it is asked
// for.

const FIXTURE = '@third-party/hostile-dataset-fixture'

/**
 * @param {string} hypHome
 * @param {string} marker
 * @returns {Promise<string>}
 */
async function stageFixture(hypHome, marker) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', FIXTURE)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name: FIXTURE,
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    provides: { capabilities: { 'hypaware.http-endpoint': '1.0.0' } },
    contributes: {
      datasets: [{ name: 'a_hostile' }, { name: 'z_readable' }],
      sinks: [{ name: 'fixture', supports: [] }],
    },
  }))
  await fs.writeFile(path.join(installDir, 'index.js'), `
import fs from 'node:fs'

export async function activate(ctx) {
  let armed = false
  ctx.query.registerDataset({
    get name() {
      if (armed) throw new TypeError('name is not readable')
      return 'a_hostile'
    },
    plugin: ${JSON.stringify(FIXTURE)},
    schema: { columns: [{ name: 'ts', type: 'TIMESTAMP', nullable: false }] },
    discoverPartitions() { return [] },
    createDataSource() { return {} },
  })
  armed = true
  ctx.query.registerDataset({
    name: 'z_readable',
    plugin: ${JSON.stringify(FIXTURE)},
    schema: { columns: [{ name: 'ts', type: 'TIMESTAMP', nullable: false }] },
    discoverPartitions() { return [] },
    createDataSource() { return {} },
  })
  ctx.sinks.register({
    name: 'fixture',
    plugin: ${JSON.stringify(FIXTURE)},
    supports: [],
    async create(sinkCtx) {
      return {
        async exportBatch() {
          fs.appendFileSync(${JSON.stringify(marker)}, sinkCtx.name + '\\n')
          return { status: 'exported', partitionsExported: 0, bytesWritten: 0 }
        },
        async close() {},
      }
    },
  })
}
`)
  return installDir
}

/**
 * @param {string} hypHome
 * @param {string} installDir
 */
async function writeInstall(hypHome, installDir) {
  /** @type {Record<string, PluginLockEntry>} */
  const plugins = {
    [FIXTURE]: {
      name: FIXTURE,
      version: '0.1.0',
      source: { kind: 'local-dir', raw: installDir, path: installDir },
      install_dir: installDir,
      content_hash: 'a'.repeat(64),
      manifest_hash: 'b'.repeat(64),
      installed_at: '2026-09-09T00:00:00.000Z',
    },
  }
  await writeLock(path.join(hypHome, 'hypaware'), { schema_version: 1, plugins })
  const configPath = defaultConfigPath(hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: FIXTURE, config: {} }],
    sinks: {
      'z-healthy': { plugin: FIXTURE, config: { schedule: '* * * * *' } },
    },
  }))
  return configPath
}

test('a tick that cannot read a dataset name still exports the sinks and still advances the snapshots', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hostile-dataset-'))
  const marker = path.join(hypHome, 'exports.log')
  const stateRoot = path.join(hypHome, 'hypaware')
  let handle
  try {
    const configPath = await writeInstall(hypHome, await stageFixture(hypHome, marker))
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'hostile-dataset-tick',
      tickIntervalMs: 200,
      installSignalHandlers: false,
    })

    const deadline = Date.now() + 20_000
    let exported = false
    let ticked = false
    while (Date.now() < deadline && !(exported && ticked)) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      exported = await fs.readFile(marker, 'utf8').then((t) => t.includes('z-healthy'), () => false)
      const snaps = /** @type {any[]} */ (readStatusFile(stateRoot)?.sinks ?? [])
      ticked = snaps.some((s) => s.instance === 'z-healthy' && typeof s.lastTickAt === 'string')
    }

    const status = /** @type {any} */ (readStatusFile(stateRoot))
    assert.deepEqual(
      { exported, ticked, state: status.state },
      { exported: true, ticked: true, state: 'healthy' },
      'the daemon reports itself healthy either way, which is the point: a dataset whose name '
        + 'cannot be read must not stop the sink behind it from exporting and recording a tick',
    )
  } finally {
    try {
      if (handle) {
        await handle.stop()
        await handle.done
      }
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await fs.rm(hypHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})
