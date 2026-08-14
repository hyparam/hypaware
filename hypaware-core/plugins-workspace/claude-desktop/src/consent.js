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
 * Printed before {@link confirmProceed}'s one question. The pair replaced
 * the original mechanism-first consent screen (LLP 0139 #informed-consent
 * as amended): reaching this command is already the opt-in - the picker
 * row is never pre-checked, so it was ticked deliberately, or the command
 * was typed - so the question defaults to yes and exists to say what
 * enter does next, because the first step can launch a browser sign-in
 * with no further warning.
 *
 * @ref LLP 0139#informed-consent [implements]: the Desktop credential posture is stated loud at the point of action, ahead of the question
 * @param {{ inputs: ProfileInputs, plistPath: string, credentialMode: string, residueDir: string, residuePresent: boolean }} args
 * @returns {string}
 */
export function buildConsentExplanation(args) {
  const lines = []
  lines.push('Claude Desktop needs extra setup')
  lines.push('')
  lines.push(
    'Unlike Claude Code and Codex, which keep their own sign-in while HypAware only '
    + 'changes which URL they talk to, Claude Desktop can only reach your local '
    + `gateway (${args.inputs.baseUrl}) through a credential helper. Attaching it `
    + 'means HypAware has to hold an Anthropic credential on this machine and hand '
    + 'it to Claude Desktop on request.',
  )
  lines.push('')
  lines.push('Setting it up will:')
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
    + 'or into recorded rows. To undo it later, delete the helper file and run '
    + "'hyp claude-account logout'.",
  )
  return lines.join('\n')
}

/**
 * The one question in front of the steps, defaulting to yes.
 *
 * It exists because of what a yes does *immediately*: on a machine not
 * yet signed in, step 1 launches the Claude OAuth flow in a browser, and
 * being dropped into an auth flow with no prompt reads as the machine
 * acting on its own (8/13 feedback, the run that removed the prompt
 * entirely). So the question always stands between the disclosure and
 * the steps, and when a sign-in is what comes next it says so.
 *
 * Defaults to yes, unlike the original gate: the user opted in by
 * ticking a never-pre-checked row or typing the command, the plist
 * write still cannot happen without the sudo password, and a browser
 * tab is dismissable. Only an explicit no declines.
 *
 * Every non-answer that cannot be a real yes still declines: a cancel
 * (esc / ctrl-c), an absent or non-stream stdin, and a stdin that ends
 * without a line all return false with the hint naming `--yes` and
 * `--print-commands`, and the EOF case resolves rather than hanging
 * (the same line/close race the original gate closed).
 *
 * @ref LLP 0139#informed-consent [implements]: the question stands between the disclosure and the sign-in launch, and names the launch
 * @param {CommandRunContext} cmdCtx
 * @param {{ signInFirst: boolean }} args
 * @returns {Promise<boolean>}
 */
export async function confirmProceed(cmdCtx, { signInFirst }) {
  const stdin = /** @type {NodeJS.ReadableStream | undefined} */ (cmdCtx.stdin)
  if (!stdin || typeof stdin.on !== 'function') {
    writeNonInteractiveHint(cmdCtx)
    return false
  }

  try {
    if (shouldUseTui({ stdin, stdout: cmdCtx.stdout, env: cmdCtx.env })) {
      const choice = await select({
        title: 'Set up Claude Desktop now?',
        options: [
          {
            value: 'yes',
            label: 'Continue',
            summary: signInFirst
              ? 'Opens the Claude sign-in in your browser, then runs the steps above.'
              : 'Runs the steps listed above.',
          },
          { value: 'no', label: 'Skip for now', summary: 'Changes nothing. Re-run hyp claude-desktop install any time.' },
        ],
        default: 'yes',
        clearOnResolve: true,
        stdin: /** @type {NodeJS.ReadStream} */ (stdin),
        stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (cmdCtx.stdout)),
        env: cmdCtx.env,
      })
      return choice === 'yes'
    }
    const rl = readline.createInterface({
      input: stdin,
      output: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (cmdCtx.stdout)),
      terminal: false,
    })
    try {
      cmdCtx.stdout.write(
        signInFirst
          ? 'Set up Claude Desktop now? The first step opens the Claude sign-in in your browser. [Y/n]: '
          : 'Set up Claude Desktop now? [Y/n]: '
      )
      // The `line`/`close` events rather than `rl.question`: that promise
      // never settles when the input reaches EOF without a line, which is
      // what hung the original gate on a redirected stdin.
      /** @type {string | undefined} */
      const answer = await new Promise((resolve) => {
        rl.once('line', (line) => resolve(line))
        rl.once('close', () => resolve(undefined))
      })
      if (answer === undefined) {
        writeNonInteractiveHint(cmdCtx)
        return false
      }
      // Only an explicit no declines; a bare enter takes the stated default.
      return !/^n(o)?$/i.test(answer.trim())
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
