// @ts-check

import readline from 'node:readline/promises'

import { select } from '../../../../src/core/cli/tui/index.js'
import { isPromptCancelledError } from '../../../../src/core/cli/tui/runtime.js'
import { shouldUseTui } from '../../../../src/core/cli/tui-router.js'

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ProfileInputs } from './types.js'
 */

/**
 * Build the plain-language explanation shown before `claude-desktop
 * install` touches anything.
 *
 * Desktop is the one client whose attach is not a redirect. Claude Code
 * and Codex keep their own credential and HypAware only rewrites a base
 * URL (`ANTHROPIC_BASE_URL`, Codex's `base_url`), so the gateway stays the
 * credential-ignorant passthrough LLP 0016 requires. Desktop's
 * third-party-inference profile has no equivalent "keep using my existing
 * login" mode: its credential field is `inferenceCredentialHelper`, an
 * absolute path Desktop runs with no arguments and reads stdout from
 * (LLP 0116#helper-contract). So a Desktop attach necessarily makes this
 * machine hold an Anthropic credential, which is a different posture from
 * every other client and the reason this gate exists at all.
 *
 * The text names each side effect that outlives the command: the
 * credential store, the wrapper under the state dir, the cleared dialog
 * residue, and the root-owned managed plist. A user who reads only this
 * block should be able to predict every file that changes.
 *
 * @ref LLP 0139#informed-consent [implements]: the Desktop credential decision is made loud at the point of action, replacing config-file friction as the opt-in gate
 * @param {{ inputs: ProfileInputs, plistPath: string, credentialMode: string, residueDir: string, residuePresent: boolean }} args
 * @returns {string}
 */
export function buildConsentExplanation(args) {
  const lines = []
  lines.push('Attaching Claude Desktop to HypAware')
  lines.push('')
  lines.push(
    'This points Claude Desktop at your local HypAware gateway '
    + `(${args.inputs.baseUrl}) so its conversations are recorded on this machine.`,
  )
  lines.push('')
  lines.push(
    'Claude Desktop is different from Claude Code and Codex. Those keep their own '
    + 'sign-in and HypAware only changes which URL they talk to. Claude Desktop has no '
    + 'such option: pointing it at any non-Anthropic endpoint means it stops using its '
    + 'built-in login and asks a helper program for a credential instead. So HypAware '
    + 'has to hold an Anthropic credential on this machine and hand it over on request.',
  )
  lines.push('')
  lines.push('What this will change:')
  if (args.credentialMode === 'org_key') {
    lines.push('  - use the org API key from your fleet config (no sign-in needed)')
  } else {
    lines.push('  - sign you in to your Claude account and store the token locally')
  }
  lines.push(`  - write a small credential helper script at ${args.inputs.helperPath}`)
  if (args.residuePresent) {
    lines.push(`  - back up and clear Claude Desktop's own saved settings at ${args.residueDir}`)
  }
  lines.push(`  - write ${args.plistPath} (needs sudo, so you will be asked for your password)`)
  lines.push('  - ask you to quit and reopen Claude Desktop')
  lines.push('')
  lines.push(
    'The credential never leaves this machine and is never written into the profile '
    + 'or into recorded rows. To undo it later, delete the file above and run '
    + "'hyp claude-account logout'.",
  )
  return lines.join('\n')
}

/**
 * Ask for consent before running the install steps, defaulting to no.
 *
 * Defaults the other way from the backfill consent prompt, which defaults
 * to yes: backfill reads local files this machine already has, whereas
 * this acquires a credential, escalates to root, and writes a file outside
 * the user's home. An accidental bare enter must not do any of that.
 *
 * Returns `false` on a cancel (esc / ctrl-c) and on a non-interactive
 * stream. Refusing rather than assuming consent is the point: this runs
 * in-process from the wizard's configure phase, which is attended and so
 * always has a real stdin, while an unattended fleet places the same plist
 * by MDM and never reaches this command (LLP 0133#one-surface).
 *
 * "Non-interactive" has to include a stdin that exists but carries no
 * answer. The dispatcher defaults `ctx.stdin` to `process.stdin`, so the
 * falsy check below never fires in a real invocation, and a redirected
 * stdin (`hyp claude-desktop install < /dev/null`) reached the `readline`
 * branch where `question` never settles at EOF: the command hung with the
 * refusal hint unprinted, which is the same unattended-hang class
 * LLP 0139#print-commands-applies-nothing closes for that flag. EOF now
 * resolves to a decline.
 *
 * @ref LLP 0139#default-no [implements]: the Desktop consent prompt defaults to no, and every non-answer (cancel, EOF, absent stdin) is a no
 * @param {CommandRunContext} cmdCtx
 * @param {string} explanation
 * @returns {Promise<boolean>}
 */
export async function confirmInstall(cmdCtx, explanation) {
  cmdCtx.stdout.write(`\n${explanation}\n\n`)

  const promptOpts = {
    ...(cmdCtx.stdin ? { stdin: cmdCtx.stdin } : {}),
    stdout: cmdCtx.stdout,
    env: cmdCtx.env,
  }

  if (!cmdCtx.stdin) {
    writeNonInteractiveHint(cmdCtx)
    return false
  }

  try {
    if (shouldUseTui(promptOpts)) {
      const choice = await select({
        title: 'Attach Claude Desktop with the changes above?',
        options: [
          { value: 'no', label: 'No - leave Claude Desktop alone', summary: 'This command changes nothing. Re-run hyp claude-desktop install any time.' },
          { value: 'yes', label: 'Yes - go ahead', summary: 'Runs the steps listed above.' },
        ],
        default: 'no',
        clearOnResolve: true,
        stdin: /** @type {NodeJS.ReadStream} */ (cmdCtx.stdin),
        stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (cmdCtx.stdout)),
        env: cmdCtx.env,
      })
      return choice === 'yes'
    }
    const rl = readline.createInterface({
      input: /** @type {NodeJS.ReadableStream} */ (cmdCtx.stdin),
      output: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (cmdCtx.stdout)),
      terminal: false,
    })
    try {
      cmdCtx.stdout.write('Attach Claude Desktop with the changes above? [y/N]: ')
      // Deliberately the `line`/`close` events rather than `rl.question`:
      // that promise never settles when the input reaches EOF without a
      // line, which is what hung the command on a redirected stdin. One
      // promise settled by whichever event fires first is decidable, where
      // racing two promises is not: readline emits `line` for a trailing
      // partial line before `close`, but the answer would lose a
      // microtask-ordering race against a stream that ends in the same tick.
      /** @type {string | undefined} */
      const answer = await new Promise((resolve) => {
        rl.once('line', (line) => resolve(line))
        rl.once('close', () => resolve(undefined))
      })
      if (answer === undefined) {
        writeNonInteractiveHint(cmdCtx)
        return false
      }
      const trimmed = answer.trim().toLowerCase()
      return trimmed === 'y' || trimmed === 'yes'
    } finally {
      rl.close()
    }
  } catch (err) {
    if (isPromptCancelledError(err)) return false
    throw err
  }
}

/**
 * The one refusal message every non-answering stdin path prints, so the
 * escape hatches are named whether the stream was absent or simply ended
 * without an answer.
 *
 * @param {CommandRunContext} cmdCtx
 */
function writeNonInteractiveHint(cmdCtx) {
  cmdCtx.stderr.write(
    'claude-desktop install: needs an interactive terminal to confirm. '
    + "Re-run with --yes to accept the changes above, or --print-commands to see them without applying.\n",
  )
}
