// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { daemonRunDir } from './pid.js'

/**
 * Daemon health states the smoke and `hyp daemon status` rely on.
 *
 * - `starting`: the daemon has written its PID file but has not yet
 *   reported every configured source as up.
 * - `healthy`: every configured source returned a `StartedSource`.
 * - `degraded`: at least one source failed to start or failed status.
 * - `stopping`: SIGTERM/SIGINT received, sources are being shut down.
 * - `stopped`: shutdown completed; status file remains so a parallel
 *   `daemon status` can read the last terminal state.
 *
 * @typedef {'starting'|'healthy'|'degraded'|'stopping'|'stopped'} DaemonState
 */

/**
 * @typedef {Object} SourceSnapshot
 * @property {string} name
 * @property {string} plugin
 * @property {'started'|'failed'|'stopped'} state
 * @property {string} [error]
 * @property {object} [details]
 */

/**
 * @typedef {Object} SinkSnapshot
 * @property {string} instance
 * @property {string} plugin
 * @property {string} kind
 * @property {string} [lastTickAt]
 * @property {string} [lastSuccessAt]
 * @property {number} [failedOutboxCount]
 * @property {string} [nextScheduledAt]
 */

/**
 * @typedef {Object} DaemonStatus
 * @property {DaemonState} state
 * @property {number} pid
 * @property {string} startedAt              ISO timestamp of the daemon process boot.
 * @property {string} [healthyAt]            ISO timestamp the daemon first reached `healthy`.
 * @property {string} [stoppedAt]            ISO timestamp the daemon transitioned to `stopped`.
 * @property {number} uptimeMs               Milliseconds since `healthyAt` (0 when not yet healthy).
 * @property {string} runId                  dev_run_id stamped on telemetry from this daemon.
 * @property {string} mode                   `foreground` (Phase 3) or `detached` (Phase 4 installers).
 * @property {string} [configPath]           Active config file, when one was resolved.
 * @property {SourceSnapshot[]} sources
 * @property {SinkSnapshot[]} sinks
 * @property {string[]} [warnings]
 */

/**
 * Path to the daemon status file. Written by the daemon at each
 * lifecycle transition so a parallel `hyp daemon status --json` call
 * sees a consistent snapshot without having to walk the kernel.
 *
 * @param {string} stateRoot
 */
export function statusFilePath(stateRoot) {
  return path.join(daemonRunDir(stateRoot), 'status.json')
}

/**
 * Write a status file atomically (write to `.tmp`, then rename). The
 * smoke harness asserts against this file directly so it must always
 * be either absent or fully formed — partial writes would race the
 * SIGTERM assertion.
 *
 * @param {string} stateRoot
 * @param {DaemonStatus} status
 */
export function writeStatusFile(stateRoot, status) {
  const dir = daemonRunDir(stateRoot)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `status.json.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, statusFilePath(stateRoot))
}

/**
 * Read the status file. Returns `null` when no daemon has run for
 * this `HYP_HOME` yet — `hyp daemon status` surfaces that as
 * "daemon: not started" rather than an error.
 *
 * @param {string} stateRoot
 * @returns {DaemonStatus | null}
 */
export function readStatusFile(stateRoot) {
  /** @type {string} */
  let raw
  try {
    raw = fs.readFileSync(statusFilePath(stateRoot), 'utf8')
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
    throw err
  }
  /** @type {unknown} */
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`readStatusFile: malformed entry at ${statusFilePath(stateRoot)}`)
  }
  return /** @type {DaemonStatus} */ (parsed)
}
