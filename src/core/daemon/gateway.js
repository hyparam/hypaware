// @ts-check

import { fork } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { bootKernel } from '../runtime/boot.js'
import { cacheTablePath } from '../cache/paths.js'
import { installObservability } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { clearPidFile, processIsAlive, processingStateRoot, readPidFile, writePidFile } from './pid.js'
import { DAEMON_HEARTBEAT_STALE_MS, daemonHeartbeatAgeMs, readStatusFile, writeStatusFile } from './status.js'
import { clearControlRequests, watchControlRequests, writeControlRequest } from './control.js'
import { BOOT_FAILED_WARNING_PREFIX } from './boot_failure.js'
import { openDaemonLog } from './logs.js'

/**
 * @import { ChildProcess } from 'node:child_process'
 * @import { BootKernelResult } from '../../../src/core/runtime/types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { DaemonStatus, RunDaemonOptions, SourceSnapshot } from '../../../src/core/daemon/types.js'
 */

const PROCESSOR_ENTRY = fileURLToPath(new URL('./processor.js', import.meta.url))
// Resolved as a URL and dynamically imported (never a static specifier) so the
// declaration build's `rootDir: src` never has to contain plugin-workspace
// code, matching the kernel's existing entrypoint-only loader (../runtime/loader.js).
const PROCESS_TRANSPORT_ENTRY = new URL('../../../hypaware-core/plugins-workspace/ai-gateway/src/process_transport.js', import.meta.url).href
const RESTART_DELAY_MS = 1000
// `hyp status` dates the last write as `healthyAt + uptimeMs` against a
// five-minute staleness window, so the status file has to keep being re-dated
// even when nothing changed - but only on this cadence, not on every recompute.
const STATUS_HEARTBEAT_MS = 30_000
// Leave time for the CLI's five-second stop wait to observe the exit.
const STOP_DEADLINE_MS = 4_000

/**
 * The installed service owns the gateway; all kernel background work runs in
 * a child with a separate heap. An abnormal child exit restarts only the child.
 * A deliberate config/code restart (75) still replaces the whole service.
 * @ref LLP 0038#implemented-boundary [implements]: processor failure cannot close gateway sockets or reset its session opt-outs
 * @param {RunDaemonOptions} [opts]
 */
