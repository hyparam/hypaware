// @ts-check

import { evaluateCwdClassification } from '../../../../src/core/usage-policy/classification.js'

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * `hyp codex-hook classify-cwd`
 *
 * Codex's degraded classification prompt (LLP 0106). Codex has no
 * SessionStart hook that can inject session context the way Claude's does, so
 * the "force" degrades to a firm first-prompt nag (LLP 0106 "force is
 * per-client mechanics"): this command prints the classification prompt as
 * plain text to stdout so it can be surfaced at the top of a Codex session -
 * the `hypaware-privacy` skill (T9) drives it, and a Codex `notify`/wrapper
 * integration can invoke it on the first turn. The decision, the copy, and the
 * verbs are identical to Claude's; only the delivery differs.
 *
 * The cwd comes from the hook event when one is supplied on stdin, else from
 * the command context's cwd - Codex does not always hand a hook a JSON event.
 *
 * Like every client hook, this MUST never interrupt the client: on an
 * unenrolled machine, a non-interactive run, an already-classified folder, or
 * any lookup error it prints nothing and exits 0.
 *
 * @ref LLP 0106 [implements]: Codex "force" degrades to a first-prompt nag; same decision, copy, and verbs as Claude
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ evaluate?: typeof evaluateCwdClassification, isInteractive?: (env: NodeJS.ProcessEnv) => boolean }} [deps]
 * @returns {Promise<number>}
 */
export async function runCodexClassifyHook(argv, ctx, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    ctx.stdout.write('usage: hyp codex-hook classify-cwd\n')
    return 0
  }

  try {
    const event = await readEvent(ctx.stdin ?? process.stdin)
    const cwd = str(event.new_cwd) ?? str(event.cwd) ?? str(ctx.cwd) ?? process.cwd()
    if (!cwd) return 0

    const interactive = (deps.isInteractive ?? isInteractiveCodexSession)(ctx.env)
    const evaluate = deps.evaluate ?? evaluateCwdClassification
    const evaluation = await evaluate({ cwd, interactive, env: ctx.env })
    if (!evaluation.prompt || !evaluation.promptText) return 0

    // Plain text nag (no hookSpecificOutput envelope: Codex has no context
    // injection channel), framed so it reads as a firm session-opening notice.
    ctx.stdout.write('[HypAware] Classify this folder before continuing:\n')
    ctx.stdout.write(evaluation.promptText + '\n')
    return 0
  } catch {
    return 0
  }
}

/**
 * Codex has no per-session interactive/headless signal on the hook, so treat a
 * run as interactive unless a CI convention or the explicit
 * `HYP_HOOK_NONINTERACTIVE` escape hatch says otherwise (LLP 0106
 * #interactive). Erring toward passthrough: a missed nag is caught next
 * session; a spurious one is harmless plain text.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function isInteractiveCodexSession(env) {
  if (env.HYP_HOOK_NONINTERACTIVE && env.HYP_HOOK_NONINTERACTIVE.length > 0) return false
  if (env.CI && env.CI !== '0' && env.CI.toLowerCase() !== 'false') return false
  return true
}

/**
 * Read and parse an optional JSON hook event from stdin, returning `{}` when
 * there is none (Codex may invoke the command with no piped event).
 *
 * @param {NodeJS.ReadStream} stdin
 * @returns {Promise<Record<string, unknown>>}
 */
async function readEvent(stdin) {
  const input = await readStdin(stdin)
  if (!input) return {}
  try {
    const parsed = JSON.parse(input)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? /** @type {Record<string, unknown>} */ (parsed)
      : {}
  } catch {
    return {}
  }
}

/**
 * @param {NodeJS.ReadStream} stdin
 * @returns {Promise<string>}
 */
function readStdin(stdin) {
  if (stdin.isTTY) return Promise.resolve('')
  stdin.setEncoding('utf8')
  return new Promise((resolve) => {
    let data = ''
    let settled = false
    const finish = (/** @type {string} */ value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }
    const timeout = setTimeout(() => finish(data), 1000)
    stdin.on('data', (chunk) => { data += chunk })
    stdin.on('end', () => finish(data))
    stdin.on('error', () => finish(''))
  })
}

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
