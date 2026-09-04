// @ts-check

import process from 'node:process'

import { isTty } from './stdio.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Run `work` behind a one-line elapsed-time spinner.
 *
 * Exists for the wizard's two long silent waits (the org-config converge
 * after login and the backfill import), where the last thing on screen was
 * a static line and a multi-second pause read as a hang. On a TTY the
 * label animates in place with elapsed seconds and is cleared when the
 * work settles, so whatever the caller prints next (a result line, the
 * next prompt) lands on a clean line. Off a TTY - and under `HYP_NO_TUI=1`,
 * same as every other TUI surface - the label is written once as a plain
 * line, never an animation, which is what keeps the scripted transcripts
 * stable. For a caller whose label restates a line it already printed (the
 * wizard's waits) that output is byte-identical to the pre-spinner run; a
 * caller that printed nothing there (`hyp sync`) gains this one line.
 *
 * `quietWhenPlain` writes nothing at all on that plain path. It is for a
 * wait sitting in front of the caller's own first output, where the label
 * would be all a script ever saw of a delay only a person can perceive, and
 * where the elapsed time already reaches the structured log.
 *
 * The timer never outlives the work: errors clear the line and rethrow.
 *
 * @template T
 * @param {{
 *   stdout: { write(chunk: string): unknown, columns?: number },
 *   label: string,
 *   env?: NodeJS.ProcessEnv,
 *   intervalMs?: number,
 *   quietWhenPlain?: boolean,
 * }} opts
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withSpinner(opts, work) {
  const { stdout, label, env, intervalMs = 120, quietWhenPlain = false } = opts
  const animate = isTty(stdout) && (env ?? process.env).HYP_NO_TUI !== '1'
  if (!animate) {
    if (!quietWhenPlain) stdout.write(`${label}\n`)
    return work()
  }

  const started = Date.now()
  let frame = 0
  const render = () => {
    const elapsed = Math.floor((Date.now() - started) / 1000)
    const suffix = elapsed >= 1 ? ` (${elapsed}s)` : ''
    const head = `${FRAMES[frame % FRAMES.length]} `
    stdout.write(`\r\x1b[2K${clampToWidth(head, label, suffix, stdout)}`)
    frame += 1
  }
  render()
  const timer = setInterval(render, intervalMs)
  try {
    return await work()
  } finally {
    clearInterval(timer)
    stdout.write('\r\x1b[2K')
  }
}

/**
 * Keep one frame to one terminal row.
 *
 * `\x1b[2K` erases the row the cursor sits on and nothing above it, so a
 * frame wider than the terminal is unrecoverable: it wraps, the cursor ends
 * on the row below, the next frame clears only that row and wraps again, and
 * the spinner walks down the screen leaving a trail of half-erased labels
 * behind it. The wizard's labels are short enough to make that hard to
 * reach; `hyp sync` names a client and a destination in one label, which
 * wraps on any narrow pane.
 *
 * The label is what gives way, never the tail. The animating frame and the
 * elapsed seconds are the whole signal this helper exists to show, and
 * clamping the composed line from the right would drop `(12s)` first, on
 * every pane narrower than the label (about 53 columns for `hyp sync`, 66
 * for a history replay). Slicing is by code point, so a cut never lands
 * inside a surrogate pair.
 *
 * Labels are plain text by contract: an escape sequence inside one would be
 * counted here as display columns and could be cut in half, leaving the
 * terminal mid-sequence. No caller passes one.
 *
 * A stream with no `columns` (a capture in a test, a pipe) is left alone:
 * there is no width to clamp to, and nothing wraps there anyway.
 *
 * @param {string} head
 * @param {string} label
 * @param {string} suffix
 * @param {{ columns?: number }} stdout
 * @returns {string}
 */
function clampToWidth(head, label, suffix, stdout) {
  const columns = stdout.columns
  const line = `${head}${label}${suffix}`
  if (typeof columns !== 'number') return line
  // One column short of the edge: writing the last cell leaves the cursor in
  // a state terminals disagree about (some wrap eagerly, some defer). A
  // terminal that reports 0 or 1 column still gets clamped, not wrapped.
  const width = Math.max(1, columns - 1)
  const chars = [...line]
  if (chars.length <= width) return line
  const room = width - [...head].length - [...suffix].length
  if (room < 1) return chars.slice(0, width).join('')
  return `${head}${[...label].slice(0, room - 1).join('')}…${suffix}`
}
