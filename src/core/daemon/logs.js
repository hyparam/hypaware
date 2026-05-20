// @ts-check

import fs from 'node:fs'
import path from 'node:path'

/**
 * Resolve the directory the daemon writes its dispatch / lifecycle
 * log to — `<HYP_HOME>/hypaware/logs`. OTel logs continue to land in
 * `dev-telemetry/` (when `HYP_DEV_TELEMETRY=1`) or be exported over
 * OTLP; this file is the line-oriented sidecar a human inspects with
 * `tail -f` after `daemon run`.
 *
 * @param {string} stateRoot
 */
export function daemonLogDir(stateRoot) {
  return path.join(stateRoot, 'logs')
}

/**
 * @typedef {Object} DaemonLogger
 * @property {string} path             Absolute path to the open log file.
 * @property {(event: string, fields?: Record<string, unknown>) => void} info
 * @property {(event: string, fields?: Record<string, unknown>) => void} warn
 * @property {(event: string, fields?: Record<string, unknown>) => void} error
 * @property {() => void} close
 */

/**
 * Open the daemon log file for append. One line per event in JSON
 * form so an operator can `cat | jq`. The file name is fixed per
 * `HYP_HOME` so the running daemon always writes to `daemon.log`;
 * the `runId` lands inside the records and not in the filename so
 * `tail -F daemon.log` survives restarts.
 *
 * @param {{ stateRoot: string, runId: string, mode: string }} args
 * @returns {DaemonLogger}
 */
export function openDaemonLog({ stateRoot, runId, mode }) {
  const dir = daemonLogDir(stateRoot)
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'daemon.log')
  const stream = fs.createWriteStream(logPath, { flags: 'a' })

  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} event
   * @param {Record<string, unknown>} [fields]
   */
  function emit(level, event, fields) {
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
      dev_run_id: runId,
      mode,
      ...(fields ?? {}),
    }
    try {
      stream.write(JSON.stringify(record) + '\n')
    } catch {
      // best-effort — daemon must not crash because the log device is
      // full or detached.
    }
  }

  return {
    path: logPath,
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    close() {
      try { stream.end() } catch { /* see emit() */ }
    },
  }
}
