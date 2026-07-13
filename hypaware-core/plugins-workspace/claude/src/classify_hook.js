// @ts-check

import { evaluateCwdClassification } from '../../../../src/core/usage-policy/classification.js'

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * `hyp claude-hook classify-cwd`
 *
 * Plugin-contributed SessionStart hook (LLP 0106), installed at attach
 * alongside the session-context hook. On an enrolled machine, when Claude Code
 * opens a session in a directory that has no explicit governing usage class, it
 * emits a SessionStart `additionalContext` block asking the assistant to have
 * the user classify the folder (sync / local-only / ignore) and record the
 * answer via the same `hyp ignore` marking verbs everyone else uses. The
 * folder is asked about once: an explicit machine-local entry (including an
 * explicit `full`/sync) suppresses the next prompt.
 *
 * Claude's SessionStart hook can inject context that steers the session before
 * work proceeds - the "block with a prompt" mechanism from LLP 0106. This is
 * that mechanism: the additionalContext is a firm instruction to classify
 * first, not a hard process block (which SessionStart does not offer), so it
 * never wedges the session.
 *
 * Like every client hook, this MUST never interrupt Claude Code: malformed
 * input, a missing cwd, an unenrolled machine, a non-interactive run, an
 * already-classified folder, or any lookup error all degrade to "no prompt"
 * with exit 0 and no output.
 *
 * @ref LLP 0106 [implements]: enrolled + interactive + unclassified -> a SessionStart classification prompt; the Claude "force" is additionalContext injection
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ evaluate?: typeof evaluateCwdClassification, isInteractive?: typeof isInteractiveClaudeSession }} [deps]
 * @returns {Promise<number>}
 */
export async function runClaudeClassifyHook(argv, ctx, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    ctx.stdout.write('usage: hyp claude-hook classify-cwd\n')
    return 0
  }

  try {
    const input = await readStdin(ctx.stdin ?? process.stdin)
    /** @type {Record<string, unknown>} */
    let event
    try {
      const parsed = JSON.parse(input || '{}')
      event = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? /** @type {Record<string, unknown>} */ (parsed)
        : {}
    } catch {
      return 0
    }

    const cwd = str(event.new_cwd) ?? str(event.cwd)
    if (!cwd) return 0

    const interactive = (deps.isInteractive ?? isInteractiveClaudeSession)(event, ctx.env)
    const evaluate = deps.evaluate ?? evaluateCwdClassification
    const evaluation = await evaluate({ cwd, interactive, env: ctx.env })
    if (!evaluation.prompt || !evaluation.promptText) return 0

    // SessionStart hooks inject context by emitting a hookSpecificOutput
    // envelope on stdout; the additionalContext is prepended to the session.
    const payload = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: evaluation.promptText,
      },
    }
    ctx.stdout.write(JSON.stringify(payload) + '\n')
    return 0
  } catch {
    // A hook must never throw back into Claude Code.
    return 0
  }
}

/**
 * Decide whether a Claude SessionStart event represents an interactive session
 * a human is opening (so a classification prompt is worth surfacing) versus a
 * headless/automatic run that must pass through untouched (LLP 0106
 * #interactive).
 *
 * Claude does not hand hooks a single "interactive" boolean, so this reads the
 * signals it does provide, erring toward passthrough:
 *
 * - `source: "compact"` is an automatic context compaction, not a human
 *   opening a session -> non-interactive.
 * - a set `CI` env var (the CI convention) -> non-interactive.
 * - an explicit `HYP_HOOK_NONINTERACTIVE` escape hatch (any non-empty value)
 *   -> non-interactive, for headless harnesses that want to opt out.
 *
 * Otherwise the session is treated as interactive. A wrong "interactive" guess
 * is cheap in both directions: at worst a headless run receives context it
 * ignores (it never hangs or fails), or an interactive session misses one
 * prompt and the next session catches the still-unclassified folder.
 *
 * @param {Record<string, unknown>} event
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function isInteractiveClaudeSession(event, env) {
  if (env.HYP_HOOK_NONINTERACTIVE && env.HYP_HOOK_NONINTERACTIVE.length > 0) return false
  if (env.CI && env.CI !== '0' && env.CI.toLowerCase() !== 'false') return false
  if (str(event.source) === 'compact') return false
  return true
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
