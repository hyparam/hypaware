import os from 'node:os'
import path from 'node:path'

/**
 * Daemon runtime directory. Holds files the running daemon writes for the
 * `ctvs` CLI to read out-of-band: PID, gascity state snapshots, etc. We
 * keep these under `~/.collectivus/runtime/` rather than mixing them with
 * `~/.hyp/collectivus/` (logs, default config) so log rotation tools that
 * sweep `~/.hyp/collectivus/` can't accidentally remove the PID file or
 * source state.
 *
 * @returns {string}
 */
export function defaultRuntimeDir() {
  return path.join(os.homedir(), '.collectivus', 'runtime')
}

/**
 * Default location for the daemon PID file. Written on listener boot and
 * removed on graceful shutdown so the CLI can detect a live daemon and
 * direct signals to it (SIGHUP for reload).
 *
 * @param {string} [runtimeDir]
 * @returns {string}
 */
export function defaultPidFilePath(runtimeDir) {
  return path.join(runtimeDir ?? defaultRuntimeDir(), 'collectivus.pid')
}

/**
 * Default location for the gascity-source runtime state snapshot. The
 * source rewrites it on every notable change (city boot, session
 * spawn/retire, periodic frame-count tick) so `ctvs gascity list/status`
 * can render an up-to-date view without a control-channel round trip.
 *
 * @param {string} [runtimeDir]
 * @returns {string}
 */
export function defaultGascityStatePath(runtimeDir) {
  return path.join(runtimeDir ?? defaultRuntimeDir(), 'gascity-state.json')
}
