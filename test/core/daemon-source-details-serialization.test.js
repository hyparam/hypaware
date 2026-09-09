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

// `SourceStatus.details` is free-form by contract, and the daemon recorded the
// plugin's own object: the probe read the reference without walking the tree,
// so a getter nested inside it did not fire until `persist()` reached
// `JSON.stringify`, which sits on no guard at all. Boot threw there outright;
// on the tick the throw was an unhandled rejection, which freezes the status
// file and takes the daemon process with it while `hyp status` goes on
// reporting the boot-time snapshot as healthy (#1505).
//
// The fixture arms its throwing getter through a global rather than throwing
// from the first read, because the two halves need opposite timings: the tick
// half can only show the file freezing if boot recorded a good value first.
// `runDaemon` boots in this process, so the fixture and the test share a
// `globalThis`.
//
// @ref LLP 0394#health-rides-beside-state [tests]: a probe whose details cannot be read records nothing and leaves the last good value in place

const PLUGIN = '@third-party/details-serialization'
const SOURCE = 'details-fixture'

/** The fixture's getter throws while this global is set, and not before. */
const ARMED = '__hypawareDetailsGetterArmed'

/** What the fixture reports while its getter is disarmed. */
const READABLE_DETAILS = { probes: 1, nested: { lazy: 'readable' } }

/**
 * Stage a plugin whose source reports a `details` carrying a nested accessor.
 * Nested rather than top level because the top level is the one part of
 * `details` a caller could plausibly touch by hand: only the serializer walks
 * the whole tree.
 *
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function stageDetailsPlugin(hypHome) {
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
            details: {
              probes: 1,
              nested: {
                get lazy() {
                  if (globalThis['${ARMED}']) throw new TypeError('details.nested.lazy is not readable')
                  return 'readable'
                },
              },
            },
          }
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
        installed_at: '2026-09-09T00:00:00.000Z',
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
 * @param {number} tickIntervalMs
 */
async function bootWith(prefix, tickIntervalMs) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    const configPath = await writeInstall(hypHome, await stageDetailsPlugin(hypHome))
    const handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: prefix,
      tickIntervalMs,
      installSignalHandlers: false,
    })
    return { hypHome, handle, stateRoot: path.join(hypHome, 'hypaware') }
  } catch (err) {
    // One half of this regression is a boot that throws, so the failing run is
    // the expected one: it must not also be the run that leaves a temp home
    // behind, because the caller has no handle to clean up with.
    await fs.rm(hypHome, { recursive: true, force: true })
    throw err
  }
}

/**
 * @param {Awaited<ReturnType<typeof bootWith>>} booted
 */
async function closeBoot(booted) {
  try {
    await booted.handle.stop()
    await booted.handle.done
  } finally {
    await fs.rm(booted.hypHome, { recursive: true, force: true })
  }
}

test('a source whose details cannot be serialized does not abort daemon boot', async (t) => {
  // Armed before the first probe, so boot has nothing readable to record.
  globalThis[ARMED] = true
  t.after(() => { delete globalThis[ARMED] })
  let booted
  try {
    booted = await bootWith('hypaware-details-boot-', 0)

    const status = /** @type {any} */ (readStatusFile(booted.stateRoot))
    const snapshot = status?.sources?.[0]
    assert.ok(snapshot, 'boot wrote no source snapshot')
    assert.equal(snapshot.name, SOURCE)
    assert.equal(snapshot.state, 'started', 'the source did start, and boot must say so')
    assert.equal(snapshot.details, undefined, 'nothing readable arrived, so nothing is recorded')

    const log = await fs.readFile(path.join(booted.stateRoot, 'logs', 'daemon.log'), 'utf8')
    assert.match(log, /daemon\.source_status_failed/, 'an unreadable boot probe went unreported')
  } finally {
    if (booted) await closeBoot(booted)
  }
})

test('the tick keeps writing the status file when a source stops being able to report its details', async (t) => {
  t.after(() => { delete globalThis[ARMED] })
  const booted = await bootWith('hypaware-details-tick-', 200)
  try {
    const settled = /** @type {any} */ (readStatusFile(booted.stateRoot))
    assert.deepEqual(settled.sources[0].details, READABLE_DETAILS, 'boot recorded no readable details to freeze at')

    // From here the source can no longer report a readable `details`. The
    // daemon must go on ticking: this is the whole user-visible symptom, since
    // `hyp status` reads exactly this file and has no other way to know.
    globalThis[ARMED] = true
    const before = settled.uptimeMs
    const deadline = Date.now() + 20_000
    let after = before
    while (Date.now() < deadline && !(after > before)) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      after = /** @type {any} */ (readStatusFile(booted.stateRoot))?.uptimeMs
    }
    assert.ok(
      after > before,
      `the status file stopped being written (uptimeMs stuck at ${before}) while the daemon kept running`
    )

    const status = /** @type {any} */ (readStatusFile(booted.stateRoot))
    assert.equal(status.state, 'healthy')
    assert.deepEqual(
      status.sources[0].details,
      READABLE_DETAILS,
      'a probe that could not be read must leave the last good details alone'
    )
    const log = await fs.readFile(path.join(booted.stateRoot, 'logs', 'daemon.log'), 'utf8')
    assert.match(log, /daemon\.source_status_failed/, 'an unreadable probe went unreported')
  } finally {
    // Stopped with the getter still armed: the shutdown refresh and the
    // `stopping` persist run the same path the tick does.
    await closeBoot(booted)
  }
})
