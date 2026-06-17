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
import { loadConfigFile } from '../config/schema.js'
import { createConfigControl } from '../config/apply.js'
import { buildConfigApplyDeps } from '../config/apply_deps.js'
import { bootKernel } from '../runtime/boot.js'
import { createSinkDriver } from '../sinks/driver.js'
import { materializeSinks } from '../sinks/materialize.js'
import {
  clearPidFile,
  pidFilePath,
  processIsAlive,
  readPidFile,
  writePidFile,
} from './pid.js'
import { openDaemonLog } from './logs.js'
import { statusFilePath, writeStatusFile } from './status.js'

/**
 * @import { JsonObject } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { KernelRuntime } from '../runtime/activation.js'
 * @import { BootKernelResult } from '../runtime/types.d.ts'
 */

/**
 * @import {
 *   DaemonState,
 *   DaemonStatus,
 *   SourceSnapshot,
 *   SinkSnapshot,
 *   DaemonHandle,
 *   RunDaemonOptions,
 * } from './types.d.ts'
 */

const DEFAULT_TICK_INTERVAL_MS = 60_000
const MIN_TICK_INTERVAL_MS = 25

/**
 * Exit code a foreground daemon uses to request its own relaunch after
 * a staged config apply or rollback (EX_TEMPFAIL — "try again"). The
 * service managers relaunch on any exit (`KeepAlive` /
 * `Restart=always`); foreground invokers (smoke harness, dev shells)
 * loop on this specific code.
 * @ref LLP 0017#staged-restart-for-config-replacement [implements] — a foreground daemon cannot relaunch itself; the invoker loops on this code
 */
