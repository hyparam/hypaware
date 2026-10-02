// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runDaemon } from '../../src/core/daemon/runtime.js'
import { collectHypAwareStatus, readStatusFile, writeStatusFile } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

// Issue #2359 / LLP 0453. The recovered `lastSuccessAt` is the fixed point the
// export warning is defined against, and the daemon's first status write lands
// before any plugin activates. So a boot that never registered the destination
// (the plugin is missing, its activation threw, or its sink did not
// materialize) wrote `sinks: []` twice over: once before activation and once
// from the live handles, of which there were none. The stamp was gone from
// disk, the next boot recovered nothing, and the destination read as
// never-succeeded, warning about an outbox file its recorded success had
// already answered, with no way back: the success that would clear it cannot
// happen while the sink stays unregistered.
//
// Retention is scoped to the destinations the boot's own config still names,
// which is also why it cannot re-arm the warning issue #2361 silenced: that
// warning is gated on the configured set, so a destination no `sinks` key
// names is retained by nothing here.

const PLUGIN = '@third-party/stamp-sink-fixture'
const SINK = 'central'

/**
 * A plugin contributing one request sink. `activate` throws while the break
 * marker exists, which is how a boot ends up with the destination configured
 * and nothing registered.
 *
 * @param {string} hypHome
 * @param {string} breakMarker
 * @returns {Promise<string>}
 */
async function stageSinkPlugin(hypHome, breakMarker) {
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
    contributes: { sinks: [{ name: 'stamp', supports: [] }] },
  }))
  await fs.writeFile(path.join(installDir, 'index.js'), `
import fs from 'node:fs'

export async function activate(ctx) {
  if (fs.existsSync(${JSON.stringify(breakMarker)})) {
    throw new Error('sink plugin failed to activate')
  }
  ctx.sinks.register({
    name: 'stamp',
    plugin: '${PLUGIN}',
    supports: [],
    async create() {
      return {
        async exportBatch() { return { status: 'exported', partitionsExported: 0 } },
        async close() {},
      }
    },
  })
}
`)
  return installDir
}

/**
 * A whole install: the staged plugin, its lock entry, a config naming the
 * destination (or not), a prior daemon's status file carrying the stamp, and
 * one failed export batch recorded strictly before that success.
 *
 * @param {{ prefix: string, configureSink: boolean, breakActivation: boolean }} args
 */
async function stageInstall({ prefix, configureSink, breakActivation }) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const stateRoot = path.join(hypHome, 'hypaware')
  const breakMarker = path.join(hypHome, 'break-activation')
  const installDir = await stageSinkPlugin(hypHome, breakMarker)
  if (breakActivation) await fs.writeFile(breakMarker, '1')
  await writeLock(stateRoot, {
    schema_version: 1,
    plugins: {
      [PLUGIN]: {
        name: PLUGIN,
        version: '0.1.0',
        source: { kind: 'local-dir', raw: installDir, path: installDir },
        install_dir: installDir,
        content_hash: 'a'.repeat(64),
        manifest_hash: 'b'.repeat(64),
        installed_at: '2026-09-29T00:00:00.000Z',
      },
    },
  })
  const configPath = defaultConfigPath(hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: PLUGIN, config: {} }],
    ...(configureSink ? { sinks: { [SINK]: { plugin: PLUGIN, config: { schedule: '0 0 * * *' } } } } : {}),
  }))

  // The failure is an hour old and the success half an hour old, so the
  // recorded success is strictly later: with the stamp on disk this
  // destination holds nothing unanswered, and without it the same file is an
  // unanswered failure.
  const nowMs = Date.now()
  const failedAt = new Date(nowMs - 60 * 60_000).toISOString()
  const succeededAt = new Date(nowMs - 30 * 60_000).toISOString()
  const outbox = path.join(stateRoot, 'sinks', SINK, 'outbox')
  await fs.mkdir(outbox, { recursive: true })
  await fs.writeFile(path.join(outbox, `${SINK}-${failedAt}-0.json`), JSON.stringify({ error: 'fetch failed' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'stopped',
    pid: 4242,
    startedAt: failedAt,
    uptimeMs: 1000,
    runId: 'prior',
    mode: 'detached',
    sources: [],
    sinks: [{ instance: SINK, plugin: PLUGIN, kind: 'request', lastTickAt: succeededAt, lastSuccessAt: succeededAt }],
  }))

  return { hypHome, stateRoot, configPath, succeededAt }
}

/**
 * Boot the daemon over a staged install, with its shutdown and the temp home's
 * removal registered first: the run that would leak a daemon and a whole state
 * tree is the failing run nobody is watching.
 *
 * @param {import('node:test').TestContext} t
 * @param {Awaited<ReturnType<typeof stageInstall>>} staged
 * @param {string} runId
 */
