// @ts-check

import { requireGithubRuntime } from './runtime.js'
import { GRAPH_ERROR_REPO, runCaptureTick } from './tick.js'
import { openBrowser } from 'hypaware/core/util'
import { spinnerAnimates, withSpinner } from '../../../../src/core/cli/spinner.js'
import { loginGithub, logoutGithub, readGithubAuth, resolveGithubOAuth } from './auth.js'
import { githubIdentity } from './oauth.js'
import { tokenFromGh } from './github_client.js'

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
      '  login [--no-browser]        sign in with a GitHub device code\n' +
      '  logout                     remove local OAuth tokens\n' +
      '  status                     verify authentication and show its source\n' +
      '  backfill [owner/repo ...]  pull full history into github_events (cold-start)\n' +
      '  sync                       run one poll tick now (off the daemon)\n' +
      '\nNamed backfills import once, even without recorded session evidence.\n' +
      'GitHub capture automatically projects github_events into the node/edge graph.\n',
  )
  return 0
}

/**
 * `hyp github backfill [owner/repo ...]` - the deliberate cold-start pull of
 * full history (polling is forward-only, so a freshly-configured repo has years
 * of history a poller would never see - LLP 0360). With no positional repos it
 * backfills the whole configured selection and projects captured GitHub rows.
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
    ctx.stdout.write(`github backfill: ${result.events} event(s) across ${result.visited} repo(s)\n`)
    if (result.pending) ctx.stdout.write('github backfill: bounded work remains and will resume on the next GitHub capture tick\n')
    reportErrors(ctx, result.errors)
    // Zero repos with a *capture* error reported is an inventory that never
    // resolved, not a selection that missed: `reportErrors` already printed the
    // real cause, so do not contradict it with a claim about the user's config.
    // A failed projection shares that list (LLP 0392#retry) and is never that
    // cause, so it must not stand in for one: letting it swallow this line
    // leaves a user who named a repository outside the inventory reading a
    // graph error instead of the reason their selection captured nothing.
    const captured = result.errors.filter((e) => e.repo !== GRAPH_ERROR_REPO)
    if (only && result.repos === 0 && captured.length === 0) {
      ctx.stderr.write(`hyp github backfill: none of [${only.join(', ')}] are eligible; check repository exclusions\n`)
      return 1
    }
    return result.errors.length > 0 ? 1 : 0
  } catch (err) {
    ctx.stderr.write(`hyp github backfill: ${errMessage(err)}\n`)
    return 1
  }
}

/** @param {string[]} argv @param {CommandRunContext} ctx */
export async function runGithubLogin(argv, ctx) {
  if (argv.some((arg) => arg !== '--no-browser')) {
    ctx.stderr.write('usage: hyp github login [--no-browser]\n')
    return 2
  }
  const rt = requireGithubRuntime()
  const abort = new AbortController()
  const cancel = () => abort.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    ctx.stdout.write('GitHub login requests repo access, including private repositories. GitHub grants write permissions with this scope; HypAware only reads.\n')
    if (rt.env[rt.config.token_env]?.trim()) ctx.stdout.write(`Environment override ${rt.config.token_env} remains the effective capture credential.\n`)
    // The device code is only needed while the sign-in is open, so on a
    // terminal it is drawn above the wait's spinner and goes with it
    // (LLP 0437 #regions). Off a terminal it prints once, as it arrives.
    const waiting = 'Waiting for GitHub authorization (Ctrl-C to cancel)...'
    const animate = spinnerAnimates(ctx.stdout, rt.env)
    /** @type {string[]} */
    let codeLines = []
    const account = await withSpinner(
      { stdout: ctx.stdout, env: rt.env, label: waiting, quietWhenPlain: true, above: () => codeLines },
      () => loginGithub(rt.stateDir, {
        signal: abort.signal,
        onCode(code, uri) {
          codeLines = [`Open ${uri} and enter code: ${code}`]
          if (!animate) ctx.stdout.write(`${codeLines[0]}\n${waiting}\n`)
          if (!argv.includes('--no-browser')) openBrowser(uri)
        },
      })
    )
    rt.log.info('github.login_completed', { operation: 'github.login', status: 'ok', source: 'oauth' })
    ctx.stdout.write(`✓ Signed in to GitHub as ${account.login}\n`)
    return 0
  } catch (err) {
    rt.log.warn('github.login_failed', { operation: 'github.login', error_kind: /** @type {{ hypErrorKind?: string }} */ (err)?.hypErrorKind ?? 'github_auth_store' })
    // A Ctrl-C is the user's own answer, and the terminal already shows it;
    // a caller that carries on (setup) says what it means for them.
    if (abort.signal.aborted) return 130
    ctx.stderr.write(`hyp github login: ${errMessage(err)}\n`)
    return 1
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}

/** @param {string[]} argv @param {CommandRunContext} ctx */
export async function runGithubLogout(argv, ctx) {
  if (argv.length) {
    ctx.stderr.write('usage: hyp github logout\n')
    return 2
  }
  const rt = requireGithubRuntime()
  try {
    await logoutGithub(rt.stateDir)
    rt.log.info('github.logout_completed', { operation: 'github.logout', status: 'ok' })
    ctx.stdout.write('GitHub: local OAuth tokens removed. Legacy gh fallback stays disabled.\n')
    if (rt.env[rt.config.token_env]?.trim()) ctx.stdout.write(`Environment override ${rt.config.token_env} remains active; unset it to stop using it.\n`)
    ctx.stdout.write('To revoke the GitHub grant, visit https://github.com/settings/applications\n')
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp github logout: ${errMessage(err)}\n`)
    return 1
  }
}

/** @param {string[]} argv @param {CommandRunContext} ctx */
export async function runGithubStatus(argv, ctx) {
  if (argv.length) {
    ctx.stderr.write('usage: hyp github status\n')
    return 2
  }
  const rt = requireGithubRuntime()
  try {
    let token = rt.env[rt.config.token_env]?.trim()
    if (token) ctx.stdout.write(`GitHub credential source: environment override (${rt.config.token_env}); local OAuth is overridden.\n`)
    else {
      const record = readGithubAuth(rt.stateDir)
      ctx.stdout.write(`GitHub credential source: ${record ? `local OAuth (${record.status})` : 'legacy gh'}.\n`)
      token = await resolveGithubOAuth(rt.stateDir) ?? (await tokenFromGh(rt.env)).trim()
    }
    const account = await githubIdentity(token)
    ctx.stdout.write(`GitHub: authenticated as ${account.login}.\n`)
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp github status: ${errMessage(err)}\n`)
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
    ctx.stdout.write(`github sync: ${result.events} event(s) across ${result.visited} repo(s)\n`)
    if (result.pending) ctx.stdout.write('github sync: bounded work remains and will resume on the next GitHub capture tick\n')
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
