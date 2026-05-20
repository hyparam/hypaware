// @ts-check

import process from 'node:process'

import {
  Attr,
  getKernelInstruments,
  getLogger,
  installObservability,
  runRoot,
  withSpan,
} from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { bootKernel } from '../runtime/boot.js'
import { createSinkDriver } from '../sinks/driver.js'
import {
  clearPidFile,
  pidFilePath,
  processIsAlive,
  readPidFile,
  writePidFile,
} from './pid.js'
import { openDaemonLog } from './logs.js'
import { statusFilePath, writeStatusFile } from './status.js'

/** @typedef {import('./status.js').DaemonState} DaemonState */
/** @typedef {import('./status.js').DaemonStatus} DaemonStatus */
/** @typedef {import('./status.js').SourceSnapshot} SourceSnapshot */
/** @typedef {import('./status.js').SinkSnapshot} SinkSnapshot */
/** @typedef {import('../runtime/activation.js').KernelRuntime} KernelRuntime */
/** @typedef {import('../runtime/boot.js').BootKernelResult} BootKernelResult */

/**
 * @typedef {Object} DaemonHandle
 * @property {Promise<number>} done           Resolves with the daemon exit code after shutdown.
 * @property {() => Promise<number>} stop      Trigger an orderly shutdown (SIGTERM-equivalent).
 * @property {() => DaemonStatus} snapshot     Read the current in-memory status.
 * @property {() => Promise<void>} reload      Trigger a config reload (SIGHUP-equivalent).
 * @property {KernelRuntime} runtime           Phase 3 test affordance. The runtime the daemon activated — exposed so smoke flows can drive sink instantiation, dispatch, and per-test setup until config-driven sink setup lands.
 */

/**
 * @typedef {Object} RunDaemonOptions
 * @property {string} [hypHome]                Override HYP_HOME (defaults from env).
 * @property {string} [configPath]             Explicit config file path.
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [runId]                  dev_run_id for telemetry stamping.
 * @property {number} [tickIntervalMs]         Sink tick cadence (default 60_000).
 * @property {boolean} [installSignalHandlers] Default true; smoke flows opt out and drive shutdown directly.
 * @property {boolean} [foreground]            Phase 3 only supports foreground; surfaced for symmetry with `--foreground`.
 */

const DEFAULT_TICK_INTERVAL_MS = 60_000
const MIN_TICK_INTERVAL_MS = 25

/**
 * Boot the kernel, start every configured source, and run sink ticks
 * on a fixed cadence. Returns a `DaemonHandle` the caller can use to
 * `stop()` the daemon or read the latest `snapshot()` — both used by
 * the smoke flow to drive a deterministic start/stop without sending
 * real OS signals into the test process.
 *
 * Lifecycle (all under a single `daemon.run` root span):
 *
 *  1. `daemon.run` opens; PID + status file written with state
 *     `starting`.
 *  2. `bootKernel({ mode: 'daemon' })` activates the configured
 *     plugins. The `kernel.boot` child span lands inside `daemon.run`.
 *  3. For each registered source not yet started by its plugin's
 *     `activate()`, the daemon calls `kernel.sources.start(name, ctx)`
 *     using the per-plugin activation context captured on the runtime.
 *  4. Once every configured source returns a `StartedSource`, status
 *     flips to `healthy`. Failures degrade the state to `degraded`
 *     but do not abort the daemon — operators get a partial system.
 *  5. A 60s (or `tickIntervalMs`) loop drives the sink driver. Each
 *     tick is a `sink.tick` child span; the bundled sink driver opens
 *     its own `sink.export_batch` spans inside.
 *  6. SIGTERM / SIGINT / `handle.stop()` flip the daemon into
 *     `stopping`, stop every source (each one inside a `source.stop`
 *     span), close the daemon log, write `stopped`, and remove the
 *     PID file. `daemon.shutdown` is the explicit child span the
 *     smoke greps for.
 *  7. SIGHUP / `handle.reload()` re-runs config diff: removed sources
 *     stop, new sources start, unchanged sources `reload()`.
 *
 * The smoke harness opts out of signal handlers via
 * `installSignalHandlers: false` so multiple smoke runs can share
 * a process without trampling each other's SIGTERM handler.
 *
 * @param {RunDaemonOptions} [opts]
 * @returns {Promise<DaemonHandle>}
 */
