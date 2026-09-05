// @ts-check

import crypto from 'node:crypto'
import process from 'node:process'

import { withSpinner } from '../cli/spinner.js'
import { Attr, getLogger } from '../observability/index.js'
import { exchangeCode, trimSlash } from './identity_client.js'
import { startLoginPoller } from './login_poll.js'
import { openBrowser as defaultOpenBrowser } from './open_browser.js'
import { createPkcePair } from './pkce.js'

/**
 * Orchestrate the browser authorization-code flow (LLP 0058 D3, LLP 0342):
 * generate a PKCE pair and a random `state`, build the `/login/start` URL,
 * open the browser (or print the URL), poll the server for the one-time code,
 * exchange it at `/token`, and return the session. No persistence here: the
 * caller stores the returned session.
 *
 * The code arrives by polling, not by a loopback redirect (LLP 0342 D1): the
 * browser can be on any machine, so `hyp remote login` works over SSH and in
 * containers with no flags. The start URL carries no `redirect_uri`; its
 * absence is what selects poll delivery on the server.
 *
 * @import { OidcSession } from '../../../src/core/remote/types.js'
 */

/**
 * @param {{
 *   identityBase: string,
 *   org?: string,
 *   host?: string,
 *   noBrowser?: boolean,
 *   openBrowser?: typeof defaultOpenBrowser,
 *   fetchImpl?: typeof fetch,
 *   startPoller?: typeof startLoginPoller,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   print?: (line: string) => void,
 *   compact?: boolean,
 *   stdout?: { write(chunk: string): unknown },
 *   env?: NodeJS.ProcessEnv,
 * }} args
 * @returns {Promise<OidcSession>}
 * @ref LLP 0058#d3 [implements]: client orchestrates the downstream PKCE leg; verifier held in memory, presented at /token
 * @ref LLP 0342#d1 [implements]: the outcome is pulled from the server, never pushed to a listener; loopback.js is gone
 */
export async function loginWithBrowser({
  identityBase,
  org,
  host,
  noBrowser = false,
  openBrowser = defaultOpenBrowser,
  fetchImpl,
  startPoller = startLoginPoller,
  timeoutMs,
  pollIntervalMs,
  print = () => {},
  compact = false,
  stdout = process.stdout,
  env,
}) {
  const log = getLogger('remote')
  const { verifier, challenge } = createPkcePair()
  const state = crypto.randomBytes(16).toString('hex')

  const poller = startPoller({ identityBase, state, timeoutMs, intervalMs: pollIntervalMs, fetchImpl })
  try {
    const startUrl = buildStartUrl({ identityBase, challenge, state, org })

    log.info('remote.login_start', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: 'remote.login',
      [Attr.STATUS]: 'ok',
      has_org: Boolean(org),
      smoke_step: 'login_start',
    })

    const opened = noBrowser ? false : openBrowser(startUrl)
    if (compact) {
      // The wizard's join lane: the same fallback URL, without the paragraph
      // around it. The lane's own position line already says what is happening.
      print(opened ? 'Sign in using the browser that just opened; if it did not open, visit:' : 'Open this URL in your browser (any machine) to sign in:')
      print(`  ${startUrl}`)
    } else if (opened) {
      // The opener boolean is best-effort: a launcher that exists but fails (no
      // display on a headless box) still returns true. So phrase this as an
      // attempt, not a fact, and always print the URL as the real fallback -
      // opened anywhere, on any device, the login still completes here.
      print(`Opening your browser to sign in. Waiting for the sign-in to complete...`)
      print(`If it did not open, visit (from any machine):\n\n  ${startUrl}\n`)
    } else {
      print(`Open this URL in your browser (any machine) to sign in:\n\n  ${startUrl}\n`)
    }
    log.info('remote.browser_open', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: 'remote.login',
      [Attr.STATUS]: opened ? 'ok' : 'skipped',
      opener_found: opened,
      smoke_step: 'browser_open',
    })

    // The poll runs to a five-minute budget. The plain lane says so in a standing
    // line; compact is the lane that drops standing lines, so it says it with a
    // spinner instead - live while the poll runs, cleared once the sign-in
    // settles, and off a TTY the same one plain line.
    const poll = () => poller.waitForCode()
    const { code } = compact
      ? await withSpinner({ stdout, env, label: 'Waiting for the sign-in to complete...' }, poll)
      : await poll()
    const session = await exchangeCode({ identityBase, code, codeVerifier: verifier, host, fetchImpl })
    log.info('remote.login_complete', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: 'remote.login',
      [Attr.STATUS]: 'ok',
      smoke_step: 'login_complete',
    })
    return session
  } finally {
    poller.close()
  }
}

/**
 * Build the `GET /login/start` URL the browser navigates to (LLP 0059 §the-
 * server-contract, as amended by LLP 0342 D3). `org` is an optional selector
 * only; the server resolves the real org. Deliberately no `redirect_uri`:
 * its absence selects poll delivery on the server.
 *
 * @param {{ identityBase: string, challenge: string, state: string, org?: string }} args
 * @returns {string}
 */
export function buildStartUrl({ identityBase, challenge, state, org }) {
  const url = new URL(`${trimSlash(identityBase)}/login/start`)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  if (org) url.searchParams.set('org', org)
  return url.toString()
}
