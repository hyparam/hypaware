// @ts-check

import process from 'node:process'
import readline from 'node:readline/promises'

import { isTty } from './stdio.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Ask a y/N question on the interactive terminal. The question goes to
 * stderr, not stdout, so a command's machine-readable output stays clean
 * for a caller that pipes it.
 *
 * Anything other than `y`/`yes` is a no: the default has to be the safe
 * one for a verb nobody can undo.
 *
 * @param {CommandRunContext} ctx
 * @param {string} question rendered verbatim, including its `[y/N]` suffix
 * @returns {Promise<boolean>}
 */
export async function askYesNo(ctx, question) {
  const rl = readline.createInterface({
    input: /** @type {NodeJS.ReadableStream} */ (ctx.stdin ?? process.stdin),
    output: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (ctx.stderr)),
  })
  try {
    const answer = await rl.question(question)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * The confirmation posture `hyp purge` established and every irreversible
 * verb has followed since (LLP 0104, LLP 0111#delete-confirm): prompt on an
 * interactive TTY, require an explicit `--yes` anywhere else. A command that
 * cannot ask must not assume.
 *
 * Returning a discriminant rather than a boolean keeps the refusal text with
 * the command: "refusing to purge" and "refusing to sync" name different
 * flags in their hints, and a shared string would have to be vague about
 * both.
 *
 * @param {{ ctx: CommandRunContext, yes: boolean, question: string }} opts
 * @returns {Promise<'confirmed' | 'declined' | 'no-tty'>}
 */
export async function requireConfirmation({ ctx, yes, question }) {
  if (yes) return 'confirmed'
  if (!isTty(ctx.stdin)) return 'no-tty'
  return (await askYesNo(ctx, question)) ? 'confirmed' : 'declined'
}
