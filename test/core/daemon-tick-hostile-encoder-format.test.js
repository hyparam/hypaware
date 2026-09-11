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

// The unit tests next door prove the driver reads the encoder's `format`
// inside its guard. This one proves what the guard is for, on the daemon's own
// tick: the throw was contained as `daemon.tick_failed`, so the daemon went on
// reporting itself healthy while no sink exported again and every sink's
// `lastTickAt` stayed frozen at boot (the silent export failure in #1514).
//
// Two sink instances, named so the registry's sorted `listHandles()` reaches
// the hostile one first: `a-hostile` is a blob sink whose writer's encoder
// cannot be read, `z-healthy` is a request sink that records every export.

const WRITER = '@third-party/hostile-encoder-fixture'
const DESTINATION = '@third-party/sink-destination-fixture'

/**
 * @param {string} hypHome
 * @param {string} name
 * @param {Record<string, unknown>} manifest
 * @param {string} source
 * @returns {Promise<string>}
 */
async function stagePlugin(hypHome, name, manifest, source) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', name)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name,
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    ...manifest,
  }))
  await fs.writeFile(path.join(installDir, 'index.js'), source)
  return installDir
}

/**
 * The writer: an encoder capability whose `format` is a throwing accessor. Its
 * `supports` is honest, which is all `instantiate` reads, so the sink instance
 * materializes and registers as a real writer+destination pair would.
 *
 * @param {string} hypHome
 */
function stageWriter(hypHome) {
  return stagePlugin(hypHome, WRITER, {
    provides: { capabilities: { 'hypaware.encoder': '1.0.0' } },
    requires: { capabilities: { 'hypaware.blob-store': '^1.0.0' } },
  }, `
export async function activate(ctx) {
  ctx.provideCapability('hypaware.encoder', '1.0.0', {
    get format() { throw new TypeError('format is not readable') },
    supports: [],
  })
}
`)
}

/**
 * The destination: one sink contribution, used by both instances, whose
 * `exportBatch` records the instance it ran for.
 *
 * @param {string} hypHome
 * @param {string} marker
 */
function stageDestination(hypHome, marker) {
  return stagePlugin(hypHome, DESTINATION, {
    provides: {
      capabilities: { 'hypaware.blob-store': '1.0.0', 'hypaware.http-endpoint': '1.0.0' },
    },
    contributes: { sinks: [{ name: 'fixture', supports: [] }] },
  }, `
import fs from 'node:fs'

export async function activate(ctx) {
  ctx.provideCapability('hypaware.blob-store', '1.0.0', { async putObject() {} })
  ctx.sinks.register({
    name: 'fixture',
    plugin: '${DESTINATION}',
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
}

/**
 * @param {string} hypHome
 * @param {Record<string, string>} installDirs
 */
async function writeInstall(hypHome, installDirs) {
  /** @type {Record<string, PluginLockEntry>} */
  const plugins = {}
  for (const [name, installDir] of Object.entries(installDirs)) {
    plugins[name] = {
      name,
      version: '0.1.0',
      source: { kind: 'local-dir', raw: installDir, path: installDir },
      install_dir: installDir,
      content_hash: 'a'.repeat(64),
      manifest_hash: 'b'.repeat(64),
      installed_at: '2026-09-09T00:00:00.000Z',
    }
  }
  await writeLock(path.join(hypHome, 'hypaware'), { schema_version: 1, plugins })
  const configPath = defaultConfigPath(hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: WRITER, config: {} }, { name: DESTINATION, config: {} }],
    sinks: {
      'a-hostile': {
        writer: WRITER,
        destination: DESTINATION,
        config: { schedule: '* * * * *' },
      },
      'z-healthy': { plugin: DESTINATION, config: { schedule: '* * * * *' } },
    },
  }))
  return configPath
}

test('a tick that cannot read a sink encoder still exports the other sinks and still advances the snapshots', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hostile-format-'))
  const marker = path.join(hypHome, 'exports.log')
  const stateRoot = path.join(hypHome, 'hypaware')
  let handle
  try {
    const configPath = await writeInstall(hypHome, {
      [WRITER]: await stageWriter(hypHome),
      [DESTINATION]: await stageDestination(hypHome, marker),
    })
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'hostile-format-tick',
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
      ticked = snaps.some((s) => s.instance === 'a-hostile' && typeof s.lastTickAt === 'string')
    }

    const status = /** @type {any} */ (readStatusFile(stateRoot))
    assert.deepEqual(
      { exported, hostileTicked: ticked, state: status.state },
      { exported: true, hostileTicked: true, state: 'healthy' },
      'the daemon reports itself healthy either way, which is the point: the sink behind the '
        + 'unreadable encoder must still export, and the unreadable one must still record a tick',
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
