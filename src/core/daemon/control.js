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
 * Create the control directory owner-only. `mkdirSync`'s `mode` applies only
 * to directories it creates, so a directory that already exists at a looser
 * mode (an older build created it under the umask) is tightened explicitly.
 * The chmod is best-effort: a directory this user cannot chmod is one the
 * channel cannot use anyway, and the failure surfaces at the write.
 *
 * @param {string} dir
 */
function ensureControlDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // best-effort, see above
  }
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
  // 0700, not the umask: the trust argument above is "writing here requires
  // owning the state dir", so the directory must not pick up group write
  // from a permissive umask (same shape as the config-control dir).
  ensureControlDir(path.dirname(file))
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
 * for low latency, with a polling interval always running underneath it as
 * the delivery guarantee (both timers unref'd). Scans once on a microtask
 * right after installing, so a request written between the caller's
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
  ensureControlDir(dir)
  let closed = false
  let scanning = false
  let rescan = false

  /**
   * Delete one request file. `'consumed'` earns a dispatch, `'absent'` is
   * the steady state, and `'failed'` (win32 EPERM/EBUSY while the writer
   * still holds the handle) leaves the file for the poller's next pass.
   * Each consume swallows its own error so one file's failure can never
   * discard the sibling's dispatch: a stop that was already unlinked has no
   * file left for a retry to find.
   *
   * @param {'stop'|'reload'} kind
   * @returns {'consumed'|'absent'|'failed'}
   */
  function consume(kind) {
    try {
      fs.unlinkSync(path.join(dir, REQUEST_FILES[kind]))
      return 'consumed'
    } catch (err) {
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return 'absent'
      handlers.log?.warn('daemon.control_scan_failed', {
        request: REQUEST_FILES[kind],
        message: err instanceof Error ? err.message : String(err),
      })
      return 'failed'
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
        if (stop === 'consumed') {
          handlers.onStop()
        } else if (stop === 'failed') {
          // Stop is still pending on disk, so dispatching a reload consumed
          // above would be work thrown away; the poller retries the stop on
          // its next pass.
        } else if (reload === 'consumed') {
          handlers.onReload()
        }
      } while (rescan && !closed)
    } finally {
      scanning = false
    }
  }

  /** @type {fs.FSWatcher | null} */
  let watcher = null

  // The poller is not a fallback: it always runs, as the delivery guarantee
  // underneath the watcher. A watch event can be dropped or delayed under
  // load, a scan can fail transiently (win32 unlink while the writer still
  // holds the handle), and fs.watch fires no further event for a file that
  // already exists - and a missed stop request leaves a win32 daemon
  // permanently unreachable by `hyp daemon stop`. fs.watch is the
  // low-latency path; the poller is the correctness path. It runs fast only
  // on win32, where the channel is the sole stop transport; elsewhere
  // signals are primary and the backstop can be slow, so an idle daemon is
  // not woken every second for nothing.
  const pollMs = handlers.pollIntervalMs ?? (process.platform === 'win32' ? 1_000 : 10_000)
  const poller = setInterval(() => scan(), pollMs)
  if (typeof poller.unref === 'function') poller.unref()

  try {
    watcher = fs.watch(dir, { persistent: false }, () => scan())
    // A watcher that errors after install (the watched directory replaced,
    // a backend giving up) is dead: close it; the poller keeps the channel
    // live, same as when fs.watch is unavailable outright.
    watcher.on('error', (err) => {
      handlers.log?.warn('daemon.control_watch_failed', {
        message: err instanceof Error ? err.message : String(err),
      })
      watcher?.close()
      watcher = null
    })
  } catch (err) {
    handlers.log?.warn('daemon.control_watch_unavailable', {
      message: err instanceof Error ? err.message : String(err),
    })
  }

  // Deferred, not synchronous: a request already on disk would otherwise
  // dispatch into the caller before this function returns its handle. The
  // daemon stores the handle to close the channel at the top of shutdown, so
  // a synchronous onStop would run shutdown's front half against a watcher
  // it cannot see, leaving the watch and the poller armed for the whole
  // stop. The microtask still runs before any I/O, so nothing is lost.
  queueMicrotask(() => scan())

  return {
    close() {
      closed = true
      if (watcher) {
        watcher.close()
        watcher = null
      }
      clearInterval(poller)
    },
  }
}
