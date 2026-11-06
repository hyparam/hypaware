// @ts-check

/**
 * The daemon's status file: writing and reading it, the live endpoints a
 * running daemon records in it, and how fresh its heartbeat is.
 *
 * @import { DaemonStatus, SourceSnapshot } from '../../../../src/core/daemon/types.js'
 */

import os from 'node:os'

import { endpointFromListen } from '../../config/gateway_endpoint.js'
import { statusFilePath } from '../../runtime/paths.js'
import { atomicWriteJsonSync, readFileIfExistsSync } from '../../util/fs_atomic.js'
import {
  processIsAlive,
  readPidFile,
} from '../pid.js'
import { parseIsoMs } from './values.js'
import { gatewaySourceDetails } from './gateway.js'
import { sourceDetails } from './sources.js'

/**
 * Write a status file atomically (write to `.tmp`, then rename). The
 * smoke harness asserts against this file directly so it must always
 * be either absent or fully formed. Partial writes would race the
 * SIGTERM assertion.
 *
 * @param {string} stateRoot
 * @param {DaemonStatus} status
 */
export function writeStatusFile(stateRoot, status) {
  atomicWriteJsonSync(statusFilePath(stateRoot), status)
}

/**
 * Read the status file. Returns `null` when no daemon has run for
 * this `HYP_HOME` yet. `hyp daemon status` surfaces that as
 * "daemon: not started" rather than an error.
 *
 * @param {string} stateRoot
 * @returns {DaemonStatus | null}
 */
export function readStatusFile(stateRoot) {
  const raw = readFileIfExistsSync(statusFilePath(stateRoot))
  if (raw === null) return null
  /** @type {unknown} */
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`readStatusFile: malformed entry at ${statusFilePath(stateRoot)}`)
  }
  return /** @type {DaemonStatus} */ (parsed)
}

/**
 * Resolve the AI gateway's live bound base URL from the on-disk daemon status
 * snapshot, **guarded by a daemon-liveness check** so a stale snapshot from a
 * dead daemon is never handed back. Returns `undefined` when no daemon is
 * running for this state root, no status file exists, or the gateway source
 * recorded no bound port.
 *
 * This is the discovery mechanism manual `hyp client attach` uses on a default
 * install: only the running daemon knows which port it actually bound (the
 * well-known default, its ephemeral fallback when that port was taken - LLP
 * 0114 - or a pre-0114 ephemeral bind), and the daemon persists it here
 * (issue #277 / LLP 0086). It never fabricates a port for a daemon that is
 * not running.
 *
 * @param {{ stateRoot: string }} args
 * @returns {string | undefined}
 * @ref LLP 0086#manual-attach-reads-the-live-port [implements]: resolve the live gateway URL from status.json, gated on a live pid
 */
export function resolveLiveGatewayEndpointFromStatus({ stateRoot }) {
  // Liveness gate first: a status.json outlives its daemon, so a bound port in
  // it proves nothing without a living process behind the pid file.
  let pidEntry
  try {
    pidEntry = readPidFile(stateRoot)
  } catch {
    return undefined
  }
  if (!pidEntry || !processIsAlive(pidEntry.pid)) return undefined

  /** @type {DaemonStatus | null} */
  let status
  try {
    status = readStatusFile(stateRoot)
  } catch {
    return undefined
  }
  const details = status ? gatewaySourceDetails(status.sources) : undefined
  if (!details) return undefined
  return endpointFromListen(`${details.host}:${details.port}`)
}

/**
 * Resolve a named listener source's live bound `listen_port` from the on-disk
 * daemon status snapshot, behind the same daemon-liveness gate as
 * {@link resolveLiveGatewayEndpointFromStatus}: a stale snapshot from a dead
 * daemon is never handed back, and no port is ever fabricated.
 *
 * The generic sibling of the gateway resolver above, for sources that publish
 * `details.listen_port` (the OTLP receiver, the Claude telemetry listener).
 * The first consumer is `hyp client attach claude` in `otel` mode: only the running
 * daemon knows which port the listener actually bound (its configured default,
 * or the ephemeral fallback when that port was taken), so the endpoint attach
 * writes must come from here whenever a daemon is up.
 *
 * @param {{ stateRoot: string, sourceName: string }} args
 * @returns {number | undefined}
 */
export function resolveLiveSourceListenPortFromStatus({ stateRoot, sourceName }) {
  const list = liveStatusSources(stateRoot)
  if (!list) return undefined
  const source = list.find((s) => s && s.name === sourceName)
  const details = sourceDetails(source)
  const port = details?.listen_port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined
  }
  return port
}

/**
 * Every live source advertising a named `/_hypaware/` control route in its
 * status details (`control_routes`), resolved to the base URL of its bound
 * listener.
 *
 * This is how `hyp session ignore` / `unignore` finds the recorders beyond
 * the gateway: a recorder that hosts the route says so in its own status
 * details, so the verb stays client-agnostic and a listener that is not
 * running (absent from a live snapshot, or no live daemon at all) is simply
 * not addressed - it is recording nothing, so there is nothing to notify.
 * The gateway itself is NOT discovered here; its endpoint has its own,
 * richer resolution (`status.json` plus the pinned `listen` fallback).
 *
 * @ref LLP 0256#cli-posts-to-both [implements]: the CLI addresses every
 * listener that offers the route; offering is advertised, never guessed
 * @param {{ stateRoot: string, route: string }} args
 * @returns {Array<{ source: string, endpoint: string }>}
 */
