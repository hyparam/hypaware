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
    try { stdout.write(CURSOR_SHOW) } catch {}
  }

  function writeFrame() {
    let buf = ''
    if (previousLineCount > 0) {
      buf += `\x1b[${previousLineCount}A\r${CLEAR_TO_END}`
    }
    const frame = render(state, { color })
    buf += frame
    previousLineCount = countTrailingLines(frame)
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
 * Count the number of newline characters in `s`. The runtime uses this
 * to know how far to move the cursor up before clearing the previous
 * frame. Frames always end with `\n`, so the value equals the number of
 * rows the frame occupied below the start point.
 *
 * @param {string} s
 */
function countTrailingLines(s) {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
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
