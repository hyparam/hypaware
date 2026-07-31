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

// Boot wrote each source's `status()` details exactly once, which was enough
// while every detail was fixed at bind time. It is not enough for details that
// accrue as traffic flows: the gateway's `recent_entrypoints` would be frozen
// at "nothing seen yet" for the daemon's whole life, and `hyp status` reads
// exactly this file.
// @ref LLP 0164#status-reads-it-from-the-status-file [tests]:

const PLUGIN = '@third-party/accruing-fixture'

/**
 * Stage a plugin whose source's `status()` details change on every call, the
 * way the gateway's do as exchanges land.
 *
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function stageAccruingPlugin(hypHome) {
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
    name: 'accruing-fixture',
    plugin: '${PLUGIN}',
    async start() {
      let probes = 0
      return {
        async status() {
          probes += 1
          return { state: 'ready', details: { probes, seen: probes > 1 ? ['late-arrival'] : [] } }
        },
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

test('the daemon refreshes source details on every tick, so accruing details reach status.json', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-source-details-tick-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  let handle
  try {
    const configPath = await writeInstall(hypHome, await stageAccruingPlugin(hypHome))
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'source-details-tick',
      // The floor the daemon clamps to, so a tick lands inside the wait below.
      tickIntervalMs: 1,
      installSignalHandlers: false,
    })

    const atBoot = readStatusFile(stateRoot)
    assert.ok(atBoot)
    assert.deepEqual(atBoot.sources[0].details, { probes: 1, seen: [] })

    const deadline = Date.now() + 20_000
    /** @type {any} */
    let details
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const snapshot = readStatusFile(stateRoot)
      details = snapshot?.sources?.[0]?.details
      if (details && /** @type {any} */ (details).probes > 1) break
    }
    assert.ok(details, 'no source snapshot on disk')
    assert.ok(details.probes > 1, `source details never refreshed (probes=${details.probes})`)
    assert.deepEqual(details.seen, ['late-arrival'])
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a daemon that never reached a tick still refreshes source details before it stops', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-source-details-stop-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  let handle
  try {
    const configPath = await writeInstall(hypHome, await stageAccruingPlugin(hypHome))
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'source-details-stop',
      // No tick loop at all: the shutdown refresh is the only chance.
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })

    await handle.stop()
    await handle.done
    handle = undefined

    const final = readStatusFile(stateRoot)
    assert.ok(final)
    assert.deepEqual(final.sources[0].details, { probes: 2, seen: ['late-arrival'] })
    // Liveness is still the lifecycle's business, not the probe's.
    assert.equal(final.sources[0].state, 'stopped')
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