export function resolveLiveControlRouteEndpointsFromStatus({ stateRoot, route }) {
  const list = liveStatusSources(stateRoot)
  if (!list) return []
  /** @type {Array<{ source: string, endpoint: string }>} */
  const out = []
  for (const source of list) {
    if (!source || typeof source.name !== 'string') continue
    const details = sourceDetails(source)
    const routes = details?.control_routes
    if (!Array.isArray(routes) || !routes.includes(route)) continue
    const port = details?.listen_port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) continue
    const host = typeof details?.listen_host === 'string' && details.listen_host.length > 0
      ? details.listen_host
      : '127.0.0.1'
    const endpoint = endpointFromListen(`${host}:${port}`)
    if (endpoint) out.push({ source: source.name, endpoint })
  }
  return out
}

/**
 * The liveness-gated snapshot read shared by the resolvers above: a live pid
 * and a readable status file, or nothing. A `status.json` outlives its
 * daemon, so a bound port in it proves nothing without a living process
 * behind the pid file.
 *
 * @param {string} stateRoot
 * @returns {SourceSnapshot[] | undefined}
 */
function liveStatusSources(stateRoot) {
  let pidEntry
  try {
    pidEntry = readPidFile(stateRoot)
  } catch {
    return undefined
  }
  if (!pidEntry || !processIsAlive(pidEntry.pid)) return undefined

  /** @type {DaemonStatus | null} */
  let status
  try {
    status = readStatusFile(stateRoot)
  } catch {
    return undefined
  }
  return Array.isArray(status?.sources) ? status.sources : []
}

/**
 * How long the daemon's own status snapshot may go unwritten before
 * `hyp status` stops believing the `state` recorded in it.
 *
 * The daemon persists that snapshot at the end of every tick, and the tick
 * interval is fixed at 60s outside the test harnesses, so this is five
 * consecutive missed ticks. It is deliberately several ticks wide: one slow
 * tick is ordinary (the sink export runs inside it), and a status command
 * that flickered to `degraded` whenever an export ran long would be worse
 * than the bug it is here to catch. It is also the reason the window is not
 * tighter: the daemon's timers do not fire while the machine is asleep, so a
 * host that just woke reads as stale until its next tick lands.
 *
 * @ref LLP 0348#the-window [implements]: several missed ticks, not one
 */
export const DAEMON_HEARTBEAT_STALE_MS = 5 * 60_000

/**
 * How long ago the daemon last wrote its status snapshot, derived from the
 * two fields the snapshot already carries: `persist()` recomputes `uptimeMs`
 * as `now - healthyAt` immediately before every write, so `healthyAt +
 * uptimeMs` *is* the moment of that write. Nothing new has to be recorded
 * for the heartbeat to be readable.
 *
 * Returns `null` when the snapshot dates no write (a daemon that has not
 * reached the first `persist()` of its run has not started serving, so it has
 * no tick to be late for: the `starting` snapshot goes down before
 * `bootKernel`, and the pair reaches disk on the first post-boot write, not on
 * the assignment) or when either field is missing or unusable, which is also
 * how a status file written by an older build reads. Reaching `healthy` is
 * not the condition: a daemon whose boot aggregate landed `degraded` is
 * serving, and dates its writes like any other (LLP 0386#serving-dates-the-write).
 *
 * @param {DaemonStatus | null | undefined} status
 * @param {number} nowMs
 * @returns {number | null}
 * @ref LLP 0348#heartbeat-is-derived [implements]: healthyAt + uptimeMs is the last persist, so no new status field is minted
 */
export function daemonHeartbeatAgeMs(status, nowMs) {
  const healthyAtMs = parseIsoMs(status?.healthyAt)
  if (healthyAtMs === undefined) return null
  const uptimeMs = status?.uptimeMs
  if (typeof uptimeMs !== 'number' || !Number.isFinite(uptimeMs) || uptimeMs < 0) return null
  return nowMs - (healthyAtMs + uptimeMs)
}

/**
 * When this machine last booted, as epoch ms, or `undefined` when the
 * platform will not say. `os.uptime()` is the platform's own boot clock:
 * libuv reads `kern.boottime` on macOS and `/proc/uptime` (the clock
 * `/proc/stat`'s `btime` is derived from) on Linux, both counting sleep, so
 * a laptop that slept since boot still dates its boot correctly. Never
 * throws: a sandbox without `/proc` answers `undefined`, which the caller
 * reads as "cannot tell", never as "no reboot".
 *
 * @param {number} [nowMs]
 * @returns {number | undefined}
 */
export function systemBootTimeMs(nowMs = Date.now()) {
  try {
    const uptimeSeconds = os.uptime()
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds <= 0) return undefined
    return nowMs - uptimeSeconds * 1000
  } catch {
    return undefined
  }
}

/**
 * Whether a daemon's recorded stop happened during this boot, before it, or
 * cannot be placed (no `stoppedAt`, or no boot time). Only `'this_boot'` can
 * stand for a stop the operator asked for: every clean shutdown writes
 * `stopped`, a reboot's included, so a stop from before this boot says
 * nothing about why launchd holds nothing now.
 *
 * @param {string | undefined} stoppedAt
 * @param {() => number | undefined} bootTimeMs
 * @returns {'this_boot' | 'before_boot' | 'unknown'}
 */
export function placeStopAgainstBoot(stoppedAt, bootTimeMs) {
  const stoppedAtMs = parseIsoMs(stoppedAt)
  if (stoppedAtMs === undefined) return 'unknown'
  let bootMs
  try {
    bootMs = bootTimeMs()
  } catch {
    return 'unknown'
  }
  if (typeof bootMs !== 'number' || !Number.isFinite(bootMs)) return 'unknown'
  return stoppedAtMs > bootMs ? 'this_boot' : 'before_boot'
}

/* ---------- Phase 8: top-level status collector ---------- */
