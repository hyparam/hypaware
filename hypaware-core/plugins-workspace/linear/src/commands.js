// @ts-check

import { openBrowser } from 'hypaware/core/util'
import { withSpinner } from '../../../../src/core/cli/spinner.js'
import { requireLinearRuntime, getLinearClient } from './runtime.js'
import { loginLinear, logoutLinear } from './auth.js'
import { runLinearCaptureTick } from './capture.js'

/** @import { CommandRunContext } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

/** @param {string[]} _argv @param {CommandRunContext} ctx */
export async function runLinear(_argv, ctx) {
  ctx.stdout.write('hyp linear <login|logout|status|backfill|sync>\n' +
    '  login [--no-browser]   sign in to Linear with read-only browser OAuth\n' +
    '  logout                 remove local OAuth tokens\n' +
    '  status                 verify the account and workspace\n' +
    '  backfill               restart a bounded import of configured teams\n' +
    '  sync                   resume capture and automatically project the graph\n' +
    'Set linear.teams before collecting. Credentials never belong in config.\n')
  return 0
}

/** @param {string[]} argv @param {CommandRunContext} ctx */
export async function runLinearLogin(argv, ctx) {
  if (argv.some(arg => arg !== '--no-browser')) {
    ctx.stderr.write('usage: hyp linear login [--no-browser]\n')
    return 2
  }
  const rt = requireLinearRuntime()
  const abort = new AbortController()
  const cancel = () => abort.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    if (rt.env[rt.config.token_env]?.trim()) ctx.stdout.write(`Environment override ${rt.config.token_env} remains the effective capture credential.\n`)
    const account = await loginLinear(rt.stateDir, {
      clientId: rt.config.client_id || rt.env.LINEAR_CLIENT_ID || '', redirectUri: rt.config.redirect_uri, signal: abort.signal,
      async onUrl(url) {
        ctx.stdout.write(`Authorize read-only Linear access in a browser on this machine:\n${url}\nWaiting for sign-in (Ctrl-C to cancel)...\n`)
        if (!argv.includes('--no-browser')) openBrowser(url)
      },
    })
    rt.log.info('linear.login_completed', { operation: 'linear.login', status: 'ok' })
    ctx.stdout.write(`Signed in to Linear workspace ${account.workspace}.\n`)
    return 0
  } catch (err) {
    rt.log.warn('linear.login_failed', { operation: 'linear.login', error_kind: /** @type {any} */ (err)?.hypErrorKind ?? 'linear_auth_store' })
    if (abort.signal.aborted) return 130
    ctx.stderr.write(`hyp linear login: ${message(err)}\n`)
    return 1
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}

/** @param {string[]} argv @param {CommandRunContext} ctx */
export async function runLinearLogout(argv, ctx) {
  if (argv.length) {
    ctx.stderr.write('usage: hyp linear logout\n')
    return 2
  }
  const rt = requireLinearRuntime()
  try {
    await logoutLinear(rt.stateDir)
    rt.log.info('linear.logout_completed', { operation: 'linear.logout', status: 'ok' })
    ctx.stdout.write('Linear: local OAuth tokens removed. Revoke the app in Linear settings to remove its grant.\n')
    if (rt.env[rt.config.token_env]?.trim()) ctx.stdout.write(`Environment override ${rt.config.token_env} remains active; unset it to stop using it.\n`)
    return 0
  } catch {
    ctx.stderr.write('hyp linear logout: cannot update the private credential file\n')
    return 1
  }
}

/** @param {string[]} argv @param {CommandRunContext} ctx */
export async function runLinearStatus(argv, ctx) {
  if (argv.length) {
    ctx.stderr.write('usage: hyp linear status\n')
    return 2
  }
  const rt = requireLinearRuntime()
  try {
    ctx.stdout.write(`Linear credential source: ${rt.env[rt.config.token_env]?.trim() ? `environment (${rt.config.token_env})` : 'local OAuth'}.\n`)
    const account = await getLinearClient(rt).identity()
    ctx.stdout.write(`Linear workspace: ${account.workspace} (${account.workspace_id}).\n`)
    ctx.stdout.write(rt.config.teams.length ? `Configured teams: ${rt.config.teams.join(', ')}\n` : 'Set linear.teams before collecting.\n')
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp linear status: ${message(err)}\n`)
    return 1
  }
}

/** @param {string[]} argv @param {CommandRunContext} ctx */
export function runLinearSync(argv, ctx) { return capture(argv, ctx, false) }
/** @param {string[]} argv @param {CommandRunContext} ctx */
export function runLinearBackfill(argv, ctx) { return capture(argv, ctx, true) }

/** @param {string[]} argv @param {CommandRunContext} ctx @param {boolean} backfill */
async function capture(argv, ctx, backfill) {
  const name = backfill ? 'backfill' : 'sync'
  if (argv.length) {
    ctx.stderr.write(`usage: hyp linear ${name}\n`)
    return 2
  }
  const rt = requireLinearRuntime()
  if (!rt.config.teams.length) {
    ctx.stderr.write(`hyp linear ${name}: set linear.teams before collecting\n`)
    return 2
  }
  const abort = new AbortController()
  const cancel = () => abort.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    const result = await withSpinner({ stdout: ctx.stdout, env: rt.env, label: 'Collecting Linear activity...' },
      () => runLinearCaptureTick(rt, { backfill, signal: abort.signal }))
    ctx.stdout.write(`linear ${name}: ${result.events} event(s), ${result.requests} request(s)\n`)
    if (result.pending) ctx.stdout.write('Bounded work remains; run hyp linear sync or let the daemon resume it.\n')
    for (const error of result.errors) ctx.stderr.write(`hyp linear ${name}: ${error}\n`)
    return result.cancelled ? 130 : result.errors.length ? 1 : 0
  } catch (err) {
    ctx.stderr.write(`hyp linear ${name}: ${message(err)}\n`)
    return 1
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}

/** @param {unknown} err */
function message(err) {
  return /** @type {any} */ (err)?.hypErrorKind && err instanceof Error ? err.message : 'operation failed; check local state and retry'
}
