// @ts-check

import process from 'node:process'
import readline from 'node:readline'

import { reduce } from './keypress.js'
import { createLiveRegion } from './live_region.js'
import { render } from './render.js'

/**
 * @import { State, Key, RunOpts } from '../../../../src/core/cli/tui/types.js'
 * @import { Key as ReadlineKey } from 'node:readline'
 */

const CURSOR_HIDE  = '\x1b[?25l'
const CURSOR_SHOW  = '\x1b[?25h'

let activeRun = false

/**
 * Drive the reducer loop against a TTY. Resolves with the terminal
 * state when the reducer reports `resolved`. Throws a
 * {@link PromptCancelledError} when the reducer reports `cancelled`.
 *
 * @param {State} initialState
 * @param {RunOpts} io
 * @returns {Promise<State>}
 */
export async function run(initialState, io) {
  const env = io.env ?? process.env
  ensureTty(io.stdin, io.stdout, env)
  if (activeRun) {
    throw new Error('TUI prompt already active')
  }
  activeRun = true

  const color = env.NO_COLOR ? false : true
  const clearOnResolve = io.clearOnResolve === true
  const stdin = /** @type {NodeJS.ReadStream} */ (io.stdin)
  const stdout = /** @type {NodeJS.WriteStream} */ (io.stdout)

  /** @type {State} */
  let state = initialState
  const region = createLiveRegion(stdout)
  /** @type {((s: string | undefined, k: ReadlineKey) => void) | null} */
  let onKeypress = null
  let cleanedUp = false

  // Snapshot raw mode so we can restore it on exit.
  const previousRawMode = typeof stdin.isRaw === 'boolean' ? stdin.isRaw : false
  const previousReadableFlowing = typeof stdin.readableFlowing === 'boolean' ? stdin.readableFlowing : null
  const previousPaused = typeof stdin.isPaused === 'function' ? stdin.isPaused() : previousReadableFlowing === false
  const shouldPauseOnCleanup = previousPaused || previousReadableFlowing !== true

  /** @returns {void} */
  function cleanup() {
    if (cleanedUp) return
    cleanedUp = true
    if (onKeypress) {
      stdin.removeListener('keypress', onKeypress)
      onKeypress = null
    }
    try {
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(previousRawMode)
      }
    } catch {}
    try {
      if (shouldPauseOnCleanup && typeof stdin.pause === 'function') {
        stdin.pause()
      }
    } catch {}
    if (clearOnResolve) {
      // Leave the screen as it was before the prompt drew. The next
      // prompt then redraws in the same position.
      try { region.clear() } catch {}
    }
    try { stdout.write(CURSOR_SHOW) } catch {}
  }

  function writeFrame() {
    // Width is read per frame, not once: a resize between keystrokes must
    // reach both the renderer (which drops a box that no longer fits) and
    // the row count below it, or the two disagree about the same frame.
    const columns = terminalColumns(stdout)
    const rows = terminalRows(stdout)
    region.draw(render(state, { color, columns, ...(rows !== undefined ? { rows } : {}) }), columns)
  }

  try {
    readline.emitKeypressEvents(stdin)
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true)
    }
    stdout.write(CURSOR_HIDE)
    writeFrame()

    return await new Promise((resolve, reject) => {
      onKeypress = (str, key) => {
        try {
          const k = normalizeKey(str, key)
          state = reduce(state, k)
          writeFrame()
          if (state.status === 'resolved') {
            cleanup()
            resolve(state)
          } else if (state.status === 'cancelled') {
            cleanup()
            reject(new PromptCancelledError())
          } else if (state.status === 'backed') {
            cleanup()
            reject(new PromptBackRequestedError())
          }
        } catch (err) {
          cleanup()
          reject(err)
        }
      }
      stdin.on('keypress', onKeypress)
      if (typeof stdin.resume === 'function') stdin.resume()
    }).finally(() => cleanup())
  } finally {
    activeRun = false
    cleanup()
  }
}

/**
 * @param {NodeJS.ReadableStream | undefined} stdin
 * @param {NodeJS.WritableStream | undefined} stdout
 * @param {NodeJS.ProcessEnv} env
 */
function ensureTty(stdin, stdout, env) {
  if (env.HYP_NO_TUI === '1') {
    throw new Error('TUI prompt requires a TTY; got non-TTY stdin/stdout')
  }
  const inTty  = stdin  && /** @type {NodeJS.ReadStream} */ (stdin).isTTY  === true
  const outTty = stdout && /** @type {NodeJS.WriteStream} */ (stdout).isTTY === true
  if (!inTty || !outTty) {
    throw new Error('TUI prompt requires a TTY; got non-TTY stdin/stdout')
  }
}

/**
 * @param {string | undefined} str
 * @param {ReadlineKey | undefined} key
 * @returns {Key}
 */
function normalizeKey(str, key) {
  /** @type {ReadlineKey} */
  const k = key ?? {}
  /** @type {Key} */
  const out = {
    ctrl:  !!k.ctrl,
    shift: !!k.shift,
    meta:  !!k.meta,
  }
  if (typeof k.name === 'string') out.name = k.name
  if (typeof str === 'string') out.sequence = str
  else if (typeof k.sequence === 'string') out.sequence = k.sequence
  return out
}

/**
 * Resolve the terminal width in columns, defaulting to 80 when the
 * stream does not expose a usable `.columns` (non-TTY mocks, pipes).
 *
 * @param {NodeJS.WriteStream} stdout
 * @returns {number}
 */
function terminalColumns(stdout) {
  const cols = stdout.columns
  return typeof cols === 'number' && cols > 0 ? cols : 80
}

/**
 * Resolve the terminal height in rows, or `undefined` when the stream does
 * not expose a usable `.rows` (a pipe, a test double). Unlike width there
 * is no safe default to invent: the renderer treats an unknown height as
 * "no limit" and draws every row, which is what it did before it could ask.
 *
 * @param {NodeJS.WriteStream} stdout
 * @returns {number | undefined}
 */
function terminalRows(stdout) {
  const rows = stdout.rows
  return typeof rows === 'number' && rows > 0 ? rows : undefined
}

/**
 * Thrown when the user cancels a TUI prompt (escape, ctrl+c).
 * Callers should treat this as a non-fatal cancel signal.
 */
export class PromptCancelledError extends Error {
  constructor(message = 'TUI prompt cancelled') {
    super(message)
    this.name = 'PromptCancelledError'
  }
}

/**
 * Identify prompt cancellation across direct runtime errors and wrapped
 * copies that preserve the established error name.
 *
 * @param {unknown} err
 * @returns {err is PromptCancelledError}
 */
export function isPromptCancelledError(err) {
  return err instanceof PromptCancelledError || (
    err instanceof Error && err.name === 'PromptCancelledError'
  )
}

/**
 * Thrown when the user steps back from a prompt that opted into
 * back-navigation (`allowBack`, LLP 0191): escape on the TUI path, `b`
 * on the readline fallbacks. A control-flow signal like
 * {@link PromptCancelledError}, not a failure: callers re-run the
 * previous screen.
 */
export class PromptBackRequestedError extends Error {
  constructor(message = 'TUI prompt backed out') {
    super(message)
    this.name = 'PromptBackRequestedError'
  }
}

/**
 * Identify a back request across direct runtime errors and wrapped
 * copies that preserve the established error name.
 *
 * @param {unknown} err
 * @returns {err is PromptBackRequestedError}
 */
export function isPromptBackError(err) {
  return err instanceof PromptBackRequestedError || (
    err instanceof Error && err.name === 'PromptBackRequestedError'
  )
}
