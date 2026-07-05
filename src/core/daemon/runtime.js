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
import { createConfigControl } from '../config/apply.js'
import { buildConfigApplyDeps } from '../config/apply_deps.js'
import { createActionReconciler } from '../config/action_reconciler.js'
import { attachHandler } from '../config/action_attach.js'
import { backfillHandler } from '../config/action_backfill.js'
import { bootKernel, resolveLayeredConfigForDaemon } from '../runtime/boot.js'
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
 * @import { AiGatewayCapability, JsonObject } from '../../../hypaware-plugin-kernel-types.js'
 * @import { KernelRuntime } from '../../../src/core/runtime/types.js'
 * @import { BootKernelResult } from '../../../src/core/runtime/types.js'
 * @import { ClientDescriptor } from '../../../src/core/types.js'
 * @import { ActionHandler } from '../../../src/core/config/types.js'
 */

/**
 * @import {
 *   DaemonState,
 *   DaemonStatus,
 *   SourceSnapshot,
 *   SinkSnapshot,
 *   DaemonHandle,
 *   RunDaemonOptions,
 * } from '../../../src/core/daemon/types.js'
 */

const DEFAULT_TICK_INTERVAL_MS = 60_000
const MIN_TICK_INTERVAL_MS = 25

/**
 * The client-action handlers the daemon constructs its reconciler with, in the
 * order the reconciler runs them: **attach first, then backfill**. The
 * reconciler runs handlers serially and `backfillHandler.perform()` awaits a
 * (possibly multi-minute) `hyp backfill` subprocess, so attach — an in-process
 * settings write — must lead, or live capture is stranded behind the historical
 * import. Exported so the ordering is a unit-testable invariant.
 *
 * @type {ActionHandler[]}
 * @ref LLP 0045#module--seam-breakdown-independently-mergeable-tasks [implements] — register [attachHandler, backfillHandler], attach first so live capture leads the backfill subprocess
 */
export const DEFAULT_ACTION_HANDLERS = [attachHandler, backfillHandler]

/**
 * Exit code a foreground daemon uses to request its own relaunch after
 * a staged config apply or rollback (EX_TEMPFAIL, "try again"). The
 * service managers relaunch on any exit (`KeepAlive` /
 * `Restart=always`); foreground invokers (smoke harness, dev shells)
 * loop on this specific code.
 * @ref LLP 0017#staged-restart-for-config-replacement [implements]: a foreground daemon cannot relaunch itself; the invoker loops on this code
 */
export const DAEMON_RESTART_EXIT_CODE = 75