export async function runDaemon(opts = {}) {
  const env = opts.env ?? process.env
  const obsEnv = readObservabilityEnv(env)
  const hypHome = opts.hypHome ?? obsEnv.hypHome
  const stateRoot = `${hypHome}/hypaware`
  const tickIntervalMs = clampTickInterval(opts.tickIntervalMs)
  const installSignals = opts.installSignalHandlers !== false
  const runId = opts.runId ?? obsEnv.devRunId ?? `daemon-${process.pid}-${Date.now()}`
  const mode = opts.foreground === false ? 'detached' : 'foreground'
  const startedAtMs = Date.now()

  installObservability()
  const log = getLogger('daemon')
  const instruments = getKernelInstruments()
  const fileLog = openDaemonLog({ stateRoot, runId, mode })

  /** @type {DaemonStatus} */
  const status = {
    state: 'starting',
    pid: process.pid,
    startedAt: new Date(startedAtMs).toISOString(),
    uptimeMs: 0,
    runId,
    mode,
    sources: [],
    sinks: [],
  }
  /** @type {Map<string, SinkSnapshot>} */
  const sinkSnapshots = new Map()
  /** @type {NodeJS.Timeout | null} */
  let tickHandle = null
  /** @type {((reason: 'signal'|'manual') => Promise<number>) | null} */
  let triggerShutdown = null
  let shutdownInFlight = false
  /** @type {((value: number) => void) | null} */
  let resolveDone = null
  /** @type {Promise<number>} */
  const done = new Promise((resolve) => { resolveDone = resolve })
  /** @type {(() => Promise<void>) | null} */
  let triggerReload = null
  let healthyAtMs = 0

  // PID file is written before any plugin activation: that way a
  // crash during `bootKernel` still leaves something `daemon stop`
  // can detect (rather than the operator wondering where the daemon
  // went).
  writePidFile(stateRoot, {
    pid: process.pid,
    startedAt: status.startedAt,
    runId,
    mode,
  })
  writeStatusFile(stateRoot, status)
  fileLog.info('daemon.starting', { config_path: opts.configPath ?? null })

  /**
   * Persist the status snapshot to disk and update the gauge.
   * @param {Partial<DaemonStatus>} [patch]
   */
  function persist(patch) {
    if (patch) Object.assign(status, patch)
    status.uptimeMs = healthyAtMs === 0 ? 0 : Math.max(0, Date.now() - healthyAtMs)
    instruments.daemonUptimeMs.record(status.uptimeMs, {
      hyp_daemon_state: status.state,
    })
    writeStatusFile(stateRoot, status)
  }

  /** @type {BootKernelResult} */
  let boot
  /** @type {SourceSnapshot[]} */
  let sourceSnapshots
  try {
    const result = await runRoot(
      'daemon.run',
      {
        [Attr.COMPONENT]: 'daemon',
        [Attr.OPERATION]: 'daemon.run',
        [Attr.DEV_RUN_ID]: runId,
        hyp_home: hypHome,
        daemon_mode: mode,
        status: 'ok',
      },
      async () => {
        const booted = await bootKernel({
          hypHome,
          configPath: opts.configPath,
          mode: 'daemon',
          runId,
          env,
        })
        /** @type {Map<string, string>} */
        const sourcePluginByName = new Map()
        for (const contribution of booted.runtime.sources.list()) {
          sourcePluginByName.set(contribution.name, contribution.plugin)
        }
        const snapshots = await startConfiguredSources({
          runtime: booted.runtime,
          log,
          fileLog,
          sourcePluginByName,
        })
        return { booted, snapshots }
      },
      { component: 'daemon' }
    )
    boot = result.booted
    sourceSnapshots = result.snapshots
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    fileLog.error('daemon.boot_failed', { message })
    persist({ state: 'degraded', warnings: [`boot_failed: ${message}`] })
    clearPidFile(stateRoot)
    fileLog.close()
    throw err
  }

  status.configPath = boot.configPath ?? undefined
  status.sources = sourceSnapshots
  const anySourceFailed = sourceSnapshots.some((s) => s.state === 'failed')
  if (sourceSnapshots.length === 0 || anySourceFailed) {
    status.state = anySourceFailed ? 'degraded' : 'healthy'
  } else {
    status.state = 'healthy'
  }
  if (status.state === 'healthy') {
    healthyAtMs = Date.now()
    status.healthyAt = new Date(healthyAtMs).toISOString()
  }

  // ----- Sink driver -----
  const driver = createSinkDriver({
    sinkRegistry: boot.runtime.sinks,
    queryRegistry: boot.runtime.query,
    storage: boot.runtime.storage,
    stateRoot,
    config: boot.config ?? undefined,
  })

  status.sinks = collectSinkSnapshots({ runtime: boot.runtime, sinkSnapshots, sinkPluginByInstance: new Map() })
  persist()
  fileLog.info('daemon.healthy', {
    sources: sourceSnapshots.map((s) => s.name),
    sinks: status.sinks.map((s) => s.instance),
  })

  // ----- Tick loop -----
  async function runTick() {
    const now = new Date()
    await withSpan(
      'sink.tick',
      {
        [Attr.COMPONENT]: 'daemon',
        [Attr.OPERATION]: 'sink.tick',
        daemon_mode: mode,
        status: 'ok',
      },
      async () => {
        const report = await driver.tick({ now, source: 'daemon' })
        for (const sinkReport of report.sinks) {
          const snap = sinkSnapshots.get(sinkReport.instance) ?? {
            instance: sinkReport.instance,
            plugin: '',
            kind: '',
          }
          snap.lastTickAt = now.toISOString()
          if (sinkReport.status === 'exported') {
            snap.lastSuccessAt = snap.lastTickAt
          }
          sinkSnapshots.set(sinkReport.instance, snap)
        }
      },
      { component: 'daemon' }
    ).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      fileLog.error('daemon.tick_failed', { message })
    })
    status.sinks = collectSinkSnapshots({ runtime: boot.runtime, sinkSnapshots, sinkPluginByInstance: new Map() })
    persist()
  }

  if (tickIntervalMs > 0) {
    tickHandle = setInterval(() => { void runTick() }, tickIntervalMs)
    if (typeof tickHandle.unref === 'function') tickHandle.unref()
  }

  // ----- Shutdown -----
  /** @param {'signal'|'manual'} reason */
  async function shutdown(reason) {
    if (shutdownInFlight) return done
    shutdownInFlight = true
    if (tickHandle) {
      clearInterval(tickHandle)
      tickHandle = null
    }
    persist({ state: 'stopping' })
    fileLog.info('daemon.stopping', { reason })

    await withSpan(
      'daemon.shutdown',
      {
        [Attr.COMPONENT]: 'daemon',
        [Attr.OPERATION]: 'daemon.shutdown',
        daemon_mode: mode,
        shutdown_reason: reason,
        status: 'ok',
      },
      async () => {
        const stopErrors = await stopAllSources({ runtime: boot.runtime, fileLog })
        if (stopErrors.length > 0) {
          persist({
            state: 'stopping',
            warnings: stopErrors.map((e) => `source_stop_failed:${e.name}:${e.message}`),
          })
        }
        for (const snap of status.sources) {
          snap.state = 'stopped'
        }
      },
      { component: 'daemon' }
    ).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      fileLog.error('daemon.shutdown_failed', { message })
    })

    const stoppedAt = new Date()
    persist({ state: 'stopped', stoppedAt: stoppedAt.toISOString() })
    fileLog.info('daemon.stopped')
    fileLog.close()
    clearPidFile(stateRoot)

    if (installSignals) {
      removeSignalHandlers()
    }
    resolveDone?.(0)
    return done
  }
  triggerShutdown = shutdown

  // ----- Reload -----
  async function reload() {
    fileLog.info('daemon.reload_requested')
    await withSpan(
      'daemon.reload',
      {
        [Attr.COMPONENT]: 'daemon',
        [Attr.OPERATION]: 'daemon.reload',
        status: 'ok',
      },
      async () => {
        // Phase 3 reload is config re-read + per-source `reload()` if
        // the source exposes one. Source add/remove based on a diff
        // of the loaded config lands when Phase 4 wires the
        // installer-driven reload signal end-to-end.
        for (const snap of status.sources) {
          if (snap.state !== 'started') continue
          const ctx = boot.runtime.activationContexts.get(snap.plugin)
          if (!ctx) continue
          try {
            await boot.runtime.sources.reload(snap.name, ctx)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            fileLog.warn('daemon.source_reload_failed', { source: snap.name, message })
          }
        }
      },
      { component: 'daemon' }
    )
    persist()
  }
  triggerReload = reload

  // ----- Signal wiring -----
  const sigTermHandler = () => { void shutdown('signal') }
  const sigIntHandler = () => { void shutdown('signal') }
  const sigHupHandler = () => { void reload() }

  function removeSignalHandlers() {
    if (!installSignals) return
    process.removeListener('SIGTERM', sigTermHandler)
    process.removeListener('SIGINT', sigIntHandler)
    process.removeListener('SIGHUP', sigHupHandler)
  }

  if (installSignals) {
    process.on('SIGTERM', sigTermHandler)
    process.on('SIGINT', sigIntHandler)
    process.on('SIGHUP', sigHupHandler)
  }

  return {
    done,
    stop: () => shutdown('manual'),
    snapshot: () => ({ ...status, sources: status.sources.slice(), sinks: status.sinks.slice() }),
    reload: () => triggerReload ? triggerReload() : Promise.resolve(),
    runtime: boot.runtime,
  }
}

