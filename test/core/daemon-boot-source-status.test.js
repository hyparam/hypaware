// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runDaemon, withStatusTimeout } from '../../src/core/daemon/runtime.js'
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

const PLUGIN = '@third-party/boot-status'
const SOURCE = 'boot-status-fixture'

/**
 * The two ways a source's own `status()` fails the boot probe without ever
 * throwing at it: an answer the kernel cannot read (#1504), and no answer at
 * all (#1508). Each is the body of the fixture's `status()`, spliced into the
 * plugin source below.
 */
const STATUS_BODY = {
  unreadable: `return {
            state: 'ready',
            details: { probes: 1 },
            get lastError() { throw new TypeError('lastError is not readable') },
          }`,
  hanging: 'await new Promise(() => {})',
}

/**
 * Stage a plugin whose source's `status()` misbehaves in one of the ways
 * `STATUS_BODY` describes. For `unreadable`, `lastError` is the last of the
 * four fields `sourceHealth` reads, so reaching the throw also proves the
 * other three were read.
 *
 * `autoStart` reproduces `@hypaware/otel`, which starts its own source inside
 * `activate()`: the source is then already started when
 * `startConfiguredSources` runs, and the already-started branch is taken.
 *
 * @param {string} hypHome
 * @param {boolean} autoStart
 * @param {string} statusBody
 * @returns {Promise<string>}
 */
async function stageStatusPlugin(hypHome, autoStart, statusBody) {
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
          ${statusBody}
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
 * @param {string} [statusBody]
 * @param {string} [home] A temp home the caller already made, for the one
 *   caller that has to be able to remove it even when this boot never settles
 *   and so never hands a handle back.
 */
async function bootWith(prefix, autoStart, statusBody = STATUS_BODY.unreadable, home) {
  const hypHome = home ?? await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    const configPath = await writeInstall(hypHome, await stageStatusPlugin(hypHome, autoStart, statusBody))
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

/**
 * Stop the daemon and remove the temp home. The removal sits in a `finally`
 * for the same reason `bootWith` cleans up in its `catch`: a shutdown that
 * throws is one of the failing runs this file exists to report, and it must
 * not also be the run that leaves its temp home behind.
 *
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
    if (booted) await closeBoot(booted)
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
    if (booted) await closeBoot(booted)
  }
})

// The tick path races a source's `status()` against a 5 second bound and
// reports the timeout as an ordinary probe failure. Boot awaited the same
// plugin promise with no race at all, and `startConfiguredSources` awaits one
// source at a time, so a single source whose `status()` never settled stopped
// the daemon from ever reaching `persist()`: no daemon, no status file, no
// error, just a process that never finished starting (#1508).
//
// @ref LLP 0394#health-rides-beside-state [tests]: a boot probe that times out records no health, rather than failing the source

/** Generous enough that only a boot with no bound at all trips it. */
const BOOT_DEADLINE_MS = 20_000

test('a source whose status() never settles does not hang daemon boot', async (t) => {
  // Made here rather than inside `bootWith` so the regression run has
  // something to clean up with: a boot still pending hands back no handle.
  // The removal is an `after` hook because the run this test exists to report
  // is one where the test body itself never gets another turn: an unbounded
  // boot probe drains the event loop, and Node abandons the pending test
  // without unwinding it, so neither a `finally` here nor `closeBoot` below
  // would run. The runner still runs its own hooks on that path. `rmSync`
  // rather than `fs.rm` for the same reason: nothing is left to await on.
  // `force` makes it a no-op on the passing run, where `closeBoot` got there
  // first.
  const prefix = 'hypaware-boot-status-hang-'
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => { rmSync(hypHome, { recursive: true, force: true }) })
  /** @type {NodeJS.Timeout | undefined} */
  let deadline
  let outcome
  try {
    outcome = await Promise.race([
      bootWith(prefix, false, STATUS_BODY.hanging, hypHome),
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve('hung'), BOOT_DEADLINE_MS)
        deadline.unref()
      }),
    ])
  } finally {
    // Cleared on the rejecting path too, where `bootWith` has already removed
    // the home itself but the deadline would otherwise sit out its 20 seconds.
    clearTimeout(deadline)
  }
  if (outcome === 'hung') {
    assert.fail(`daemon boot did not finish within ${BOOT_DEADLINE_MS}ms with a source whose status() never settles`)
  }

  const booted = /** @type {Awaited<ReturnType<typeof bootWith>>} */ (outcome)
  // Nothing else holds this process's event loop while the daemon stops: it
  // booted with `installSignalHandlers: false` and every timer on the stop
  // path is unref'd, so the hung probe the shutdown refresh starts would drain
  // the loop and exit the runner mid-stop. The boot above is deliberately not
  // held this way: a bound that holds only while something else does is not
  // the bound this test is checking.
  const keepAlive = setInterval(() => {}, 500)
  try {
    const snapshot = /** @type {any} */ (readStatusFile(booted.stateRoot)?.sources?.[0])
    assert.ok(snapshot, 'boot wrote no source snapshot')
    assert.equal(snapshot.name, SOURCE)
    assert.equal(snapshot.state, 'started', 'the source did start, and boot must say so')
    assert.equal(snapshot.health, undefined, 'a probe that never answered records nothing')
    assert.equal(snapshot.details, undefined, 'and invents no details either')

    // Abandoned, and reported the way the tick path reports it.
    const log = await fs.readFile(path.join(booted.stateRoot, 'logs', 'daemon.log'), 'utf8')
    const failure = log.split(String.fromCharCode(10)).find((l) => l.includes('daemon.source_status_failed'))
    assert.ok(failure, 'a stuck boot probe went unreported')
    assert.match(failure, /status probe exceeded 5000ms/)
  } finally {
    try {
      await closeBoot(booted)
    } finally {
      clearInterval(keepAlive)
    }
  }
})

// The two callers disagree about one thing, and the whole suite above is blind
// to it. A boot deadline that is not ref'd empties the event loop and the
// process exits mid-boot, which is #1508's missing daemon again by another
// route; a tick deadline that *is* ref'd holds the daemon open for up to five
// seconds past its own `stop`, waiting on a probe nobody is listening to any
// more. The boot direction fails a test above if it is flipped, the tick
// direction failed none: `keepAlive` defaulting the other way passed the
// entire suite. Neither is reachable through `runDaemon`, so both are asserted
// here against the helper itself.
test("the status probe's deadline holds the loop at boot and not on the tick", async () => {
  const liveTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

  /** @type {(value?: unknown) => void} */
  let answer = () => {}
  const probe = new Promise((resolve) => { answer = resolve })

  // Read back to back with no await between, so nothing else can create or
  // retire a timer in the gap and the deltas are this helper's alone.
  const before = liveTimers()
  const tick = withStatusTimeout(probe)
  assert.equal(liveTimers(), before, "a tick probe's deadline must not keep the process alive past shutdown")
  const boot = withStatusTimeout(probe, { keepAlive: true })
  assert.equal(liveTimers(), before + 1, "a boot probe's deadline is all that holds the loop while boot waits")

  answer()
  await Promise.all([tick, boot])
  assert.equal(liveTimers(), before, 'a probe that answered leaves no deadline behind')
})
