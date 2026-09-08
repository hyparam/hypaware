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

// The tick path takes a source's `status()` answer apart inside the probe's
// own try and returns only kernel-built values. Boot handed the plugin's raw
// answer back to `startConfiguredSources`, which read `details` off it and
// passed it to `sourceHealth` (four more reads): plugin code running outside a
// try on the already-started branch, and inside the per-source start `try` on
// the other, where a throw is read as a source that failed to start (#1504).
//
// @ref LLP 0394#health-rides-beside-state [tests]: a boot probe whose answer cannot be read leaves the source started, not failed

const PLUGIN = '@third-party/unreadable-boot-status'
const SOURCE = 'unreadable-boot-fixture'

/**
 * Stage a plugin whose source answers `status()` with an object that throws on
 * property access. `lastError` is the last of the four fields `sourceHealth`
 * reads, so reaching the throw also proves the other three were read.
 *
 * `autoStart` reproduces `@hypaware/otel`, which starts its own source inside
 * `activate()`: the source is then already started when
 * `startConfiguredSources` runs, and the already-started branch is taken.
 *
 * @param {string} hypHome
 * @param {boolean} autoStart
 * @returns {Promise<string>}
 */
async function stageUnreadableStatusPlugin(hypHome, autoStart) {
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
export async function activate(ctx) {
  ctx.sources.register({
    name: '${SOURCE}',
    plugin: '${PLUGIN}',
    async start() {
      return {
        async status() {
          return {
            state: 'ready',
            details: { probes: 1 },
            get lastError() { throw new TypeError('lastError is not readable') },
          }
        },
        async stop() {},
      }
    },
  })
  ${autoStart ? `await ctx.sources.start('${SOURCE}', ctx)` : ''}
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
        installed_at: '2026-09-08T00:00:00.000Z',
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

/**
 * @param {string} prefix
 * @param {boolean} autoStart
 */
async function bootWith(prefix, autoStart) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    const configPath = await writeInstall(hypHome, await stageUnreadableStatusPlugin(hypHome, autoStart))
    const handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: prefix,
      // No tick loop: the boot snapshot is the only thing written to disk.
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })
    return { hypHome, handle, stateRoot: path.join(hypHome, 'hypaware') }
  } catch (err) {
    // The regression this file guards is a boot that throws, so the failing
    // run is the expected one: it must not be the run that leaves the temp
    // home behind, because the caller has no handle to clean up with.
    await fs.rm(hypHome, { recursive: true, force: true })
    throw err
  }
}

test('a source already started in activate() whose status answer cannot be read does not abort boot', async () => {
  let booted
  try {
    booted = await bootWith('hypaware-boot-status-existing-', true)

    const snapshot = /** @type {any} */ (readStatusFile(booted.stateRoot)?.sources?.[0])
    assert.ok(snapshot, 'boot wrote no source snapshot')
    assert.equal(snapshot.name, SOURCE)
    assert.equal(snapshot.state, 'started', 'the source did start, and boot must say so')
    assert.equal(snapshot.health, undefined, 'nothing usable was read, so nothing is recorded')

    // Recording nothing must not mean saying nothing.
    const log = await fs.readFile(path.join(booted.stateRoot, 'logs', 'daemon.log'), 'utf8')
    assert.match(log, /daemon\.source_status_failed/, 'an unreadable boot probe went unreported')
  } finally {
    if (booted) {
      await booted.handle.stop()
      await booted.handle.done
      await fs.rm(booted.hypHome, { recursive: true, force: true })
    }
  }
})

test('a source the daemon starts itself is not mislabelled failed when its status answer cannot be read', async () => {
  let booted
  try {
    booted = await bootWith('hypaware-boot-status-fresh-', false)

    const snapshot = /** @type {any} */ (readStatusFile(booted.stateRoot)?.sources?.[0])
    assert.ok(snapshot, 'boot wrote no source snapshot')
    assert.equal(snapshot.name, SOURCE)
    // The source started. A probe that could not be read says nothing about
    // that, and a `failed` here is skipped by every tick for the daemon's life.
    assert.equal(snapshot.state, 'started', 'a running source was recorded as failed')
    assert.equal(snapshot.error, undefined, 'and no start error was invented for it')
  } finally {
    if (booted) {
      await booted.handle.stop()
      await booted.handle.done
      await fs.rm(booted.hypHome, { recursive: true, force: true })
    }
  }
})
