// @ts-check

import process from 'node:process'
import readline from 'node:readline'

import { reduce } from './keypress.js'
import { render } from './render.js'

/** @typedef {import('./keypress.js').State} State */
/** @typedef {import('./keypress.js').Key} Key */

const CURSOR_HIDE  = '\x1b[?25l'
const CURSOR_SHOW  = '\x1b[?25h'
const CLEAR_TO_END = '\x1b[J'

let activeRun = false

/**
 * @typedef {Object} RunOpts
 * @property {NodeJS.ReadableStream} stdin
 * @property {NodeJS.WritableStream} stdout
 * @property {NodeJS.ProcessEnv} [env]
 * @property {boolean} [clearOnResolve]  Erase the prompt's frame from the
 *   terminal when it settles (resolve or cancel) so the next prompt
 *   redraws in its place instead of stacking below it.
 */

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
  /** @type {NodeJS.ReadStream} */
  const stdin = /** @type {any} */ (io.stdin)
  const stdout = io.stdout

  /** @type {State} */
  let state = initialState
  let previousLineCount = 0
  /** @type {((s: any, k: any) => void) | null} */
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
    if (clearOnResolve && previousLineCount > 0) {
      // Move the cursor back to the top of the rendered frame and clear
      // everything below it, leaving the screen as it was before the
      // prompt drew. The next prompt then redraws in the same position.
      try { stdout.write(`\x1b[${previousLineCount}A\r${CLEAR_TO_END}`) } catch {}
      previousLineCount = 0
    }
    try { stdout.write(CURSOR_SHOW) } catch {}
  }

  function writeFrame() {
    let buf = ''
    if (previousLineCount > 0) {
      buf += `\x1b[${previousLineCount}A\r${CLEAR_TO_END}`
    }
    const frame = render(state, { color })
    buf += frame
    previousLineCount = countPhysicalRows(frame, terminalColumns(stdout))
    stdout.write(buf)
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
  const inTty  = stdin  && /** @type {any} */ (stdin).isTTY  === true
  const outTty = stdout && /** @type {any} */ (stdout).isTTY === true
  if (!inTty || !outTty) {
    throw new Error('TUI prompt requires a TTY; got non-TTY stdin/stdout')
  }
}

/**
 * @param {unknown} str
 * @param {unknown} key
 * @returns {Key}
 */
function normalizeKey(str, key) {
  const k = /** @type {any} */ (key) ?? {}
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
 * @param {NodeJS.WritableStream} stdout
 * @returns {number}
 */
function terminalColumns(stdout) {
  const cols = /** @type {any} */ (stdout).columns
  return typeof cols === 'number' && cols > 0 ? cols : 80
}

// Match ANSI SGR (color/style) sequences so they are excluded from the
// visible-width measurement. The renderer only emits `\x1b[...m` codes.
const ANSI_SGR = /\x1b\[[0-9;]*m/g

/**
 * Visible (printable) width of a single logical line, ignoring ANSI
 * style codes. Measured in code units, which matches column count for
 * the Latin/punctuation text the prompts render.
 *
 * @param {string} line
 * @returns {number}
 */
function visibleWidth(line) {
  return line.replace(ANSI_SGR, '').length
}

/**
 * Count the number of *physical* terminal rows a frame occupies. The
 * runtime uses this to know how far to move the cursor up before
 * clearing the previous frame. A naive newline count is wrong whenever
 * a logical line is wider than the terminal: the terminal soft-wraps it
 * onto multiple rows, so the cursor descended further than the number of
 * `\n` written. Undercounting here leaves stale rows on screen on every
 * redraw — the classic "the question keeps duplicating when I move the
 * cursor" symptom.
 *
 * Frames always end with a trailing `\n`; the empty segment after it
 * contributes no row.
 *
 * @param {string} frame
 * @param {number} columns
 * @returns {number}
 */
export function countPhysicalRows(frame, columns) {
  const width = columns > 0 ? columns : 80
  const lines = frame.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let rows = 0
  for (const line of lines) {
    const len = visibleWidth(line)
    rows += len === 0 ? 1 : Math.ceil(len / width)
  }
  return rows
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