async function bootStaged(t, staged, runId) {
  /** @type {Awaited<ReturnType<typeof runDaemon>> | undefined} */
  let handle
  t.after(async () => {
    try {
      if (handle) {
        await handle.stop()
        await handle.done
      }
    } finally {
      await fs.rm(staged.hypHome, { recursive: true, force: true })
    }
  })
  handle = await runDaemon({
    hypHome: staged.hypHome,
    configPath: staged.configPath,
    env: { ...process.env, HYP_HOME: staged.hypHome },
    runId,
    // No tick loop: the boot snapshot is the only thing written to disk, so
    // nothing but the boot can account for what the file holds afterwards.
    tickIntervalMs: 0,
    installSignalHandlers: false,
  })
  const status = /** @type {any} */ (readStatusFile(staged.stateRoot))
  assert.equal(status.runId, runId, 'ground truth: this boot wrote the file being read')
  return status
}

/**
 * The messages `hyp status` would print for unresolved export failures, and
 * the destinations it renders as the install's shape.
 *
 * @param {string} hypHome
 */
async function exportWarnings(hypHome) {
  const report = await collectHypAwareStatus({
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    // Stub the launch-agent probe so the developer's own installed daemon
    // cannot leak into the report.
    isLaunchAgentInstalled: () => false,
  })
  return {
    warnings: report.diagnostics.filter((d) => d.kind === 'sink_export_failing').map((d) => d.message),
    sinks: report.sinks.map((s) => s.instance),
  }
}

// @ref LLP 0453#warning-rule [tests]: the daemon carries the stamp across its own restarts, a restart that registers nothing included
test('a boot that registers no sink keeps the configured destination\'s recovered stamp, and it still does not warn', async (t) => {
  const staged = await stageInstall({
    prefix: 'hyp-sink-stamp-unregistered-',
    configureSink: true,
    breakActivation: true,
  })
  assert.deepEqual(
    (await exportWarnings(staged.hypHome)).warnings,
    [],
    'ground truth: the seeded stamp answers the seeded failure',
  )

  const status = await bootStaged(t, staged, 'stamp-unregistered')
  const after = await exportWarnings(staged.hypHome)
  assert.deepEqual(after.sinks, [SINK], 'the destination is still configured')
  // Both halves in one assertion, so an unfixed run reports the erased row and
  // the warning it causes together instead of stopping at the first of them.
  assert.deepEqual({ sinks: status.sinks, exportWarnings: after.warnings }, {
    // `plugin` and `kind` are blank because nothing live backs the row:
    // `recoverSinkSnapshots` carries the stamp and nothing else.
    sinks: [{ instance: SINK, plugin: '', kind: '', lastSuccessAt: staged.succeededAt }],
    exportWarnings: [],
  }, 'the boot wrote the recovered stamp back, and the answered failure stayed answered')
})

// The other half of the same write: a boot that does register the destination
// is exactly what it was, one row carrying the stamp with the live plugin and
// kind filled in, and no duplicate from the retention pass.
// @ref LLP 0453#warning-rule [tests]: a boot that registers the destination rebuilds its row from the live handle
test('a boot that does register the sink still rebuilds the row from its live handle', async (t) => {
  const staged = await stageInstall({
    prefix: 'hyp-sink-stamp-registered-',
    configureSink: true,
    breakActivation: false,
  })
  const status = await bootStaged(t, staged, 'stamp-registered')
  assert.deepEqual(status.sinks, [
    { instance: SINK, plugin: PLUGIN, kind: 'request', lastSuccessAt: staged.succeededAt },
  ], 'one row, live metadata, recovered stamp, and `lastTickAt` dropped')
  assert.deepEqual((await exportWarnings(staged.hypHome)).warnings, [])
})

// Deleting the whole `sinks` key is still a removal (issue #2361): the row is
// not retained, so it cannot accumulate across boots, and the warning stays
// silent on both sides of this change. The gate that silences it reads the
// configured set, never the presence of a recovered row.
// @ref LLP 0453#warning-rule [tests]: a destination outside the configured set keeps nothing and raises nothing
test('a boot whose config no longer names the destination drops its row and still raises no warning', async (t) => {
  const staged = await stageInstall({
    prefix: 'hyp-sink-stamp-removed-',
    configureSink: false,
    breakActivation: false,
  })
  const status = await bootStaged(t, staged, 'stamp-removed')
  assert.deepEqual(status.sinks, [], 'a destination the operator removed keeps no row')
  const after = await exportWarnings(staged.hypHome)
  assert.deepEqual(after.sinks, [], 'and nothing is left to render as the install\'s shape')
  assert.deepEqual(after.warnings, [], 'a destination the operator removed raises no export warning')
})
