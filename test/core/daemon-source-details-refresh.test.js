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

// The kernel contract publishes `state`, `message`, `rowsWritten` and
// `lastError` beside `details`, and the daemon kept only `details`: a source
// could report a failure faithfully on every tick and no operator surface
// would ever show it (issue #1490).
// @ref LLP 0394#health-rides-beside-state [tests]: what the source says about itself reaches the status file, and stops being said when it stops being true

/**
 * Stage a plugin whose source reports itself degraded with a `lastError` on
 * the first probe, and healthy on every one after it.
 *
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function stageReportingPlugin(hypHome) {
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
          if (probes === 1) {
            return {
              state: 'degraded',
              message: 'x'.repeat(5000),
              rowsWritten: 7,
              lastError: 'upstream returned 503',
              details: { probes },
            }
          }
          return { state: 'ready', rowsWritten: 8, details: { probes } }
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

test('a source that reports a failure has it recorded, and cleared once it stops reporting it', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-source-health-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  let handle
  try {
    const configPath = await writeInstall(hypHome, await stageReportingPlugin(hypHome))
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'source-health',
      tickIntervalMs: 1,
      installSignalHandlers: false,
    })

    const atBoot = readStatusFile(stateRoot)
    assert.ok(atBoot)
    const booted = /** @type {any} */ (atBoot.sources[0])
    assert.equal(booted.state, 'started', 'liveness is still the lifecycle\'s verdict')
    assert.equal(booted.health.state, 'degraded', 'and the source\'s own reading rides beside it')
    assert.equal(booted.health.lastError, 'upstream returned 503')
    assert.equal(booted.health.rowsWritten, 7)
    // A plugin-authored sentence is bounded where it is recorded, because
    // this file is rewritten every tick and printed to a terminal.
    assert.ok(booted.health.message.length <= 200, `message not clamped (${booted.health.message.length})`)

    const deadline = Date.now() + 20_000
    /** @type {any} */
    let health
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      health = /** @type {any} */ (readStatusFile(stateRoot)?.sources?.[0])?.health
      if (health && health.state === 'ready') break
    }
    // A failure that is over must not outlive itself in the status file.
    assert.deepEqual(health, { state: 'ready', rowsWritten: 8 })
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// `status()` is plugin code and the registry hands its result back
// unfiltered, so a source is free to resolve `null` where the contract asks
// for a `SourceStatus`. Reading a field off that answer rejects the tick
// before `persist()`, which freezes every field in the status file and, on
// the shutdown path, the stop.
// @ref LLP 0394#health-rides-beside-state [tests]: a probe that answers with nothing usable is recorded as nothing, not thrown over

/**
 * Stage a plugin whose source reports itself once, at boot, and answers
 * `null` on every probe after that.
 *
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function stageNullReportingPlugin(hypHome) {
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
          if (probes > 1) return null
          return { state: 'degraded', lastError: 'upstream returned 503', details: { probes } }
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

test('a source that answers null keeps the tick alive, and says nothing about its health', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-source-null-status-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  let handle
  try {
    const configPath = await writeInstall(hypHome, await stageNullReportingPlugin(hypHome))
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'source-null-status',
      tickIntervalMs: 1,
      installSignalHandlers: false,
    })

    assert.equal(/** @type {any} */ (readStatusFile(stateRoot)?.sources?.[0])?.health?.state, 'degraded')

    // Every tick from here reads a `null`. The file must go on being written
    // (a rejected tick never reaches `persist()`), and the health the source
    // has stopped standing behind must go.
    const deadline = Date.now() + 20_000
    /** @type {any} */
    let snapshot
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      snapshot = readStatusFile(stateRoot)?.sources?.[0]
      if (snapshot?.health === undefined) break
    }
    assert.equal(snapshot?.health, undefined, 'a null answer left the old health standing')
    assert.deepEqual(snapshot?.details, { probes: 1 }, 'details keep their last good value')
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// Resolving an answer is not the same as being able to read one. A plugin is
// free to compute `details` or `lastError` in a getter, and a getter that
// throws is a throw on the tick's critical path unless the answer is taken
// apart inside the probe's own try: `runTick` is invoked as `void runTick()`,
// so the rejection never reaches `persist()` and the whole status file stops
// being written.
// @ref LLP 0394#health-rides-beside-state [tests]: a probe whose answer cannot be read changes nothing, rather than taking the tick down