/**
 * Boot the kernel, start every configured source, and run sink ticks
 * on a fixed cadence. Returns a `DaemonHandle` the caller can use to
 * `stop()` the daemon or read the latest `snapshot()` (both used by
 * the smoke flow to drive a deterministic start/stop without sending
 * real OS signals into the test process).
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
 *     but do not abort the daemon. Operators get a partial system.
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
 * @ref LLP 0017#the-primary-daemon [implements]: boots kernel, starts sources, runs the sink tick loop, reloads on SIGHUP
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
  // Forward reference to the client-action reconcile scheduler. It can only
  // be built after `boot` resolves (it needs the effective config + the
  // kernel backfill registry), but the confirmation-edge hook below is wired
  // into `configControl` before boot, so the hook calls through this ref and
  // an edge that fires before the scheduler exists is recovered by the
  // after-activation already-confirmed pass (mirrors `pendingRestart`).
  /** @type {((reason: string) => void) | null} */
  let scheduleReconcile = null
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
  // and join seed all live under `<stateRoot>/config-control/`: the
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
    // The confirmation edge (probation active→cleared on the first
    // authenticated poll): the running config is now the confirmed one, so
    // schedule one reconcile pass. The pull loop's immediate pull can race
    // the tail of runDaemon, so an edge before the scheduler is wired is
    // dropped here and recovered by the after-activation already-confirmed
    // pass (probation is cleared by then), same race handling as
    // `pendingRestart`.
    // @ref LLP 0041#when-the-reconciler-runs-lifecycle-integration [implements]: the daemon wires onConfirmed to schedule a reconcile pass per confirmation edge; apply.js stays ignorant of the reconciler
    onConfirmed: () => {
      if (scheduleReconcile) scheduleReconcile('confirm-edge')
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
        const snapshots = await startConfiguredSources({
          runtime: booted.runtime,
          log,
          fileLog,
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
    await fileLog.close()
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
  // The live per-plugin config registry is threaded in so apply-time
  // validation actually runs the section validators the active plugins
  // registered (e.g. claude/codex `backfill` blocks). Without it the
  // per-plugin validators are dead in production: a served config with a
  // malformed `backfill` block would be accepted instead of rolled back.
  // @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements]: apply-time validation dispatches to the source plugin's own config-section validator
  configControl.attachApplyDeps(
    buildConfigApplyDeps({ stateRoot, configRegistry: boot.runtime.configRegistry })
  )
  configControl.armProbationWatchdog()

  // ----- Client-action reconciler (LLP 0036 / LLP 0037 / LLP 0041 / LLP 0045) -----
  // The daemon is the only host with `configControl`, so a reconciler
  // attached here is daemon-only by construction: `hyp status` (a plain CLI
  // boot) never performs a machine effect. v1 ships two handlers — attach
  // (LLP 0045) and the run-once backfill-on-join (LLP 0037). Constructed only
  // after boot because a pass needs the effective config + the kernel backfill
  // registry, and the attach seam reads the gateway capability the boot bound.
  // @ref LLP 0041#the-reconciler-component [implements] — construct the reconciler in the daemon
  const actionReconciler =
    opts.actionReconciler ??
    createActionReconciler({
      stateRoot,
      // Attach first so in-process live-capture wiring starts ahead of the
      // (possibly multi-minute) backfill subprocess: the reconciler runs
      // handlers serially and `backfillHandler.perform()` awaits its child, so
      // attach-first avoids stranding live capture behind the historical import
      // (data is order-insensitive — this is purely the latency ordering).
      // @ref LLP 0045#module--seam-breakdown-independently-mergeable-tasks [implements] — register [attachHandler, backfillHandler], attach first
      handlers: DEFAULT_ACTION_HANDLERS,
      log: getLogger('action-reconciler'),
    })

  // The client-action seam the attach handler needs (LLP 0045 §Part 1),
  // resolved once from boot now that `startConfiguredSources` has bound the
  // gateway source (so `localEndpoint()` is live, not racing):
  //  - `clientDescriptors` enumerates the client adapters + their owning
  //    plugins (the static catalog the boot already built);
  //  - `clients` is the runtime gateway capability used only to invoke a
  //    client's attach effect, present only when the gateway plugin is enabled;
  //  - `endpoint` is the proven-bound local gateway base URL from
  //    `localEndpoint()` (no configured-`listen` fallback on the daemon path —
  //    auto-attach must never record a URL for a port nothing bound).
  // All three stay undefined on a non-gateway boot, leaving the attach handler
  // inert by construction.
  //
  // Resolved ONCE here and then closed over by `runReconcilePass` below: the
  // same `clientSeam` is reused, unchanged, for every reconcile pass for the
  // daemon's lifetime — it is never re-derived per pass. So a pass can never
  // observe a half-resolved seam (e.g. a transiently-empty `clients`); the
  // attach handler's `desired()` always reads the fully-resolved-at-boot value,
  // and reversal can never over-fire on a momentary `clients` gap.
  // @ref LLP 0045#part-1--the-client-seam-in-the-reconcile-context [implements] — daemon resolves clientDescriptors from the catalog, clients/endpoint from boot.runtime.capabilities when the gateway is enabled
  const clientSeam = resolveClientActionSeam({ boot, fileLog })

  /**
   * Run one reconcile pass against the effective config + backfill registry.
   * Never throws. A failed handler is surfaced as a `failed` marker by the
   * reconciler, and any unexpected error is logged here, so the single-flight
   * scheduler's rerun loop is never aborted by a pass.
   * @param {string} reason
   */
  async function runReconcilePass(reason) {
    const config = boot.config
    // No effective config (neither layer present) → nothing to reconcile.
    if (!config) return
    await withSpan(
      'client_action.reconcile',
      {
        [Attr.COMPONENT]: 'daemon',
        [Attr.OPERATION]: 'client_action.reconcile',
        [Attr.DEV_RUN_ID]: runId,
        hyp_reason: reason,
        status: 'ok',
      },
      async () => {
        const report = await actionReconciler.reconcile({
          config,
          backfills: boot.runtime.backfills,
          // Thread the daemon's resolved env, forcing HYP_HOME to the
          // hypHome this daemon actually booted against, so a spawned
          // `hyp backfill` imports into the same cache rather than whatever
          // process.env.HYP_HOME happened to be (LLP 0041 §Run-once flow).
          // @ref LLP 0041#run-once-flow-backfill-handler [implements]: the child runs against the daemon's resolved HYP_HOME, not process.env
          env: { ...env, HYP_HOME: hypHome },
          // The client-action seam (LLP 0045 §Part 1) the attach handler reads.
          // Undefined on a non-gateway boot — the handler stays inert.
          clientDescriptors: clientSeam.clientDescriptors,
          clients: clientSeam.clients,
          endpoint: clientSeam.endpoint,
        })
        fileLog.info('daemon.reconcile_pass', {
          hyp_reason: reason,
          results: report.results.length,
        })
      },
      { component: 'daemon' }
    ).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      fileLog.error('daemon.reconcile_failed', { hyp_reason: reason, message })
    })
  }

  // The single-flight guard: only one pass runs at a time, off the tick loop.
  const reconcileScheduler = createReconcilePassScheduler({
    run: runReconcilePass,
    log: fileLog,
  })
  scheduleReconcile = reconcileScheduler.schedule

  // After-activation already-confirmed pass: if a central layer is present
  // and the running config already cleared probation on a prior boot (no
  // active probation marker now), run one pass to recover anything missed
  // while a previous probation was outstanding. A fresh join (probation
  // still active) instead waits for the `confirmPoll` edge above. A
  // non-joined host has no central layer, so the reconciler stays a no-op.
  // @ref LLP 0041#when-the-reconciler-runs-lifecycle-integration [implements]: after-activation already-confirmed pass, gated on a present central layer and no active probation
  const bootControlStatus = await configControl.status()
  if (boot.centralConfigPath != null && !bootControlStatus.probation) {
    reconcileScheduler.schedule('boot-already-confirmed')
  }

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

  status.sinks = collectSinkSnapshots({ runtime: boot.runtime, sinkSnapshots })
  persist()
  // Derive the boot health event from the SAME aggregate written to
  // status.json: a degraded boot (any source failed to start) must not log
  // `daemon.healthy`. Monitoring keyed off that event would read a false
  // positive, and a health event never lists a source that failed to
  // start; it reports only the sources that actually came up.
  // @ref LLP 0017#the-primary-daemon [implements]: the boot health event reports the same state as `hyp daemon status`
  const startedSourceNames = sourceSnapshots
    .filter((s) => s.state !== 'failed')
    .map((s) => s.name)
  if (status.state === 'healthy') {
    fileLog.info('daemon.healthy', {
      state: status.state,
      sources: startedSourceNames,
      sinks: status.sinks.map((s) => s.instance),
    })
  } else {
    fileLog.warn('daemon.degraded', {
      state: status.state,
      sources: startedSourceNames,
      failed_sources: sourceSnapshots
        .filter((s) => s.state === 'failed')
        .map((s) => s.name),
      sinks: status.sinks.map((s) => s.instance),
    })
  }

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
    status.sinks = collectSinkSnapshots({ runtime: boot.runtime, sinkSnapshots })
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
            // @ref LLP 0027#re-settle-sweep: thread the dataset's
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
    // Let any in-flight reconcile pass finish so the daemon never exits
    // mid-import. Abandoning a pass would orphan the spawned `hyp backfill`
    // child and interrupt the marker write.
    await reconcileScheduler.settle()
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
    // Await the flush before resolving `done`: a caller (or the #138
    // regression test) that reads `daemon.log` right after the daemon stops
    // must see every line, not a buffer the process abandoned on exit.
    await fileLog.close()
    clearPidFile(stateRoot)

    if (installSignals) {
      removeSignalHandlers()
    }
    // @ref LLP 0017#staged-restart-for-config-replacement [implements]: the daemon exits and the service manager (or looping invoker) relaunches it
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
        // Re-resolve BOTH layers, exactly as bootKernel does (LLP 0031): a
        // SIGHUP must re-merge the central layer, not re-read the local
        // layer alone. Re-reading only the local file would drop the merged
        // central config on a joined host and re-open the #111 footgun this
        // design closes. The central layer is read-only here; only an
        // *apply* (which triggers a restart, not a reload) rewrites it.
        // @ref LLP 0031#two-layers-merged-at-boot [implements]: reload re-runs the two-layer resolution; reload never sees the local layer alone
        const resolved = await resolveLayeredConfigForDaemon({
          stateRoot,
          configPath: boot.configPath ?? null,
        })
        // A broken/missing local layer is loud but not fatal. Keep running
        // on the already-merged config rather than reload from a degraded
        // view (the central layer always carries the host).
        if (boot.configPath && resolved.localLoaded && !resolved.localLoaded.ok) {
          fileLog.warn('daemon.reload_config_failed', {
            config_path: boot.configPath,
            error_kind: resolved.localLoaded.errorKind,
            message: resolved.localLoaded.message,
          })
          return
        }
        const freshConfig = resolved.effective ?? boot.config ?? null
        boot.config = freshConfig
        for (const drop of resolved.drops) {
          fileLog.warn('config.local_entry_dropped', {
            [Attr.COMPONENT]: 'config',
            [Attr.ERROR_KIND]: drop.reason,
            section: drop.section,
            key: drop.key,
            hyp_reason: drop.reason,
            ...(drop.detail ? { detail: drop.detail } : {}),
          })
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
 * Single-flight scheduler for client-action reconcile passes.
 *
 * Each confirmation edge (and the after-activation already-confirmed check)
 * calls `schedule()`, which runs `run()` as its own async task **off the
 * caller's stack**: `schedule()` returns synchronously, so a reconcile pass
 * (which may spawn a multi-minute `hyp backfill` import) never delays the
 * sink tick loop or the apply engine's confirm poll. Only one pass runs at a
 * time; an edge that arrives while a pass is in flight sets a "re-run when
 * done" flag, coalescing any number of edges during a pass into exactly one
 * more pass. Coalescing is lossless because the reconciler is level-triggered,
 * so the next pass reads the latest config + markers and converges the gap.
 *
 * `settle()` resolves when no pass is in flight; the shutdown path awaits it
 * so the daemon never exits mid-pass.
 *
 * @param {{ run: (reason: string) => Promise<void>, log?: { error(message: string, attributes?: Record<string, unknown>): void } }} args
 * @returns {{ schedule: (reason: string) => void, settle: () => Promise<void> }}
 * @ref LLP 0041#when-the-reconciler-runs-lifecycle-integration [implements]: single-flight guard: one pass at a time, an edge during a pass re-runs once when done, and the pass is its own async task off the tick loop
 */
export function createReconcilePassScheduler({ run, log }) {
  let running = false
  let rerun = false
  /** @type {Promise<void>} */
  let idle = Promise.resolve()
  /** @type {(() => void) | null} */
  let resolveIdle = null

  /** @param {string} reason */
  function schedule(reason) {
    if (running) {
      // A pass is already running off the tick loop; coalesce this edge into
      // a single re-run rather than starting a concurrent pass.
      rerun = true
      return
    }
    running = true
    idle = new Promise((resolve) => { resolveIdle = resolve })
    void pump(reason)
  }

  /** @param {string} reason */
  async function pump(reason) {
    let nextReason = reason
    try {
      do {
        // Clear the flag before awaiting: any edge during this `run` flips it
        // back on (the only interleaving point), driving exactly one re-run.
        rerun = false
        await run(nextReason)
        nextReason = 'rerun'
      } while (rerun)
    } catch (err) {
      log?.error('daemon.reconcile_pass_failed', {
        [Attr.COMPONENT]: 'daemon',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      running = false
      const resolve = resolveIdle
      resolveIdle = null
      resolve?.()
    }
  }

  return { schedule, settle: () => idle }
}

/**
 * Resolve the client-action seam (LLP 0045 §Part 1) the attach handler reads
 * off the reconcile context: the static `clientDescriptors` catalog the boot
 * built, and — only when the AI gateway plugin is enabled — the runtime gateway
 * capability (`clients`) plus its local base URL (`endpoint`).
 *
 * The split is load-bearing: `clientDescriptors` carries the owning-plugin field
 * the registry lacks (for `desired()`'s "is this client's plugin enabled?" and
 * the disk-driven undo's `attachProbe`), while `clients` only *invokes* the
 * effect (`getClient(name).attach`). A client adapter requires the gateway
 * capability (LLP 0016), so whenever a client plugin is enabled the gateway is
 * too; on a non-gateway boot `clients`/`endpoint` stay undefined and the attach
 * handler is inert by construction.
 *
 * `endpoint` is the live `localEndpoint()` and *only* that — a **proven-bound**
 * gateway URL. The gateway source is already bound by the time the reconciler is
 * constructed (`startConfiguredSources` ran during boot), so `localEndpoint()`
 * returns the real bound port. If it throws — the gateway never bound (e.g. its
 * listen failed) — the daemon must **not** fall back to the configured-`listen`
 * URL: auto-attach is involuntary, and recording a base URL for a port nothing
 * bound would point clients at a dead endpoint. Instead `endpoint` stays
 * undefined and the attach handler's `perform()` guard keeps it inert this pass
 * (attaching once the gateway is proven-bound on a later boot). Manual
 * `hyp attach`/`init` keep the configured-`listen` fallback — there the user
 * asked explicitly (`core_commands.js`).
 *
 * @param {{ boot: BootKernelResult, fileLog: ReturnType<typeof openDaemonLog> }} args
 * @returns {{ clientDescriptors: Map<string, ClientDescriptor>, clients: AiGatewayCapability | undefined, endpoint: string | undefined }}
 * @ref LLP 0045#part-1--the-client-seam-in-the-reconcile-context [implements] — clientDescriptors from the catalog; clients/endpoint from boot.runtime.capabilities, guarded on the gateway capability; daemon endpoint requires a proven-bound localEndpoint() (no configured-listen fallback — that's the manual path's)
 */
function resolveClientActionSeam({ boot, fileLog }) {
  const clientDescriptors = boot.clientDescriptors
  /** @type {AiGatewayCapability | undefined} */
  let clients
  /** @type {string | undefined} */
  let endpoint

  if (boot.runtime.capabilities.has('hypaware.ai-gateway', '^2.0.0')) {
    clients = /** @type {AiGatewayCapability} */ (
      boot.runtime.capabilities.require('hyp-core', 'hypaware.ai-gateway', '^2.0.0')
    )
    try {
      endpoint = clients.localEndpoint()
    } catch {
      // The gateway never bound (e.g. its listen failed). Unlike manual
      // `hyp attach`, the daemon does NOT fall back to the configured-`listen`
      // URL — auto-attach must never record a base URL for an unbound port.
      // Leave `endpoint` undefined; the handler stays inert until a later boot
      // observes a proven-bound gateway.
      endpoint = undefined
    }
    if (!endpoint) {
      fileLog.warn('daemon.attach_endpoint_unresolved', {
        hyp_reason: 'no_bound_local_endpoint',
      })
    }
  }

  return { clientDescriptors, clients, endpoint }
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
 * Turn a raw source-start error into an operator-actionable message.
 * The common failure is a port collision (EADDRINUSE): a second
 * HypAware daemon or an unrelated service already holds the gateway
 * port. The bare Node string ("listen EADDRINUSE ... 127.0.0.1:8787")
 * doesn't say what to do, so this appends the remedy.
 *
 * @param {unknown} err
 * @param {string} source
 * @returns {string}
 */
function describeSourceStartError(err, source) {
  const base = err instanceof Error ? err.message : String(err)
  if (/EADDRINUSE/.test(base)) {
    const addr = base.match(/[\d.]+:\d+/)?.[0] ?? 'its configured address'
    return `${base}. Source '${source}' could not bind ${addr}; another process (a second HypAware daemon or an unrelated service) already holds it. Stop that process or change the listen address, then restart the daemon.`
  }
  return base
}

/**
 * Start every registered source that has not auto-started during
 * `activate()`. Returns one snapshot per source (including the
 * already-started ones) so the status file lists everything the
 * operator expects to see.
 *
 * @param {{ runtime: KernelRuntime, log: ReturnType<typeof getLogger>, fileLog: ReturnType<typeof openDaemonLog> }} args
 * @returns {Promise<SourceSnapshot[]>}
 */
async function startConfiguredSources({ runtime, log, fileLog }) {
  /** @type {SourceSnapshot[]} */
  const snapshots = []
  for (const contribution of runtime.sources.list()) {
    const plugin = contribution.plugin
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
      const message = describeSourceStartError(err, contribution.name)
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
 * Best-effort source `.status()` invocation (failures should not
 * abort the daemon's snapshot capture).
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
 * driver doesn't surface failure / next-tick fields, so those stay
 * `undefined`.
 *
 * @param {{ runtime: KernelRuntime, sinkSnapshots: Map<string, SinkSnapshot> }} args
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
  resolveClientActionSeam,
}
