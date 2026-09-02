// @ts-check

import { requireGithubRuntime } from './runtime.js'
import { runCaptureTick } from './tick.js'

/**
 * @import { CommandRunContext } from './types.js'
 */

/** `owner/repo` - exactly one slash, non-empty halves, no whitespace. */
const REPO_SLUG = /^[^/\s]+\/[^/\s]+$/

/**
 * `hyp github` - usage banner.
 *
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runGithub(_argv, ctx) {
  ctx.stdout.write(
    'hyp github <subcommand>\n' +
      '  backfill [owner/repo ...]  pull full history into github_events (cold-start)\n' +
      '  sync                       run one poll tick now (off the daemon)\n' +
      "\nthen run 'hyp graph project' to project github_events into the node/edge graph\n",
  )
  return 0
}

/**
 * `hyp github backfill [owner/repo ...]` - the deliberate cold-start pull of
 * full history (polling is forward-only, so a freshly-configured repo has years
 * of history a poller would never see - LLP 0360). With no positional repos it
 * backfills the whole configured selection. Fills `github_events` only;
 * projection is a separate `hyp graph project`.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runGithubBackfill(argv, ctx) {
  const parsed = parseRepoArgv(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp github backfill: ${parsed.error}\n`)
    return 2
  }
  try {
    const runtime = requireGithubRuntime()
    const only = parsed.repos.length > 0 ? parsed.repos : undefined

    const result = await runCaptureTick(runtime, { mode: 'backfill', only })
    ctx.stdout.write(`github backfill: ${result.events} event(s) across ${result.repos} repo(s)\n`)
    reportErrors(ctx, result.errors)
    if (only && result.repos === 0) {
      ctx.stderr.write(`hyp github backfill: none of [${only.join(', ')}] are in the active repository inventory\n`)
      return 1
    }
    ctx.stdout.write("run 'hyp graph project' to project github_events into the graph\n")
    return result.errors.length > 0 ? 1 : 0
  } catch (err) {
    ctx.stderr.write(`hyp github backfill: ${errMessage(err)}\n`)
    return 1
  }
}

/**
 * `hyp github sync` - run one poll tick now, off the daemon (the manual
 * analogue of the ongoing source; for tests and demos - LLP 0360).
 *
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runGithubSync(_argv, ctx) {
  try {
    const runtime = requireGithubRuntime()
    const result = await runCaptureTick(runtime, { mode: 'poll' })
    ctx.stdout.write(`github sync: ${result.events} event(s) across ${result.repos} repo(s)\n`)
    reportErrors(ctx, result.errors)
    return result.errors.length > 0 ? 1 : 0
  } catch (err) {
    ctx.stderr.write(`hyp github sync: ${errMessage(err)}\n`)
    return 1
  }
}

/**
 * @param {string[]} argv
 * @returns {{ ok: true, repos: string[] } | { ok: false, error: string }}
 */
function parseRepoArgv(argv) {
  /** @type {string[]} */
  const repos = []
  for (const token of argv) {
    if (token.startsWith('--')) return { ok: false, error: `unknown flag ${token}` }
    if (!REPO_SLUG.test(token)) return { ok: false, error: `expected "owner/repo", got ${token}` }
    repos.push(token)
  }
  return { ok: true, repos }
}

/**
 * @param {CommandRunContext} ctx
 * @param {Array<{ repo: string, error: string }>} errors
 */
function reportErrors(ctx, errors) {
  for (const e of errors) ctx.stderr.write(`  ! ${e.repo}: ${e.error}\n`)
}

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
}
