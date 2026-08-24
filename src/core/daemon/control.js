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

/**
 * @import { UnclearedRequest } from '../../../src/core/daemon/types.js'
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
 * The chmod is best-effort, but not silent: a directory this user cannot
 * chmod leaves LLP 0300's trust argument unenforced, so a caller with a
 * logger hears about it.
 *
 * @param {string} dir
 * @param {{ warn(event: string, fields?: Record<string, unknown>): void } | undefined} [log]
 */
function ensureControlDir(dir, log) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch (err) {
    log?.warn('daemon.control_dir_mode_failed', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Ask the daemon watching `stateRoot` to stop or reload. The file content is
 * for a human debugging a stuck request, and it is what distinguishes a
 * fresh request from a stale leftover the boot clear could not remove; the
 * watcher keys on the filename alone. Creating the directory is part of the
 * write: the requester may run before the daemon ever has.
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
 * Best-effort per file, and never throws: one file's failure does not skip
 * the sibling, and a cleanup failure must not block a boot. The return value
 * names each request the clear could NOT remove, with the file's content
 * when readable. The boot hands it to `watchControlRequests` as
 * `staleRequests`, so a leftover whose unlink failure was transient (win32
 * EPERM/EBUSY while a dying writer still held the handle) is consumed
 * without dispatch when the watcher meets it later, instead of stopping the
 * fresh daemon.
 *
 * @param {string} stateRoot
 * @returns {Partial<Record<'stop'|'reload', UnclearedRequest>>}
 * @ref LLP 0300#boot-clears-stale [implements]: boot clears leftovers before the PID write and hands the watcher what it could not clear, so nothing stale ever dispatches
 */
export function clearControlRequests(stateRoot) {
  /** @type {Partial<Record<'stop'|'reload', UnclearedRequest>>} */
  const uncleared = {}
  for (const kind of /** @type {Array<'stop'|'reload'>} */ (Object.keys(REQUEST_FILES))) {
    const file = path.join(controlDirPath(stateRoot), REQUEST_FILES[kind])
    try {
      fs.unlinkSync(file)
    } catch (err) {
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue
      /** @type {string | null} */
      let content = null
      try {
        content = fs.readFileSync(file, 'utf8')
      } catch {
        // Unreadable as well as unremovable: recorded as null, which the
        // watcher matches conservatively (never dispatches).
      }
      uncleared[kind] = {
        content,
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }
  return uncleared
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
 * request - and nothing is ever deleted that will not be dispatched (or is
 * known stale). When both requests are present, stop wins and both are
 * consumed: reloading a daemon that has been asked to stop is work thrown
 * away.
 *
 * @param {string} stateRoot
 * @param {{
 *   onStop: () => void,
 *   onReload: () => void,
 *   log?: { warn(event: string, fields?: Record<string, unknown>): void },
 *   pollIntervalMs?: number,
 *   staleRequests?: Partial<Record<'stop'|'reload', UnclearedRequest>>,
 * }} handlers
 * @returns {{ close(): void }}
 * @ref LLP 0300#stop-wins [implements]: both present consumes both, dispatches stop only
 */
export function watchControlRequests(stateRoot, handlers) {
  const dir = controlDirPath(stateRoot)
  ensureControlDir(dir, handlers.log)
  let closed = false
  let scanning = false
  let rescan = false

  // Requests the boot-time clear could not remove (see clearControlRequests).
  // A consume that meets one of these deletes the file but does not
  // dispatch: it is an instruction to a daemon that no longer exists. A
  // fresh request overwrites the file with a new requestedAt/pid, so it no
  // longer matches the recorded content and dispatches normally.
  const stale = { ...(handlers.staleRequests ?? {}) }

  // Warn on transition, not on every pass: an unconsumable file under the
  // win32 1s poll would otherwise append ~86k identical lines a day to a
  // daemon log that never rotates.
  const failing = { stop: false, reload: false }

  /**
   * Delete one request file. `'consumed'` earns a dispatch, `'stale'` is a
   * consumed boot leftover that must not dispatch, `'absent'` is the steady
   * state, and `'failed'` (win32 EPERM/EBUSY while the writer still holds
   * the handle) leaves the file for the poller's next pass. Each consume
   * swallows its own error so one file's failure can never discard the
   * sibling's dispatch: a file that was already unlinked has nothing left
   * for a retry to find.
   *
   * @param {'stop'|'reload'} kind
   * @returns {'consumed'|'stale'|'absent'|'failed'}
   */
  function consume(kind) {
    const file = path.join(dir, REQUEST_FILES[kind])
    const staleEntry = stale[kind]
    /** @type {string | null} */
    let content = null
    if (staleEntry !== undefined) {
      try {
        content = fs.readFileSync(file, 'utf8')
      } catch (err) {
        if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return 'absent'
        // Present but unreadable: the unlink below decides, and the null
        // content matches the stale entry conservatively.
      }
    }
    try {
      fs.unlinkSync(file)
    } catch (err) {
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return 'absent'
      if (!failing[kind]) {
        failing[kind] = true
        handlers.log?.warn('daemon.control_scan_failed', {
          request: REQUEST_FILES[kind],
          message: err instanceof Error ? err.message : String(err),
        })
      }
      return 'failed'
    }
    if (failing[kind]) {
      failing[kind] = false
      handlers.log?.warn('daemon.control_scan_recovered', { request: REQUEST_FILES[kind] })
    }
    if (staleEntry !== undefined) {
      delete stale[kind]
      // Match on content when both sides are readable; when either side is
      // unknown, err on "stale": the cost of dropping one ambiguous request
      // (the CLI retries) is smaller than stopping a fresh boot on a
      // leftover, which is the invariant boot-clears-stale exists for.
      if (staleEntry.content === null || content === null || content === staleEntry.content) {
        return 'stale'
      }
    }
    return 'consumed'
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
        if (stop === 'failed') {
          // Nothing else is consumed while the stop is stuck: stop wins, so
          // this pass would never dispatch a reload, and unlinking one here
          // would destroy a request that was never acted on ("deleted"
          // must imply "dispatched or stale"). The poller retries the stop
          // on its next pass.
          break
        }
        if (stop === 'consumed') {
          // Stop wins: a pending reload is consumed too, never dispatched;
          // reloading a daemon that has been asked to stop is work thrown
          // away.
          consume('reload')
          handlers.onStop()
        } else if (consume('reload') === 'consumed') {
          handlers.onReload()
        }
      } while (rescan && !closed)
    } catch (err) {
      // consume() swallows its own errors, so only a throwing handler lands
      // here. A warn keeps a handler bug a named, visible failure instead of
      // an uncaught exception escaping a timer and killing the process.
      handlers.log?.warn('daemon.control_dispatch_failed', {
        message: err instanceof Error ? err.message : String(err),
      })
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