export const DAEMON_RESTART_EXIT_CODE = 75

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
 * @ref LLP 0017#the-primary-daemon [implements] — boots kernel, starts sources, runs the sink tick loop, reloads on SIGHUP
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
  /** @type {((reason: 'signal'|'manual'|'restart') => Promise<number>) | null} */
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

  // ----- Config apply engine (LLP 0025 / LLP 0031) -----
  // Created before bootKernel so probation expiry is evaluated before
  // any plugin activates: a kernel-killing-but-valid config that
  // crashloops under the service manager may never live long enough
  // for an in-process timer to fire. The central-layer slots, pointer,
  // and join seed all live under `<stateRoot>/config-control/` — the
  // engine derives every path from `stateRoot` and never touches the
  // user-owned local layer (`hypaware-config.json`).
  // An apply can land while the daemon is still wiring up (the pull
  // loop's immediate pull races the tail of runDaemon), so a restart
  // request before triggerShutdown exists is parked, not dropped.
  let pendingRestart = false
  const configControl = createConfigControl({
    stateRoot,
    requestRestart: (reason) => {
      fileLog.info('daemon.restart_requested', { hyp_reason: reason })
      if (triggerShutdown) {
        void triggerShutdown('restart')
      } else {
        pendingRestart = true
      }
    },
  })
  const bootEval = await configControl.evaluateAtBoot()
  if (bootEval.action !== 'none') {
    fileLog.warn('daemon.config_probation_boot_action', { action: bootEval.action })
  }

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
          configControl,
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

  // Attach apply-time deps before any sink materializes: the central
  // sink's pull loop may deliver a document immediately after its
  // bootstrap, and `stage()` refuses to run without a validator. The
  // watchdog re-arms here on every relaunch that boots mid-probation.
  configControl.attachApplyDeps(buildConfigApplyDeps({ stateRoot }))
  configControl.armProbationWatchdog()

  // ----- Materialize config-backed sinks -----
  const sinkResult = await materializeSinks(boot.runtime, boot.config, {
    stateRoot,
    runId,
    tmpRoot: opts.tmpRoot,
  })
  if (sinkResult.errors.length > 0) {
    for (const e of sinkResult.errors) {
      fileLog.error('daemon.sink_materialize_failed', {
        instance: e.instance,
        error_kind: e.errorKind,
        message: e.message,
      })
    }
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

  // ----- Maintenance -----
  /** @type {NodeJS.Timeout | null} */
  let maintenanceHandle = null
  /** @type {Promise<void> | null} */
  let maintenanceInFlight = null
  const maintenanceCfg = boot.config?.query?.cache?.maintenance
  const maintenanceEnabled = maintenanceCfg?.enabled !== false
  if (maintenanceEnabled) {
    const { maintainCache, normalizeMaintenanceConfig } = await import('../cache/maintenance.js')
    const mCfg = normalizeMaintenanceConfig(maintenanceCfg)
    const intervalMs = mCfg.interval_minutes * 60 * 1000
    async function runMaintenance() {
      await withSpan(
        'maintenance.tick',
        {
          [Attr.COMPONENT]: 'daemon',
          [Attr.OPERATION]: 'maintenance.tick',
          daemon_mode: mode,
          status: 'ok',
        },
        async () => {
          await maintainCache({
            cacheRoot: boot.runtime.storage.cacheRoot,
            budgetMs: mCfg.max_tick_ms,
            config: mCfg,
            // @ref LLP 0027#re-settle-sweep — thread the dataset's
            // re-settle hook (same enricher the flush path uses) so
            // compaction can re-settle committed fallback rows split from
            // their uuid twin.
            storage: boot.runtime.storage,
            getSettleHook: (dataset) => boot.runtime.query.getDataset(dataset)?.resettleBatch,
          })
        },
        { component: 'daemon' }
      ).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        fileLog.error('daemon.maintenance_failed', { message })
      })
    }
    if (intervalMs > 0) {
      maintenanceHandle = setInterval(() => {
        if (maintenanceInFlight) return
        maintenanceInFlight = runMaintenance().finally(() => { maintenanceInFlight = null })
      }, intervalMs)
      if (typeof maintenanceHandle.unref === 'function') maintenanceHandle.unref()
    }
  }

  // ----- Shutdown -----
  /** @param {'signal'|'manual'|'restart'} reason */
  async function shutdown(reason) {
    if (shutdownInFlight) return done
    shutdownInFlight = true
    configControl.disarmProbationWatchdog()
    if (tickHandle) {
      clearInterval(tickHandle)
      tickHandle = null
    }
    if (maintenanceHandle) {
      clearInterval(maintenanceHandle)
      maintenanceHandle = null
    }
    if (maintenanceInFlight) {
      await maintenanceInFlight
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
        await closeAllSinks({ runtime: boot.runtime, fileLog })
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
    // @ref LLP 0017#staged-restart-for-config-replacement [implements] — the daemon exits and the service manager (or looping invoker) relaunches it
    resolveDone?.(reason === 'restart' ? DAEMON_RESTART_EXIT_CODE : 0)
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
        let freshConfig = boot.config ?? null
        if (boot.configPath) {
          const loaded = await loadConfigFile(boot.configPath)
          if (!loaded.ok) {
            fileLog.warn('daemon.reload_config_failed', {
              config_path: boot.configPath,
              error_kind: loaded.errorKind,
              message: loaded.message,
            })
            return
          }
          freshConfig = loaded.config
          boot.config = loaded.config
        }
        const configByName = new Map(
          (freshConfig?.plugins ?? []).map((p) => [p.name, p.config ?? {}])
        )

        // Reload re-reads config and refreshes each active plugin
        // context before invoking source.reload(ctx). Source add/remove
        // based on a diff of loaded config is still deferred.
        for (const snap of status.sources) {
          if (snap.state !== 'started') continue
          const ctx = boot.runtime.activationContexts.get(snap.plugin)
          if (!ctx) continue
          ctx.config = /** @type {JsonObject} */ (
            configByName.get(snap.plugin) ?? {}
          )
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

  if (pendingRestart) {
    void shutdown('restart')
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
 * Close every materialized sink instance. The central plugin's config
 * pull loop stops in its `close()` (identity refresh is lazy and has
 * no timer), so shutdown must reach it even though sinks have no
 * started/stopped lifecycle of their own.
 *
 * @param {{ runtime: KernelRuntime, fileLog: ReturnType<typeof openDaemonLog> }} args
 */
async function closeAllSinks({ runtime, fileLog }) {
  try {
    await runtime.sinks.closeAll()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    fileLog.error('daemon.sink_close_failed', { message })
  }
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
