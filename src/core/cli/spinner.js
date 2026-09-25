// @ts-check

import process from 'node:process'

import { isTty } from './stdio.js'
import { createLiveRegion } from './tui/live_region.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Run `work` behind a one-line spinner.
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
 * `status` replaces the elapsed seconds with a line the caller recomputes on
 * every frame (`hyp sync`'s acknowledged rows and ETA). It is read only on the
 * animated path, so the caller's `label` is still the whole of what a script
 * or a log file sees, and a `status` that means to be seen there has to be in
 * the label too. Whatever it returns must keep saying that time is passing:
 * this helper exists to stop a pause reading as a hang, and a status that can
 * sit unchanged for a whole export gives that up.
 *
 * `quietWhenPlain` writes nothing at all on that plain path. It is for a
 * wait sitting in front of the caller's own first output, where the label
 * would be all a script ever saw of a delay only a person can perceive, and
 * where the elapsed time already reaches the structured log.
 *
 * `above` is lines that belong to the wait and go when it does, drawn above
 * the spinner (the sign-in URL over its poll). Off a TTY they are printed
 * once, before the label. A function is read on every frame, for lines that
 * arrive during the wait (a device code); off a TTY the caller prints those
 * itself, since they arrive after the label would.
 *
 * On a TTY the spinner is a live region (LLP 0437): each frame rewrites
 * the spinner row, the `above` lines only when they change, and the end of
 * the work erases them all.
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
 *   status?: () => string,
 *   above?: string[] | (() => string[]),
 * }} opts
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withSpinner(opts, work) {
  const { stdout, label, env, intervalMs = 120, quietWhenPlain = false, above = [] } = opts
  const animate = spinnerAnimates(stdout, env)
  if (!animate) {
    if (Array.isArray(above)) for (const line of above) stdout.write(`${line}\n`)
    if (!quietWhenPlain) stdout.write(`${label}\n`)
    return work()
  }

  const region = createLiveRegion(stdout)
  const started = Date.now()
  let frame = 0
  const render = () => {
    const elapsed = Math.floor((Date.now() - started) / 1000)
    const suffix = opts.status ? ` ${opts.status()}` : elapsed >= 1 ? ` (${elapsed}s)` : ''
    const head = `${FRAMES[frame % FRAMES.length]} `
    const columns = typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : 80
    const lines = typeof above === 'function' ? above() : above
    const prefix = lines.map((line) => `${line}\n`).join('')
    region.draw(`${clampToWidth(head, label, suffix, stdout)}\n`, columns, prefix)
    frame += 1
  }
  render()
  const timer = setInterval(render, intervalMs)
  try {
    return await work()
  } finally {
    clearInterval(timer)
    region.clear()
  }
}

/**
 * Whether `withSpinner` will animate on this stream: a TTY, and not vetoed by
 * `HYP_NO_TUI=1`. Exported for a caller whose `above` lines arrive mid-wait
 * and must be printed by hand when nothing is animating.
 *
 * @param {unknown} stdout
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function spinnerAnimates(stdout, env) {
  return isTty(stdout) && (env ?? process.env).HYP_NO_TUI !== '1'
}

/**
 * Keep the spinner line to one terminal row.
 *
 * The live region counts wrapped rows, so a wide line no longer leaves a
 * trail; but a wrapped spinner line jitters between one and two rows as the
 * suffix grows, and on a narrow pane it pushes the suffix onto a second row.
 * The wizard's labels are short enough to make that hard to reach; `hyp
 * sync` names a client and a destination in one label, which wraps on any
 * narrow pane.
 *
 * The label is what gives way first, never the tail. The animating frame and
 * the suffix are the whole signal this helper exists to show, and clamping the
 * composed line from the right would drop `(12s)` first, on every pane
 * narrower than the label (about 53 columns for `hyp sync`, 66 for a history
 * replay). Slicing is by code point, so a cut never lands inside a surrogate
 * pair.
 *
 * There is a floor to that. A `status` suffix is as long as its caller makes
 * it (`hyp sync`'s runs to about 44 columns), and once the suffix alone will
 * not fit, giving up the whole label leaves nothing to give: the last resort
 * cuts the composed line from the right after all, so a pane under about 48
 * columns loses the end of `hyp sync`'s ETA. That is the ordering preference
 * failing, not the invariant - one frame is still one row at every width, with
 * no wrap and no trail, which is what this function is here to guarantee.
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
