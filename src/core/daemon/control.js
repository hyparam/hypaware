// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { daemonRunDir } from './pid.js'

/**
 * Signal-free control channel for the running daemon: request files under
 * `<stateRoot>/run/control/`. A writer asks for an orderly stop or a
 * same-shape reload by dropping a marker file; the daemon consumes the file
 * and dispatches into the same `shutdown()` / `reload()` its signal handlers
 * call. This is the only stop transport on win32, where a cross-process
 * SIGTERM is `TerminateProcess` (no orderly shutdown), and a second door on
 * POSIX, where signals remain primary.
 *
 * The state directory is user-owned, so writing here already requires the
 * authority that owning the daemon requires - the trust property LLP 0166
 * notes a localhost port lacks.
 *
 * @ref LLP 0300#file-channel [implements]: stop/reload ride marker files in the daemon-owned state dir, not signals or a port
 */

/** @param {string} stateRoot */
export function controlDirPath(stateRoot) {
  return path.join(daemonRunDir(stateRoot), 'control')
}

/** The two control verbs, as the marker filenames the channel understands. */
const REQUEST_FILES = /** @type {const} */ ({
  stop: 'stop.request',
  reload: 'reload.request',
})

/** @param {string} stateRoot @param {'stop'|'reload'} kind */
export function controlRequestPath(stateRoot, kind) {
  return path.join(controlDirPath(stateRoot), REQUEST_FILES[kind])
}

/**
 * Ask the daemon watching `stateRoot` to stop or reload. The file content is
 * for a human debugging a stuck request; the watcher keys on the filename
 * alone. Creating the directory is part of the write: the requester may run
 * before the daemon ever has.
 *
 * @param {string} stateRoot
 * @param {'stop'|'reload'} kind
 */
export function writeControlRequest(stateRoot, kind) {
  const file = controlRequestPath(stateRoot, kind)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ requestedAt: new Date().toISOString(), pid: process.pid }))
}

/**
 * Delete any request files left on disk. The daemon calls this at boot,
 * before writing its PID file: a request is an instruction to the *running*
 * daemon, and one that survived a crash or a hard kill must not stop the
 * next boot on sight.
 *
 * @param {string} stateRoot
 * @ref LLP 0300#boot-clears-stale [implements]: boot consumes leftovers before the PID write, so anything seen later is a live request
 */
export function clearControlRequests(stateRoot) {
  for (const name of Object.values(REQUEST_FILES)) {
    try {
      fs.unlinkSync(path.join(controlDirPath(stateRoot), name))
    } catch (err) {
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue
      throw err
    }
  }
}

/**
 * Watch the control directory and dispatch consumed requests. Uses
 * `fs.watch` (non-persistent, so the watcher never holds the process open)
 * and degrades to a polling interval where watch is unavailable. Scans once
 * immediately after installing, so a request written between the caller's
 * boot-time clear and this install is not lost.
 *
 * Consumption order: a request file is deleted *before* its handler runs, so
 * a handler that stops the watcher (stop does) can never re-observe the
 * request. When both requests are present, stop wins and both are consumed:
 * reloading a daemon that has been asked to stop is work thrown away.
 *
 * @param {string} stateRoot
 * @param {{
 *   onStop: () => void,
 *   onReload: () => void,
 *   log?: { warn(event: string, fields?: Record<string, unknown>): void },
 *   pollIntervalMs?: number,
 * }} handlers
 * @returns {{ close(): void }}
 * @ref LLP 0300#stop-wins [implements]: both present consumes both, dispatches stop only
 */
export function watchControlRequests(stateRoot, handlers) {
  const dir = controlDirPath(stateRoot)
  fs.mkdirSync(dir, { recursive: true })
  let closed = false
  let scanning = false
  let rescan = false

  /** @param {'stop'|'reload'} kind */
  function consume(kind) {
    try {
      fs.unlinkSync(path.join(dir, REQUEST_FILES[kind]))
      return true
    } catch (err) {
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false
      throw err
    }
  }

  function scan() {
    if (closed) return
    if (scanning) {
      rescan = true
      return
    }
    scanning = true
    try {
      do {
        rescan = false
        const stop = consume('stop')
        const reload = consume('reload')
        if (stop) {
          handlers.onStop()
        } else if (reload) {
          handlers.onReload()
        }
      } while (rescan && !closed)
    } catch (err) {
      handlers.log?.warn('daemon.control_scan_failed', {
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      scanning = false
    }
  }

  /** @type {fs.FSWatcher | null} */
  let watcher = null
  /** @type {NodeJS.Timeout | null} */
  let poller = null
  try {
    watcher = fs.watch(dir, { persistent: false }, () => scan())
    watcher.on('error', (err) => {
      handlers.log?.warn('daemon.control_watch_failed', {
        message: err instanceof Error ? err.message : String(err),
      })
    })
  } catch (err) {
    handlers.log?.warn('daemon.control_watch_unavailable', {
      message: err instanceof Error ? err.message : String(err),
    })
    poller = setInterval(() => scan(), handlers.pollIntervalMs ?? 1000)
    if (typeof poller.unref === 'function') poller.unref()
  }

  scan()

  return {
    close() {
      closed = true
      if (watcher) {
        watcher.close()
        watcher = null
      }
      if (poller) {
        clearInterval(poller)
        poller = null
      }
    },
  }
}