/**
 * @param {number|undefined} value
 * @returns {number}
 */
function clampTickInterval(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TICK_INTERVAL_MS
  if (value <= 0) return 0
  return Math.max(value, MIN_TICK_INTERVAL_MS)
}

/**
 * Start every registered source that has not auto-started during
 * `activate()`. Returns one snapshot per source — including the
 * already-started ones so the status file lists everything the
 * operator expects to see.
 *
 * @param {{ runtime: KernelRuntime, log: ReturnType<typeof getLogger>, fileLog: ReturnType<typeof openDaemonLog>, sourcePluginByName: Map<string,string> }} args
 * @returns {Promise<SourceSnapshot[]>}
 */
async function startConfiguredSources({ runtime, log, fileLog, sourcePluginByName }) {
  /** @type {SourceSnapshot[]} */
  const snapshots = []
  for (const contribution of runtime.sources.list()) {
    const plugin = sourcePluginByName.get(contribution.name) ?? contribution.plugin
    const existing = runtime.sources.started(contribution.name)
    if (existing) {
      const details = await safeStatus(runtime, contribution.name)
      snapshots.push({
        name: contribution.name,
        plugin,
        state: 'started',
        details,
      })
      log.info('daemon.source_already_started', {
        [Attr.PLUGIN]: plugin,
        hyp_source: contribution.name,
      })
      continue
    }
    const ctx = runtime.activationContexts.get(plugin)
    if (!ctx) {
      const message = `no activation context recorded for plugin '${plugin}'`
      fileLog.error('daemon.source_start_failed', {
        source: contribution.name,
        plugin,
        message,
      })
      snapshots.push({
        name: contribution.name,
        plugin,
        state: 'failed',
        error: message,
      })
      continue
    }
    try {
      await runtime.sources.start(contribution.name, ctx)
      const details = await safeStatus(runtime, contribution.name)
      snapshots.push({
        name: contribution.name,
        plugin,
        state: 'started',
        details,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fileLog.error('daemon.source_start_failed', {
        source: contribution.name,
        plugin,
        message,
      })
      snapshots.push({
        name: contribution.name,
        plugin,
        state: 'failed',
        error: message,
      })
    }
  }
  return snapshots
}

/**
 * Stop every started source. Returns the list of names that failed
 * so the daemon can surface them as warnings on the final status
 * snapshot.
 *
 * @param {{ runtime: KernelRuntime, fileLog: ReturnType<typeof openDaemonLog> }} args
 */
async function stopAllSources({ runtime, fileLog }) {
  /** @type {Array<{ name: string, message: string }>} */
  const errors = []
  for (const { name } of runtime.sources.listStarted()) {
    try {
      await runtime.sources.stop(name)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fileLog.error('daemon.source_stop_failed', { source: name, message })
      errors.push({ name, message })
    }
  }
  return errors
}

/**
 * Best-effort source `.status()` invocation — failures should not
 * abort the daemon's snapshot capture.
 *
 * @param {KernelRuntime} runtime
 * @param {string} name
 */
async function safeStatus(runtime, name) {
  try {
    const status = await runtime.sources.status(name)
    return status?.details ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build a snapshot row per registered sink instance. The kernel sink
 * driver doesn't yet surface failure / next-tick fields, so those
 * stay `undefined` until Phase 5 closes the loop.
 *
 * @param {{ runtime: KernelRuntime, sinkSnapshots: Map<string, SinkSnapshot>, sinkPluginByInstance: Map<string,string> }} args
 * @returns {SinkSnapshot[]}
 */
function collectSinkSnapshots({ runtime, sinkSnapshots }) {
  /** @type {SinkSnapshot[]} */
  const out = []
  for (const handle of runtime.sinks.listHandles()) {
    const existing = sinkSnapshots.get(handle.instanceName) ?? {
      instance: handle.instanceName,
      plugin: handle.plugin,
      kind: handle.kind,
    }
    existing.plugin = handle.plugin
    existing.kind = handle.kind
    sinkSnapshots.set(handle.instanceName, existing)
    out.push({ ...existing })
  }
  return out
}

/**
 * `hyp daemon stop` helper. Reads the PID file, signals the running
 * daemon with SIGTERM, and waits (up to `timeoutMs`) for the
 * process to clear the PID file. Returns the resulting state for
 * the command body to render.
 *
 * @param {{ stateRoot: string, timeoutMs?: number, pollIntervalMs?: number }} args
 * @returns {Promise<'stopped'|'not_running'|'timed_out'>}
 */
export async function requestDaemonStop({ stateRoot, timeoutMs = 5_000, pollIntervalMs = 50 }) {
  const entry = readPidFile(stateRoot)
  if (!entry || !processIsAlive(entry.pid)) {
    if (entry) clearPidFile(stateRoot)
    return 'not_running'
  }
  try {
    process.kill(entry.pid, 'SIGTERM')
  } catch (err) {
    const code = err && /** @type {NodeJS.ErrnoException} */ (err).code
    if (code === 'ESRCH') {
      clearPidFile(stateRoot)
      return 'not_running'
    }
    throw err
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processIsAlive(entry.pid)) {
      clearPidFile(stateRoot)
      return 'stopped'
    }
    await sleep(pollIntervalMs)
  }
  return 'timed_out'
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export {
  pidFilePath,
  statusFilePath,
}