/**
 * Stage a plugin whose source answers once and then hands back a status
 * object whose `details` cannot be read.
 *
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function stageUnreadableReportPlugin(hypHome) {
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
          if (probes === 1) return { state: 'ready', details: { probes: 1 } }
          return { state: 'error', get details() { throw new TypeError('details is not readable') } }
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

test('a source whose answer cannot be read leaves the tick, and the status file, alive', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-source-unreadable-status-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  let handle
  try {
    const configPath = await writeInstall(hypHome, await stageUnreadableReportPlugin(hypHome))
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'source-unreadable-status',
      tickIntervalMs: 1,
      installSignalHandlers: false,
    })

    const booted = readStatusFile(stateRoot)
    assert.deepEqual(/** @type {any} */ (booted?.sources?.[0])?.details, { probes: 1 })
    const bootedUptimeMs = booted?.uptimeMs ?? 0

    // Every tick from here throws where the answer is read. `persist()` runs
    // at the end of the tick, so a rising `uptimeMs` is the proof that the
    // throw was contained rather than swallowing the tick.
    const deadline = Date.now() + 20_000
    /** @type {any} */
    let later
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      later = readStatusFile(stateRoot)
      if ((later?.uptimeMs ?? 0) > bootedUptimeMs) break
    }
    assert.ok((later?.uptimeMs ?? 0) > bootedUptimeMs, 'the tick stopped writing the status file')
    assert.deepEqual(later?.sources?.[0]?.details, { probes: 1 }, 'an unreadable answer changes nothing')
    assert.equal(later?.sources?.[0]?.health?.state, 'ready', 'nor rewrites the health it could not read')
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The refresh put plugin code on the tick loop's critical path, and the
// kernel contract puts no bound on `status()`. A probe that never settles
// used to be able to hang only boot, which is at least loud. On the tick path
// it froze `persist()` - so *every* field in `status.json` went stale, not
// just that source's - and hung the shutdown refresh with it, all while the
// daemon went on reporting itself healthy.
// @ref LLP 0164#status-reads-it-from-the-status-file [tests]:

/**
 * Stage a plugin whose source answers `status()` once, at boot, and then
 * never again.
 *
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function stageHangingPlugin(hypHome) {
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
          if (probes > 1) await new Promise(() => {})
          return { state: 'ready', details: { probes } }
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

test('a source whose status() never settles cannot freeze the status file or the shutdown', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-source-details-hang-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  let handle
  try {
    const configPath = await writeInstall(hypHome, await stageHangingPlugin(hypHome))
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'source-details-hang',
      tickIntervalMs: 1,
      installSignalHandlers: false,
    })

    const statusPath = path.join(stateRoot, 'run', 'status.json')
    const firstWrite = (await fs.stat(statusPath)).mtimeMs

    // The probe is hung from the very first tick. The tick loop must still be
    // rewriting the file: a frozen mtime here is the whole bug.
    const deadline = Date.now() + 20_000
    let advanced = false
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if ((await fs.stat(statusPath)).mtimeMs > firstWrite) {
        advanced = true
        break
      }
    }
    assert.ok(advanced, 'status.json stopped being written while a probe hung')

    // Details keep their last good value rather than being lost.
    const snapshot = readStatusFile(stateRoot)
    assert.deepEqual(snapshot?.sources?.[0]?.details, { probes: 1 })

    // ... and the daemon can still be stopped.
    const stopped = await Promise.race([
      handle.stop().then(() => handle.done).then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 15_000)),
    ])
    handle = undefined
    assert.equal(stopped, 'stopped', 'shutdown hung on the source status probe')

    // Silence was the other half of the bug: say it, but say it once, not
    // once per tick for the daemon's life.
    const log = await fs.readFile(path.join(stateRoot, 'logs', 'daemon.log'), 'utf8')
    const failures = log.split(String.fromCharCode(10)).filter((l) => l.includes('daemon.source_status_failed'))
    assert.ok(failures.length > 0, 'a stuck status probe was never reported')
    assert.ok(failures.length <= 4, `status probe failure logged ${failures.length} times`)
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
