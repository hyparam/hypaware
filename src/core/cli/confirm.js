// @ts-check

import process from 'node:process'
import readline from 'node:readline/promises'

import { askLineOnce } from './line_asker.js'
import { isTty } from './stdio.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Ask a yes/no question on the interactive terminal. The question goes to
 * stderr, not stdout, so a command's machine-readable output stays clean
 * for a caller that pipes it.
 *
 * Polarity is the caller's: prompts default yes (`[Y/n]`, `defaultYes:
 * true`) unless a bare enter would destroy data, where only an explicit
 * `y`/`yes` may proceed (`[y/N]`). Either way, anything that is not the
 * explicit off-default word lands on the default the suffix printed, so
 * the caller's question string and its `defaultYes` must agree.
 *
 * That includes a terminal that stops being able to answer. `rl.question`
 * leaves its promise permanently unsettled at EOF, so a ctrl+D or a
 * dropped session hung the verb on its own confirmation instead of
 * answering it. `askLineOnce` settles that case as `null`, read here as
 * the empty line the suffix already routes to the default - so the EOF
 * answer is the printed default, and cannot drift from it.
 *
 * @ref LLP 0299#decision [implements]: default yes unless a bare enter would destroy data
 * @ref LLP 0190#eof-everywhere [implements]: a spent stdin lands on the prompt's stated default rather than waiting on an answer that can never come
 *
 * @param {CommandRunContext} ctx
 * @param {string} question rendered verbatim, including its `[Y/n]` or `[y/N]` suffix
 * @param {{ defaultYes?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function askYesNo(ctx, question, { defaultYes = false } = {}) {
  const input = /** @type {NodeJS.ReadableStream} */ (ctx.stdin ?? process.stdin)
  const rl = readline.createInterface({
    input,
    output: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (ctx.stderr)),
  })
  try {
    const answer = ((await askLineOnce(rl, input, question)) ?? '').trim()
    if (defaultYes) return !/^n(o)?$/i.test(answer)
    return /^y(es)?$/i.test(answer)
  } finally {
    rl.close()
  }
}

/**
 * The confirmation posture `hyp purge` established and every irreversible
 * verb has followed since (LLP 0104, LLP 0155#delete-confirm): prompt on an
 * interactive TTY, require an explicit `--yes` anywhere else. A command that
 * cannot ask must not assume.
 *
 * Returning a discriminant rather than a boolean keeps the refusal text with
 * the command: "refusing to purge" and "refusing to sync" name different
 * flags in their hints, and a shared string would have to be vague about
 * both.
 *
 * @param {{ ctx: CommandRunContext, yes: boolean, question: string, defaultYes?: boolean }} opts
 * @returns {Promise<'confirmed' | 'declined' | 'no-tty'>}
 */
export async function requireConfirmation({ ctx, yes, question, defaultYes = false }) {
  if (yes) return 'confirmed'
  if (!isTty(ctx.stdin)) return 'no-tty'
  return (await askYesNo(ctx, question, { defaultYes })) ? 'confirmed' : 'declined'
}
