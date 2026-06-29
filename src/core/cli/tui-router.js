// @ts-check

import process from 'node:process'

/**
 * Decide whether the walkthrough should drive the new TUI prompts or
 * fall back to the legacy numbered-list `readline` prompts.
 *
 * The TUI path requires BOTH stdin and stdout to be TTYs because the
 * runtime needs raw-mode key events and rewindable terminal frames.
 * `HYP_NO_TUI=1` forces the legacy path even when both ends are TTYs:
 * a deliberate escape hatch for CI shells that report `isTTY=true` but
 * are wrapped by something that mangles ANSI sequences.
 *
 * The env lookup goes through `opts.env` when supplied so callers that
 * inject env (the walkthrough threads `ctx.env`) get the same answer
 * the rest of the command pipeline does. Falls back to `process.env`
 * only when no env is provided.
 *
 * @param {{ stdin?: NodeJS.ReadableStream, stdout?: unknown, env?: NodeJS.ProcessEnv }} opts
 * @returns {boolean}
 */
export function shouldUseTui(opts) {
  const env = opts.env ?? process.env
  if (env.HYP_NO_TUI === '1') return false
  const inp = opts.stdin ?? process.stdin
  const out = opts.stdout
  return isTty(inp) && isTty(out)
}

/**
 * Lightweight TTY probe that tolerates the duck-typed `{ write }` shape
 * the walkthrough accepts for stdout. Anything without `isTTY === true`
 * is treated as non-TTY.
 *
 * @param {unknown} stream
 * @returns {boolean}
 */
export function isTty(stream) {
  return (
    !!stream
    && typeof stream === 'object'
    && /** @type {{ isTTY?: boolean }} */ (stream).isTTY === true
  )
}