export async function runGatewayDaemon(opts = {}) {
  const env = opts.env ?? process.env
  const hypHome = opts.hypHome ?? readObservabilityEnv(env).hypHome
  const stateRoot = path.join(hypHome, 'hypaware')
  const processingRoot = processingStateRoot(stateRoot)
  const processingControlRoot = path.join(processingRoot, 'supervisor')
  const cacheRoot = path.join(stateRoot, 'cache')
  const startedAt = new Date().toISOString()
  const runId = opts.runId ?? `gateway-${process.pid}-${Date.now()}`
  installObservability()
  const previous = readPidFile(stateRoot)
  if (previous && processIsAlive(previous.pid)) throw new Error(`daemon already running (pid=${previous.pid})`)
  const log = openDaemonLog({ stateRoot, runId, mode: 'foreground' })
  /** @type {ChildProcess | undefined} */
  let child
  /** @type {BootKernelResult | undefined} */
  let boot
  /** @type {NodeJS.Timeout | undefined} */
  let restartTimer
  /** @type {NodeJS.Timeout | undefined} */
  let heartbeat
  /** @type {ReturnType<typeof watchControlRequests> | undefined} */
  let controls
  /** @type {ReturnType<typeof watchControlRequests> | undefined} */
  let processingControls
  /** @type {NodeJS.Timeout | undefined} */
  let processingStopTimer
  let stopping = false
  let refreshing = false
  let restarts = 0
  let failureStreak = 0
  let lastStatusShape = ''
  let lastStatusWriteMs = 0
  /** @type {(code: number) => void} */
  let resolveDone = () => {}
  const done = new Promise(resolve => { resolveDone = resolve })
  /** @type {DaemonStatus} */
  const status = { state: 'starting', pid: process.pid, startedAt, healthyAt: startedAt, uptimeMs: 0, runId, mode: 'foreground', sources: [], sinks: [] }
  const { createCaptureSender, setGatewayProcessTransport } = await import(PROCESS_TRANSPORT_ENTRY)
  const sender = createCaptureSender({ getChild: () => child, log })
  setGatewayProcessTransport({ role: 'gateway', ...sender })

  // A forwarder can register dataset contracts, but cannot read, append or
  // flush the cache, even if a future capture path accidentally asks it to.
  const storage = /** @type {ExtendedQueryStorageService} */ (new Proxy({
    cacheRoot,
    /** @param {string} dataset @param {string[]} segments */
    cacheTablePath: (dataset, segments) => cacheTablePath(cacheRoot, dataset, segments),
  }, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key)
      return () => { throw new Error(`gateway process cannot access storage.${String(key)}`) }
    },
  }))

  const stale = clearControlRequests(stateRoot)
  const staleProcessing = clearControlRequests(processingControlRoot)
  writePidFile(stateRoot, { pid: process.pid, startedAt, runId, mode: 'foreground' })
  writeStatusFile(stateRoot, status)
  log.info('gateway.starting')

  /** @returns {Promise<SourceSnapshot | undefined>} */
  async function gatewaySnapshot() {
    if (!boot?.runtime.sources.get('ai-gateway')) return undefined
    const sourceStatus = await boot.runtime.sources.status('ai-gateway')
    return { name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started', details: sourceStatus?.details }
  }

  async function refreshStatus() {
    if (refreshing || stopping) return
    refreshing = true
    try {
      const gateway = await gatewaySnapshot()
      /** @type {DaemonStatus | null} */
      let processor = null
      try { processor = readStatusFile(processingRoot) } catch { /* incomplete/unreadable child status is not ready */ }
      const matches = !!child?.pid && processor?.pid === child.pid
      // Derived exactly as `hyp status` derives it (LLP 0348), so the two can
      // never disagree about whether the child stopped ticking.
      const heartbeatAgeMs = matches ? daemonHeartbeatAgeMs(processor, Date.now()) : null
      const fresh = heartbeatAgeMs !== null && heartbeatAgeMs < DAEMON_HEARTBEAT_STALE_MS
      const ready = Boolean(fresh && processor?.state === 'healthy')
      status.state = ready ? 'healthy' : 'degraded'
      status.uptimeMs = Date.now() - Date.parse(startedAt)
      const sources = matches ? processor?.sources ?? [] : []
      status.sources = sources.filter(s => s.name !== 'ai-gateway').map(s => fresh ? s : { ...s, state: /** @type {const} */ ('failed'), error: 'processing daemon unavailable' })
      if (gateway) {
        const recorded = sources.find(s => s.name === 'ai-gateway')
        // Only the gateway proves the bound endpoint and live ignore set.
        const recordedDetails = /** @type {Record<string, unknown>} */ (recorded?.details ?? {})
        const liveDetails = /** @type {Record<string, unknown>} */ (gateway.details ?? {})
        gateway.details = { ...recordedDetails, ...liveDetails, recent_entrypoints: recordedDetails.recent_entrypoints ?? [] }
        status.sources.unshift(gateway)
      }
      status.sinks = matches ? processor?.sinks ?? [] : []
      status.maintenance = matches ? processor?.maintenance : undefined
      status.warnings = [...(matches ? processor?.warnings ?? [] : []), ...(!ready ? ['processing_unavailable: gateway forwarding remains available; recording and background work may be delayed or lost'] : [])]
      status.processes = { gateway: { pid: process.pid, state: gateway ? 'healthy' : 'disabled' }, processing: { pid: child?.pid, state: ready ? 'healthy' : 'degraded', restarts } }
      status.configPath = boot?.configPath ?? undefined
      // The aggregate is recomputed every tick so `snapshot()` and a child
      // transition stay immediately observable, but rewriting an unchanged file
      // once a second is ~86k idle disk writes a day on a daemon that runs for
      // weeks. Write on a real change, or on the heartbeat cadence.
      const shape = JSON.stringify([status.state, status.sources, status.sinks, status.maintenance, status.warnings, status.processes, status.configPath])
      const nowMs = Date.now()
      if (shape !== lastStatusShape || nowMs - lastStatusWriteMs >= STATUS_HEARTBEAT_MS) {
        lastStatusShape = shape
        lastStatusWriteMs = nowMs
        writeStatusFile(stateRoot, status)
      }
    } catch (error) {
      log.warn('gateway.status_failed', { message: String(error) })
    } finally { refreshing = false }
  }

  function spawnProcessor() {
    if (stopping) return
    sender.reset()
    const spawnedAt = Date.now()
    const next = fork(PROCESSOR_ENTRY, [], {
      env: { ...env, HYP_HOME: hypHome },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      // A test runner's --test/--input-type flags are not child entry flags.
      execArgv: opts.processingExecArgv ?? process.execArgv.filter(arg => !arg.startsWith('--test') && !arg.startsWith('--input-type')),
    })
    child = next
    next.on('message', sender.message)
    next.on('error', error => log.warn('processing.spawn_failed', { message: error.message }))
    next.on('exit', (code, signal) => {
      if (child !== next) return
      child = undefined
      clearTimeout(processingStopTimer)
      processingStopTimer = undefined
      sender.reset()
      log.warn('processing.exited', { code, signal, gateway_pid: process.pid })
      if (stopping) return
      if (code === 75) { void stop(75); return }
      restarts++
      if (Date.now() - spawnedAt >= 60_000) failureStreak = 0
      const delayMs = Math.min(30_000, RESTART_DELAY_MS * 2 ** Math.min(failureStreak++, 5))
      log.info('processing.restart_scheduled', { delay_ms: delayMs, restarts })
      restartTimer = setTimeout(spawnProcessor, delayMs)
      void refreshStatus()
    })
    void gatewaySnapshot().then(snapshot => {
      const details = /** @type {{ host?: string, port?: number } | undefined} */ (snapshot?.details)
      const host = details?.host
      const port = details?.port
      next.send({ type: 'processing.start', hypHome, configPath: opts.configPath, runtimeStateRoot: processingRoot, runId: `${runId}-processing-${restarts}`, tickIntervalMs: opts.tickIntervalMs, endpoint: host && port ? { host, port } : undefined }, error => {
        if (error) log.warn('processing.start_failed', { message: error.message })
      })
    }).catch(error => { log.warn('processing.start_failed', { message: String(error) }); next.kill() })
    log.info('processing.spawned', { processing_pid: next.pid, gateway_pid: process.pid, restarts })
  }

  function restartProcessing() {
    if (stopping || processingStopTimer || !child) return
    const target = child
    log.info('processing.restart_requested', { processing_pid: target.pid })
    // This watcher lives in the gateway, so a blocked processing event loop
    // cannot prevent its own replacement. Always target this specific child.
    processingStopTimer = setTimeout(() => {
      if (child === target) target.kill('SIGKILL')
    }, STOP_DEADLINE_MS)
    if (target.connected) target.send({ type: 'processing.stop' }, () => {})
  }

  /**
   * @param {number} [code]
   * @param {string} [bootFailure] The message of a boot that threw, when this
   *   is the unwind of a boot rather than a stop anyone asked for.
   */
  async function stop(code = 0, bootFailure) {
    if (stopping) return done
    stopping = true
    clearTimeout(restartTimer)
    clearTimeout(processingStopTimer)
    clearInterval(heartbeat)
    controls?.close()
    processingControls?.close()
    process.off('SIGTERM', onStop)
    process.off('SIGINT', onStop)
    process.off('SIGHUP', onReload)
    status.state = 'stopping'
    writeStatusFile(stateRoot, status)
    log.info('gateway.stopping', { code })
    // Bound the complete stop, including a client that never ends its stream.
    const deadline = setTimeout(() => {
      child?.kill('SIGKILL')
      process.exit(code)
    }, STOP_DEADLINE_MS)
    deadline.unref()
    if (child?.connected) child.send({ type: 'processing.stop' }, () => {})
    const stoppedChild = child
      ? new Promise(resolve => child?.once('exit', resolve))
      : Promise.resolve()
    try {
      await boot?.runtime.sources.stop('ai-gateway')
      await stoppedChild
    } finally {
      clearTimeout(deadline)
      setGatewayProcessTransport(undefined)
      // `stopped` is the record that a shutdown completed, and a boot that
      // threw never served, so writing it here reads a relaunch loop as the
      // operator's own `hyp daemon stop` (#1501). A failed boot takes the
      // shape `runDaemon` persists for one instead, which `hyp status` and the
      // self-updater's stuck-boot re-probe both already read.
      // @ref LLP 0383#the-signal-is-the-daemons-last-state [constrained-by]: only a shutdown that ran may write `stopped`, so a boot that threw writes the failure instead
      status.state = bootFailure ? 'degraded' : 'stopped'
      status.sources = status.sources.map(source => ({ ...source, state: 'stopped' }))
      if (status.processes) {
        status.processes.gateway.state = 'stopped'
        status.processes.processing.state = 'stopped'
      }
      if (bootFailure) status.warnings = [`${BOOT_FAILED_WARNING_PREFIX}: ${bootFailure}`]
      else status.stoppedAt = new Date().toISOString()
      writeStatusFile(stateRoot, status)
      clearPidFile(stateRoot)
      log.info('gateway.stopped', { code })
      await log.close()
      resolveDone(code)
    }
    return code
  }
  const onStop = () => { void stop() }
  // Reload is explicitly service-wide; a processor crash is not a reload.
  const onReload = () => { void stop(75) }

  try {
    boot = await bootKernel({ hypHome, configPath: opts.configPath, env, runId, mode: 'daemon', bootProfile: 'gateway', storage })
    const source = boot.runtime.sources.get('ai-gateway')
    if (!source && boot.config?.plugins?.some(plugin => plugin.name === '@hypaware/ai-gateway' && plugin.enabled !== false)) {
      throw new Error('configured gateway failed to activate')
    }
    if (source) {
      const ctx = boot.runtime.activationContexts?.get(source.plugin)
      if (!ctx) throw new Error('gateway activation context missing')
      await boot.runtime.sources.start(source.name, ctx)
    }
    log.info(source ? 'gateway.ready' : 'gateway.disabled', { gateway_pid: process.pid })
    if (opts.installSignalHandlers !== false) {
      process.on('SIGTERM', onStop)
      process.on('SIGINT', onStop)
      process.on('SIGHUP', onReload)
    }
    controls = watchControlRequests(stateRoot, { onStop, onReload, log, staleRequests: stale })
    processingControls = watchControlRequests(processingControlRoot, { onStop: restartProcessing, onReload: restartProcessing, log, staleRequests: staleProcessing })
    spawnProcessor()
    heartbeat = setInterval(() => { void refreshStatus() }, 1000)
    await refreshStatus()
    return { done, stop, snapshot: () => status, runtime: boot.runtime, restartProcessing: () => writeControlRequest(processingControlRoot, 'stop', log) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Onto the gateway's own log, so `recent_errors` counts the failure rather
    // than it reaching only stderr and the service's `daemon.err.log`.
    log.error('daemon.boot_failed', { message })
    await stop(1, message)
    throw error
  }
}
