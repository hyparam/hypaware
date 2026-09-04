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
 * line and the output is byte-identical to what the callers printed before
 * the spinner existed, which is what keeps the scripted transcripts stable.
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
 *   stdout: { write(chunk: string): unknown },
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
    stdout.write(`\r\x1b[2K${FRAMES[frame % FRAMES.length]} ${label}${suffix}`)
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
