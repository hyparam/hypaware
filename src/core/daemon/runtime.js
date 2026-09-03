// @ts-check

import process from 'node:process'

import {
  Attr,
  buildAttrs,
  getKernelInstruments,
  getLogger,
  getTracer,
  installObservability,
  runRoot,
  SpanStatusCode,
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
import { createBackfillSweepDriver } from './backfill_sweep.js'
import {
  clearControlRequests,
  watchControlRequests,
  writeControlRequest,
} from './control.js'
import {
  clearPidFile,
  pidFilePath,
  processIsAlive,
  readPidFile,
  writePidFile,
} from './pid.js'
import { openDaemonLog } from './logs.js'
import { statusFilePath, summarizeMaintenanceSkips, writeStatusFile } from './status.js'
import {
  detectSupervisor,
  readSelfPackageIdentity,
  runSelfUpdatePass,
  writeSelfUpdateState,
} from '../update/self_update.js'

/**
 * @import { AiGatewayCapability, ClientRegistry, JsonObject } from '../../../hypaware-plugin-kernel-types.js'
 * @import { KernelRuntime } from '../../../src/core/runtime/types.js'
 * @import { BootKernelResult } from '../../../src/core/runtime/types.js'
 * @import { ClientDescriptor } from '../../../src/core/types.js'
 * @import { ActionHandler } from '../../../src/core/config/types.js'
 */

/**
 * @import {
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
 * (possibly multi-minute) `hyp backfill` subprocess, so attach, an in-process
 * settings write, must lead, or live capture is stranded behind the historical
 * import. Exported so the ordering is a unit-testable invariant.
 *
 * @type {ActionHandler[]}
 * @ref LLP 0045#module--seam-breakdown-independently-mergeable-tasks [implements]: register [attachHandler, backfillHandler], attach first so live capture leads the backfill subprocess
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
 * How long a restart shutdown may run before the process exits by force.
 * Generous: an in-flight reconcile pass gets to finish its import and a
 * slow sink close gets its budget. It is not a tuning knob for graceful
 * shutdown, it is the ceiling on how long attached clients can be refused
 * by a daemon that has stopped listening but not yet exited.
 */
export const RESTART_EXIT_DEADLINE_MS = 120_000

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
 *  6. SIGTERM / SIGINT / a `stop.request` control file /
 *     `handle.stop()` flip the daemon into `stopping`, stop every
 *     source (each one inside a `source.stop` span), close the daemon
 *     log, write `stopped`, and remove the PID file. `daemon.shutdown`
 *     is the explicit child span the smoke greps for.
 *  7. SIGHUP / a `reload.request` control file / `handle.reload()`
 *     re-runs config diff: removed sources stop, new sources start,
 *     unchanged sources `reload()`. The control files (LLP 0300) are
 *     the win32 transport for both verbs; on POSIX signals remain
 *     primary and the file channel is a second door.
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
  /** @type {((reason: 'signal'|'manual'|'restart'|'control') => Promise<number>) | null} */
  let triggerShutdown = null
  let shutdownInFlight = false
  /** @type {((value: number) => void) | null} */
  let resolveDone = null
  /** @type {Promise<number>} */
  const done = new Promise((resolve) => { resolveDone = resolve })
  /** @type {(() => Promise<void>) | null} */
  let triggerReload = null
  /** @type {{ close(): void } | null} */
  let controlWatcher = null
  // Forward reference to the client-action reconcile scheduler. It can only
  // be built after `boot` resolves (it needs the effective config + the
  // kernel backfill registry), but the confirmation-edge hook below is wired
  // into `configControl` before boot, so the hook calls through this ref and
  // an edge that fires before the scheduler exists is recovered by the
  // after-activation already-confirmed pass (mirrors `pendingRestart`).
  /** @type {((reason: string) => void) | null} */
  let scheduleReconcile = null
  let healthyAtMs = 0

  // Stale control requests are consumed before the PID file goes down: a
  // `stop.request` that survived a crash or a hard kill is an instruction to
  // a daemon that no longer exists, and must not stop this boot on sight.
  // Best-effort per file, and it cannot block the boot. A leftover the clear
  // could not remove (win32 EPERM/EBUSY from a dying writer, a directory
  // squatting on the name) is handed to the watcher below as stale: if the
  // failure was transient the watcher will be able to consume the file
  // later, and without the handoff it would mistake that leftover for a
  // live request and stop the freshly booted daemon.
  // @ref LLP 0300#boot-clears-stale [implements]: leftovers are cleared, or recorded so they can never dispatch
  const staleControlRequests = clearControlRequests(stateRoot)
  for (const [request, info] of Object.entries(staleControlRequests)) {
    fileLog.warn('daemon.control_clear_failed', { request, message: info.message })
  }

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

  // ----- Kernel self-update (LLP 0309) -----
  // Cache the effective auto_update flag so the import-light pre-boot
  // lane (bin/hypaware.js) can honor the off switch without parsing
  // config layers.
  // @ref LLP 0309#config-key [implements]: the booted daemon caches the effective flag for the pre-boot lane
  let autoUpdateEnabled = true
  // What this process loaded. Read once, at boot: the global root can be
  // replaced underneath a running daemon, and the updater has to compare
  // the registry against the code that is actually running, not the code
  // on disk, or a replaced root reads as "up to date" while the daemon
  // stays on the old version.
  // @ref LLP 0365#running-version-is-tracked [implements]: the daemon records the version it booted; the updater compares against it
  /** @type {string | undefined} */
  let runningVersion
  try {
    runningVersion = readSelfPackageIdentity().version
  } catch { /* an install mid-replacement; the disk version stands in */ }
  const supervised = detectSupervisor(env)
  /**
   * Re-derive the effective flag and re-cache it. Called at boot and
   * again after every reload: SIGHUP re-merges both config layers, and a
   * flag captured once at boot would leave the daily lane running (and
   * the cache advertising `true` to the pre-boot lane) after an operator
   * turned auto-update off and reloaded.
   *
   * The same write carries the running version and clears the failed-boot
   * count: reaching this line means the kernel came up on this version.
   */
  function refreshAutoUpdateFlag() {
    autoUpdateEnabled = boot.config?.auto_update !== false
    try {
      writeSelfUpdateState(stateRoot, {
        auto_update: autoUpdateEnabled,
        boot_failures: 0,
        // Written unconditionally, so a boot that could not read its own
        // version clears the field instead of leaving the previous
        // daemon's there: a stale value reads as "installed X, running Y"
        // against a live pid and earns a restart nothing needs.
        running_version: runningVersion,
      })
    } catch (err) {
      fileLog.warn('self_update.flag_cache_failed', {
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  refreshAutoUpdateFlag()
  let selfUpdateInFlight = false

  // ----- Client-action reconciler (LLP 0036 / LLP 0037 / LLP 0041 / LLP 0045) -----
  // The daemon is the only host with `configControl`, so a reconciler
  // attached here is daemon-only by construction: `hyp status` (a plain CLI
  // boot) never performs a machine effect. v1 ships two handlers, attach
  // (LLP 0045) and the run-once backfill-on-join (LLP 0037). Constructed only
  // after boot because a pass needs the effective config + the kernel backfill
  // registry, and the attach seam reads the gateway capability the boot bound.
  // @ref LLP 0041#the-reconciler-component [implements]: construct the reconciler in the daemon
  const actionReconciler =
    opts.actionReconciler ??
    createActionReconciler({
      stateRoot,
      // Attach first so in-process live-capture wiring starts ahead of the
      // (possibly multi-minute) backfill subprocess: the reconciler runs
      // handlers serially and `backfillHandler.perform()` awaits its child, so
      // attach-first avoids stranding live capture behind the historical import
      // (data is order-insensitive, this is purely the latency ordering).
      // @ref LLP 0045#module--seam-breakdown-independently-mergeable-tasks [implements]: register [attachHandler, backfillHandler], attach first
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
  //    `localEndpoint()` (no configured-`listen` fallback on the daemon path:
  //    auto-attach must never record a URL for a port nothing bound).
  // All three stay undefined on a non-gateway boot, leaving the attach handler
  // inert by construction.
  //
  // Resolved ONCE here and then closed over by `runReconcilePass` below: the
  // same `clientSeam` is reused, unchanged, for every reconcile pass for the
  // daemon's lifetime, it is never re-derived per pass. So a pass can never
  // observe a half-resolved seam (e.g. a transiently-empty `clients`); the
  // attach handler's `desired()` always reads the fully-resolved-at-boot value,
  // and reversal can never over-fire on a momentary `clients` gap.
  // @ref LLP 0045#part-1-the-client-seam-in-the-reconcile-context [implements]: daemon resolves clientDescriptors from the catalog, clients/endpoint from boot.runtime.capabilities when the gateway is enabled
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
          // Undefined on a non-gateway boot: the handler stays inert.
          clientDescriptors: clientSeam.clientDescriptors,
          clients: clientSeam.clients,
          endpoint: clientSeam.endpoint,
          // The skills and subagents an org-driven attach materializes, from
          // the same registries `hyp skills install` reads. Bytes come from
          // locally installed plugin packages, never from org config.
          // @ref LLP 0107#every-attach [implements]: the reconciler's attach
          //   installs client assets, so an enrolled machine gets the helper
          //   skills without anyone re-running login
          skills: boot.runtime.skills,
          agents: boot.runtime.agents,
          // What this boot did NOT get. The registries above describe a partial
          // plugin set whenever a plugin threw, was eliminated by the dep graph,
          // failed to load, or was withheld by the profile, and the materializer
          // has no other way to tell that hole from a set of retirements. Taken
          // whole from boot rather than re-derived from `activations`, which
          // only ever sees the first of those four.
          // @ref LLP 0219#incomplete-activation-prunes-nothing [implements]: an
          //   incomplete activation copies but removes nothing
          failedPlugins: boot.unavailablePlugins,
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

  // ----- Backfill sweep driver -----
  // Rides the sink tick below rather than owning a timer of its own: a
  // contribution's coarsest useful schedule still only needs a due-check once
  // a minute, which is exactly this loop's cadence.
  const sweepDriver = createBackfillSweepDriver({
    backfills: boot.runtime.backfills,
    backfillMaterializers: boot.runtime.backfillMaterializers,
    env,
    storage: boot.runtime.storage,
    query: boot.runtime.query,
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
  /**
   * How long a source's `status()` may take before the tick gives up on it.
   * `status()` is plugin code and the kernel contract puts no bound on it. It
   * used to be awaited only at boot, where a probe that never settles is at
   * least loud: the daemon does not start. On the tick path a hang is silent
   * and total - `persist()` is downstream of the refresh, so *every* field in
   * `status.json` freezes, not just that source's, while the daemon goes on
   * reporting itself healthy; and the shutdown refresh would hang
   * `hyp daemon stop` with it. Well under the tick interval floor so a slow
   * probe cannot overlap itself into the next tick.
   */
  const SOURCE_STATUS_TIMEOUT_MS = 5000

  /**
   * Last failure message logged per source, so a persistently broken probe
   * says so once instead of once per tick forever.
   *
   * @type {Map<string, string>}
   */
  const sourceProbeFailures = new Map()

  /** @type {Set<string>} */
  const sourceProbesInFlight = new Set()

  /**
   * Probe one source's `status()` details under a timeout, and never let the
   * plugin's promise outlive our interest in it. A timed-out probe cannot be
   * cancelled, so the source is skipped until its previous call settles.
   * Otherwise a permanently hung probe would start (and hold open) a fresh
   * `source.status` span on every tick for the daemon's life.
   *
   * @param {string} name
   * @returns {Promise<{ details: object | undefined, failure: string | undefined }>}
   */
  async function probeSourceDetails(name) {
    if (sourceProbesInFlight.has(name)) {
      return { details: undefined, failure: 'previous status probe has not settled' }
    }
    sourceProbesInFlight.add(name)
    const settle = () => sourceProbesInFlight.delete(name)
    const probe = boot.runtime.sources.status(name).then((s) => s?.details ?? undefined)
    probe.then(settle, settle)
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    try {
      const details = await Promise.race([
        probe,
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`status probe exceeded ${SOURCE_STATUS_TIMEOUT_MS}ms`)),
            SOURCE_STATUS_TIMEOUT_MS
          )
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
      return { details: /** @type {object | undefined} */ (details), failure: undefined }
    } catch (err) {
      return { details: undefined, failure: err instanceof Error ? err.message : String(err) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Report a probe outcome at most once per transition. The refresh runs every
   * tick, so logging each failure unconditionally would turn one broken plugin
   * into a log line every tick for the daemon's life; logging none at all - the
   * old `safeStatus` behaviour - leaves an operator with a source whose details
   * silently never change and nothing anywhere saying why.
   *
   * @param {string} name
   * @param {string | undefined} failure
   */
  function noteProbeOutcome(name, failure) {
    const previous = sourceProbeFailures.get(name)
    if (failure === undefined) {
      if (previous === undefined) return
      sourceProbeFailures.delete(name)
      fileLog.info('daemon.source_status_recovered', { hyp_source: name })
      return
    }
    if (previous === failure) return
    sourceProbeFailures.set(name, failure)
    fileLog.warn('daemon.source_status_failed', {
      hyp_source: name,
      message: failure,
      error_kind: 'source_status_probe',
    })
  }

  /**
   * Re-read every started source's `status()` details into the snapshot
   * list. Boot writes the details once (`startConfiguredSources`), which
   * was enough while every detail was fixed at bind time (host, port,
   * fallback marker). It is not enough for details that accrue as traffic
   * flows: the gateway's `recent_entrypoints` would be frozen at "nothing
   * seen yet" for the daemon's whole life, and `hyp status` reads exactly
   * this file. Name, plugin, and state are left alone - liveness is the
   * lifecycle's business, not a status probe's.
   *
   * Best-effort per source: a source whose probe throws, times out, or
   * returns nothing keeps the details it already had rather than losing
   * them, and one bad source never blocks the next one or the persist
   * below.
   *
   * @ref LLP 0164#status-reads-it-from-the-status-file [implements]: the tick refreshes source details so accruing details reach status.json
   */
  async function refreshSourceDetails() {
    for (const snap of status.sources) {
      if (snap.state !== 'started') continue
      const { details, failure } = await probeSourceDetails(snap.name)
      if (details !== undefined) snap.details = details
      noteProbeOutcome(snap.name, failure)
    }
  }

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
        // The scheduled backfill sweep (LLP 0170) rides this same tick. The
        // await covers only the cron due-check and the fire: each due
        // provider's run is started unblocked inside `tick`, so a slow
        // transcript scan never stalls the sink snapshots, the source-detail
        // refresh, or `persist()` below.
        // @ref LLP 0172#lane-b-sweep [implements]: one sibling call on the existing 60-second loop, not a second timer
        await sweepDriver.tick({ now })
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
    await refreshSourceDetails()
    persist()

    // The daily self-update check rides this tick rather than owning a
    // timer (same shape as the backfill sweep above). The pass itself
    // is TTL-gated and provenance-guarded, so this is a cheap state
    // read on almost every tick. An applied update exits through the
    // staged-restart path: the service manager relaunches onto the new
    // code.
    // @ref LLP 0309#cadence [implements]: boot + daily with jitter, applied via the staged restart
    if (autoUpdateEnabled && !selfUpdateInFlight) {
      selfUpdateInFlight = true
      void runSelfUpdatePass({
        stateRoot,
        env,
        autoUpdate: autoUpdateEnabled,
        runningVersion,
        // A restart exit is only an update when something relaunches us;
        // hand-run in a terminal, the pass installs nothing and says why.
        supervised,
        log: (event, fields) => fileLog.info(event, fields ?? {}),
      }).then((result) => {
        if (result.action === 'updated' && triggerShutdown) {
          void triggerShutdown('restart')
        }
      }).catch((err) => {
        // `runSelfUpdatePass` never throws, but the restart handler above
        // can, and an unhandled rejection is a dead daemon under Node's
        // default `--unhandled-rejections=throw`.
        fileLog.error('self_update.tick_failed', {
          message: err instanceof Error ? err.message : String(err),
        })
      }).finally(() => { selfUpdateInFlight = false })
    }
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
    const { createRetentionEnforcer } = await import('../cache/retention.js')
    const mCfg = normalizeMaintenanceConfig(maintenanceCfg)
    const intervalMs = mCfg.interval_minutes * 60 * 1000
    // @ref LLP 0336#rides-the-maintenance-tick [implements]: the retention
    // window `hyp status` reports is enforced here, on the tail of the
    // maintenance tick, not by `maintainCache` (whose only age cutoff is
    // Iceberg snapshot expiry) and not by a timer of its own.
    //
    // Built per pass rather than once, because `createRetentionEnforcer`
    // normalizes the window at construction and `reload()` reassigns
    // `boot.config`. A boot-time enforcer would keep deleting at the old
    // window while `hyp status` reads the new one off disk, which is issue
    // #1131's divergence coming back through the reload door - and in the
    // direction that matters most, since an operator who RAISES the window
    // after a scare and sends SIGHUP is the one who cannot afford to still
    // be on the shorter one. At most once a day, so the cost is nothing.
    const buildRetention = () => createRetentionEnforcer({
      cacheRoot: boot.runtime.storage.cacheRoot,
      config: boot.config?.query?.cache?.retention,
      getDataset: (dataset) => boot.runtime.query.getDataset(dataset),
    })
    // @ref LLP 0336#daily-cadence [implements]: windows are whole days and a
    // non-skipped pass re-reads every data file's timestamp column, so the
    // pass runs on the first tick after boot and then at most daily. The
    // stamp advances only when a pass completes, so a failed pass retries on
    // the next maintenance tick instead of standing unenforced for a day.
    const retentionPassMinIntervalMs = 24 * 60 * 60 * 1000
    let retentionRanAtMs = 0
    // @ref LLP 0220#tick-reports-degraded [constrained-by]: not built on
    // `withSpan`. `withSpan` (src/core/observability/span_helpers.js)
    // derives the span's status code from the `status` attribute snapshot
    // taken at span-creation time, and sets it from that snapshot after the
    // callback resolves - so a status only known once the tick's report is
    // in hand (clean vs. degraded) cannot be conveyed by setting the
    // attribute inside the callback, the way every other `withSpan` caller
    // does: the post-hoc `setStatus(OK)` clobbers it. Managed inline here
    // with the tracer directly instead, so only this one call site's status
    // handling changes and `withSpan` (and everything else that calls it)
    // is untouched.
    async function runMaintenance() {
      const tracer = getTracer('daemon')
      const attrs = buildAttrs({
        [Attr.COMPONENT]: 'daemon',
        [Attr.OPERATION]: 'maintenance.tick',
        daemon_mode: mode,
        status: 'ok',
      })
      await tracer.startActiveSpan('maintenance.tick', { attributes: attrs }, async (span) => {
        try {
          const report = await maintainCache({
            cacheRoot: boot.runtime.storage.cacheRoot,
            budgetMs: mCfg.max_tick_ms,
            config: mCfg,
            // @ref LLP 0027#re-settle-sweep: thread the dataset's
            // re-settle hook (same enricher the flush path uses) so
            // compaction can re-settle committed fallback rows split from
            // their uuid twin.
            storage: boot.runtime.storage,
            getSettleHook: (dataset) => boot.runtime.query.getDataset(dataset)?.resettleBatch,
            // @ref LLP 0311#migration: let the tick detect and run the
            // one-time re-partition when a dataset's declaration demoted
            // partition columns to sortOnly.
            getDeclaration: (dataset) => boot.runtime.query.getDataset(dataset)?.cachePartitioning,
          })
          // @ref LLP 0228#status-file-is-the-surface [implements]: the tick
          // stops discarding the report. A partition this walk deliberately
          // left fragmented was, until now, a span attribute and nothing
          // else, so an operator who did not have tracing on when the tick
          // ran had no way to find it at all.
          // @ref LLP 0311#migration [implements]: the swap rewrites the
          // user's live cache under a layout it has never held before, and
          // it happens once per partition, ever. `repartitioned` is set on
          // the span, but a tracer nobody was running when the tick fired
          // records nothing, so the migration also gets a durable line: it
          // is the only evidence afterwards that the layout moved, and when.
          for (const p of report.partitions) {
            if (!p.repartitioned) continue
            fileLog.info('daemon.cache_repartitioned', {
              [Attr.DATASET]: p.dataset,
              partition: JSON.stringify(p.partition),
              data_files_before: p.dataFilesBefore,
              data_files_after: p.dataFilesAfter,
              row_count: p.rowCount,
            })
          }
          // The same argument, for the case where the layout did NOT move.
          // A deferred migration is the state that most needs durable
          // evidence: the mismatch stands, and without a line here the only
          // record is a span attribute nobody was collecting.
          for (const p of report.partitions) {
            if (!p.repartitionDeferred) continue
            fileLog.warn('daemon.cache_repartition_deferred', {
              [Attr.DATASET]: p.dataset,
              partition: JSON.stringify(p.partition),
              data_files: p.dataFilesAfter,
            })
          }
          const skips = summarizeMaintenanceSkips(report)
          persist({ maintenance: skips })
          span.setAttribute('partitions_visited', skips.partitionsVisited)
          span.setAttribute('partitions_skipped', skips.skippedTotal)
          if (skips.skippedTotal > 0) {
            // The log line is the record and the status file is the
            // discovery (LLP 0228#status-file-is-the-surface). One line per
            // tick, not one per partition: the counts are the fact, and the
            // status file already names the worst of them.
            fileLog.warn('daemon.maintenance_skipped', {
              partitions_visited: skips.partitionsVisited,
              partitions_skipped: skips.skippedTotal,
              compaction_ineffective: skips.reasons.compaction_ineffective,
              compaction_attempt_failed: skips.reasons.compaction_attempt_failed,
              worst: skips.partitions[0]
                ? `${skips.partitions[0].dataset}/${skips.partitions[0].partition}`
                : null,
            })
          }
          // @ref LLP 0220#tick-reports-degraded [implements]: the walk now
          // survives a partition that throws, so the rejected promise has
          // stopped being how the daemon hears about one. Read the failures
          // off the report instead, or a tick that lost its neediest
          // partition would log exactly as a clean one does. The line names
          // the partitions, which the propagated exception never could.
          for (const p of report.partitions) {
            if (!p.failed) continue
            fileLog.error('daemon.maintenance_failed', {
              [Attr.DATASET]: p.dataset,
              partition: JSON.stringify(p.partition),
              [Attr.ERROR_KIND]: p.errorKind,
              message: p.errorMessage,
            })
          }
          const degraded = report.totalFailed > 0
          if (degraded) {
            span.setAttribute('status', 'degraded')
            span.setAttribute('partitions_failed', report.totalFailed)
          }
          span.setAttribute('partitions_maintained', report.partitions.length - report.totalFailed)
          // The status code itself, not just the attribute: only knowable
          // now that the report is in hand, so set directly rather than
          // through the status-attribute snapshot `withSpan` would
          // otherwise have read before the callback ran.
          span.setStatus(degraded
            ? { code: SpanStatusCode.ERROR, message: `${report.totalFailed} partition(s) failed` }
            : { code: SpanStatusCode.OK })
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          span.recordException(err)
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
          span.setAttribute('error_kind', attrs.error_kind ?? 'unhandled_exception')
          throw err
        } finally {
          span.end()
        }
      }).catch((err) => {
        // Still reachable: partition discovery, the retired-generation
        // sweep, and anything else outside the per-partition catch.
        const message = err instanceof Error ? err.message : String(err)
        fileLog.error('daemon.maintenance_failed', { message })
      })
      // Retention rides the tail of the same tick, so `maintenanceInFlight`
      // (and with it shutdown, which awaits it) covers a delete in progress.
      // It runs after `maintainCache`, never instead of it, and a
      // maintenance failure above does not cost the day's retention pass.
      if (Date.now() - retentionRanAtMs >= retentionPassMinIntervalMs) {
        await withSpan(
          'retention.tick',
          {
            [Attr.COMPONENT]: 'daemon',
            [Attr.OPERATION]: 'retention.tick',
            daemon_mode: mode,
            status: 'ok',
          },
          async (span) => {
            const result = await buildRetention().tick()
            let rowsDeleted = 0
            // A retention delete is the one cache mutation nothing can
            // reconstruct afterwards, so every partition that lost rows gets
            // a durable line, not only a child span a tracer may not have
            // been collecting when the pass fired.
            for (const evictedPart of result.evicted) {
              rowsDeleted += evictedPart.rowCount
              fileLog.info('daemon.retention_evicted', {
                [Attr.DATASET]: evictedPart.dataset,
                partition: evictedPart.partition,
                rows_deleted: evictedPart.rowCount,
              })
            }
            let partitionsEvicted = result.evicted.length
            for (const tableResult of result.sourceTableResults) {
              // A source-table partition with no resolvable timestamp column
              // is removed whole, directory and cursor included, and that is
              // a different sentence to the operator who reads this line
              // later than "rows were position-deleted from it".
              //
              // Asked BEFORE the zero-rows skip below, not after: that
              // removal reports `cursor.rowCount`, which is a count of
              // committed rows written by other passes and can legitimately
              // read 0 for a directory that still exists and is about to
              // stop existing. Skipping on it would delete the one thing
              // nothing can reconstruct and leave no line saying so, which
              // is exactly what #durable-line is for.
              if (tableResult.evictedPartition) {
                rowsDeleted += tableResult.rowsDeleted
                partitionsEvicted++
                fileLog.info('daemon.retention_evicted', {
                  [Attr.DATASET]: tableResult.dataset,
                  partition: `source=${tableResult.source}`,
                  cutoff_date: tableResult.cutoffDate,
                  rows_deleted: tableResult.rowsDeleted,
                })
                continue
              }
              if (tableResult.rowsDeleted === 0) continue
              rowsDeleted += tableResult.rowsDeleted
              fileLog.info('daemon.retention_rows_deleted', {
                [Attr.DATASET]: tableResult.dataset,
                source: tableResult.source,
                cutoff_date: tableResult.cutoffDate,
                rows_deleted: tableResult.rowsDeleted,
              })
            }
            span.setAttribute('partitions_evicted', partitionsEvicted)
            span.setAttribute('rows_deleted', rowsDeleted)
            retentionRanAtMs = Date.now()
          },
          { component: 'daemon' }
        ).catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          fileLog.error('daemon.retention_failed', { message })
        })
      }
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
  /** @param {'signal'|'manual'|'restart'|'control'} reason */
  async function shutdown(reason) {
    if (shutdownInFlight) return done
    shutdownInFlight = true
    // Close the control watcher first: reconcile settle below can hold
    // shutdown open for minutes, and a reload.request landing in that window
    // must not dispatch reload() into sources that are being stopped (or log
    // through a fileLog that is closed further down). The request that
    // triggered this shutdown was already consumed before dispatch, and any
    // file written from here on is cleared by the next boot.
    controlWatcher?.close()
    controlWatcher = null
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
    // A restart that never finishes exiting is a dead daemon with a live
    // pid: the listeners are closed below, so clients get refused, and the
    // service manager sees a running process and relaunches nothing. Past
    // the deadline the exit is forced with the restart code so the
    // relaunch happens anyway. Only under a supervisor: unsupervised, a
    // forced exit turns a wedged daemon into a missing one, and the
    // timer is unref'd so it can never be what keeps the process alive.
    //
    // Armed here rather than at the top of shutdown, so the deadline
    // covers the part that can wedge (a client stream holding a source's
    // `server.close()` open) and not the reconcile pass the line above
    // deliberately waits for: `hyp backfill` is a multi-minute import by
    // design, and forcing an exit through it is the orphaned child and
    // lost marker that settle exists to prevent.
    // @ref LLP 0365#restart-exit-is-bounded [implements]: a restart shutdown that overruns is exited by force so the supervisor relaunches
    if (reason === 'restart' && supervised) {
      const forced = setTimeout(() => {
        try {
          fileLog.error('daemon.restart_exit_forced', { after_ms: RESTART_EXIT_DEADLINE_MS })
        } catch { /* the log may already be closed */ }
        process.exit(DAEMON_RESTART_EXIT_CODE)
      }, RESTART_EXIT_DEADLINE_MS)
      forced.unref()
    }
    // Last chance to capture accruing source details: the sources are still
    // running here, and after `stopAllSources` below their probes are gone.
    // A daemon that never reached a tick (or stopped between ticks) would
    // otherwise leave a status file claiming no client was ever seen.
    await refreshSourceDetails()
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
        refreshAutoUpdateFlag()
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

  // reload() rethrows through withSpan and has no top-level catch, so a bare
  // `void reload()` from a signal handler or the control watcher would turn
  // a failed reload (an unreadable config layer, a throwing source) into an
  // uncaught rejection that kills the daemon.
  const reloadSafely = () => {
    reload().catch((err) => {
      fileLog.error('daemon.reload_failed', {
        message: err instanceof Error ? err.message : String(err),
      })
    })
  }

  // ----- Signal wiring -----
  const sigTermHandler = () => { void shutdown('signal') }
  const sigIntHandler = () => { void shutdown('signal') }
  const sigHupHandler = () => { reloadSafely() }

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

  // ----- Control-file channel (LLP 0300) -----
  // Installed on every platform: it is the only stop/reload transport on
  // win32 (a cross-process SIGTERM there is TerminateProcess, skipping this
  // whole shutdown path) and a harmless second door on POSIX. Dispatches
  // into the same shutdown/reload the signal handlers call.
  // @ref LLP 0300#file-channel [implements]: the watcher is the signal handlers' transport-agnostic twin
  // Best-effort like the boot-time clear above: a squatting file or a
  // foreign-owned directory at run/control must not take down a daemon whose
  // sources are already running and whose PID file is on disk. Signals still
  // stop it everywhere but win32.
  try {
    // TODO(win32): the watcher installs at the tail of runDaemon, after
    // bootKernel and every source start, so a stop request written during
    // that window times out even though it is honored moments later, and a
    // boot that hangs has no win32 stop path at all. When the Windows
    // service installer lands, arm the handlers next to writePidFile with
    // the same forward-reference/park pattern triggerShutdown already uses.
    controlWatcher = watchControlRequests(stateRoot, {
      onStop: () => { void shutdown('control') },
      onReload: () => { reloadSafely() },
      log: fileLog,
      staleRequests: staleControlRequests,
      bootedAtMs: startedAtMs,
    })
  } catch (err) {
    fileLog.warn('daemon.control_watch_install_failed', {
      message: err instanceof Error ? err.message : String(err),
    })
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
 * built, and, only when the AI gateway plugin is enabled, the runtime gateway
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
 * `endpoint` is the live `localEndpoint()` and *only* that: a **proven-bound**
 * gateway URL. The gateway source is already bound by the time the reconciler is
 * constructed (`startConfiguredSources` ran during boot), so `localEndpoint()`
 * returns the real bound port. If it throws, the gateway never bound (e.g. its
 * listen failed), the daemon must **not** fall back to the configured-`listen`
 * URL: auto-attach is involuntary, and recording a base URL for a port nothing
 * bound would point clients at a dead endpoint. Instead `endpoint` stays
 * undefined and the attach handler's `perform()` guard keeps gateway-backed
 * clients inert this pass (attaching once the gateway is proven-bound on a
 * later boot). Endpoint-free clients can still attach. Manual
 * `hyp attach`/`init` keep the configured-`listen` fallback: there the user
 * asked explicitly (`core_commands.js`).
 *
 * @param {{ boot: BootKernelResult, fileLog: ReturnType<typeof openDaemonLog> }} args
 * @returns {{ clientDescriptors: Map<string, ClientDescriptor>, clients: ClientRegistry | undefined, endpoint: string | undefined }}
 * @ref LLP 0045#part-1-the-client-seam-in-the-reconcile-context [implements]: clientDescriptors and the intrinsic client registry always reach reconciliation; only gateway-backed attaches require the separately proven live endpoint
 */
function resolveClientActionSeam({ boot, fileLog }) {
  const clientDescriptors = boot.clientDescriptors
  let clients = boot.runtime.clients
  /** @type {string | undefined} */
  let endpoint

  if (boot.runtime.capabilities.has('hypaware.ai-gateway', '^2.0.0')) {
    const gateway = /** @type {AiGatewayCapability} */ (
      boot.runtime.capabilities.require('hyp-core', 'hypaware.ai-gateway', '^2.0.0')
    )
    clients ??= gateway
    try {
      endpoint = gateway.localEndpoint()
    } catch {
      // The gateway never bound (e.g. its listen failed). Unlike manual
      // `hyp attach`, the daemon does NOT fall back to the configured-`listen`
      // URL: auto-attach must never record a base URL for an unbound port.
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
 * How long `requestDaemonStop` waits for the signalled daemon to exit before
 * it gives up and reports `timed_out`. The wait is on the process, not on the
 * pid file: the daemon clears that file partway through its own shutdown, and
 * the telemetry close whose ceiling is checked against this number runs after
 * it, on the way out of `bin/hypaware.js`. Waiting on liveness is what keeps
 * that close inside the window.
 *
 * Named rather than inline because the telemetry close inside that window has
 * a derived ceiling of its own (`SHUTDOWN_BUDGET_MS`), and the two used to be
 * only coincidentally compatible: three serial channel closes hung at once
 * spent about 3.75s of this 5s (hyparam/hypaware#1153 item 1). The closes are
 * concurrent now, so the telemetry ceiling is one budget, and a test pins the
 * relationship so it stays a checked fact rather than a coincidence.
 *
 * @ref LLP 0343#stop-window [implements]: the stop window is a named constant the telemetry ceiling is checked against
 */
export const DAEMON_STOP_TIMEOUT_MS = 5_000

/**
 * `hyp daemon stop` helper. Reads the PID file, requests an orderly stop,
 * and waits (up to `timeoutMs`) for the process itself to go away, then
 * clears the PID file on its behalf. Returns the resulting state for the
 * command body to render.
 *
 * The request transport is per-platform: POSIX sends SIGTERM (the proven
 * path, and what the service managers speak regardless); win32 writes a
 * `stop.request` control file instead, because a cross-process SIGTERM
 * there is `TerminateProcess` - a hard kill that skips the shutdown path,
 * leaves the PID file stale, and drops unflushed log lines.
 *
 * @ref LLP 0300#posix-keeps-signals [implements]: only win32 routes through the file channel
 * @param {{ stateRoot: string, timeoutMs?: number, pollIntervalMs?: number, platform?: NodeJS.Platform, log?: { warn(event: string, fields?: Record<string, unknown>): void } }} args
 * @returns {Promise<'stopped'|'not_running'|'timed_out'>}
 */
export async function requestDaemonStop({
  stateRoot,
  timeoutMs = DAEMON_STOP_TIMEOUT_MS,
  pollIntervalMs = 50,
  platform = process.platform,
  log,
}) {
  const entry = readPidFile(stateRoot)
  if (!entry || !processIsAlive(entry.pid)) {
    if (entry) clearPidFile(stateRoot)
    return 'not_running'
  }
  if (platform === 'win32') {
    writeControlRequest(stateRoot, 'stop', log)
  } else {
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
