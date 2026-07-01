// @ts-check

import crypto from 'node:crypto'

import { Attr, getLogger } from '../observability/index.js'
import { exchangeCode, trimSlash } from './identity_client.js'
import { startLoopbackReceiver } from './loopback.js'
import { openBrowser as defaultOpenBrowser } from './open_browser.js'
import { createPkcePair } from './pkce.js'

/**
 * Orchestrate the browser authorization-code flow (LLP 0058 D2/D3): generate
 * a PKCE pair and a random CSRF `state`, start the ephemeral loopback
 * receiver, build the `/login/start` URL, open the browser (or print the URL),
 * await the loopback `code`, exchange it at `/token`, and return the session.
 * No persistence here: the caller stores the returned session.
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
 *   startReceiver?: typeof startLoopbackReceiver,
 *   timeoutMs?: number,
 *   print?: (line: string) => void,
 * }} args
 * @returns {Promise<OidcSession>}
 * @ref LLP 0058#d3 [implements]: client orchestrates the downstream PKCE leg; verifier held in memory, presented at /token
 */
export async function loginWithBrowser({
  identityBase,
  org,
  host,
  noBrowser = false,
  openBrowser = defaultOpenBrowser,
  fetchImpl,
  startReceiver = startLoopbackReceiver,
  timeoutMs,
  print = () => {},
}) {
  const log = getLogger('remote')
  const { verifier, challenge } = createPkcePair()
  const state = crypto.randomBytes(16).toString('hex')

  const receiver = await startReceiver({ state, timeoutMs })
  try {
    const startUrl = buildStartUrl({ identityBase, redirectUri: receiver.redirectUri, challenge, state, org })

    log.info('remote.login_start', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: 'remote.login',
      [Attr.STATUS]: 'ok',
      has_org: Boolean(org),
      smoke_step: 'login_start',
    })

    const opened = noBrowser ? false : openBrowser(startUrl)
    if (opened) {
      // The opener boolean is best-effort: a launcher that exists but fails (no
      // display on a headless box) still returns true. So phrase this as an
      // attempt, not a fact, and always print the URL as the real fallback.
      print(`Opening your browser to sign in. Waiting for the redirect...`)
      print(`If it did not open, visit:\n\n  ${startUrl}\n`)
    } else {
      print(`Open this URL in your browser to sign in:\n\n  ${startUrl}\n`)
    }
    log.info('remote.browser_open', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: 'remote.login',
      [Attr.STATUS]: opened ? 'ok' : 'skipped',
      opener_found: opened,
      smoke_step: 'browser_open',
    })

    const { code } = await receiver.waitForCode()
    const session = await exchangeCode({ identityBase, code, codeVerifier: verifier, host, fetchImpl })
    log.info('remote.login_complete', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: 'remote.login',
      [Attr.STATUS]: 'ok',
      smoke_step: 'login_complete',
    })
    return session
  } finally {
    receiver.close()
  }
}

/**
 * Build the `GET /login/start` URL the browser navigates to (LLP 0059 §the-
 * server-contract). `org` is an optional selector only; the server resolves
 * the real org.
 *
 * @param {{ identityBase: string, redirectUri: string, challenge: string, state: string, org?: string }} args
 * @returns {string}
 */
export function buildStartUrl({ identityBase, redirectUri, challenge, state, org }) {
  const url = new URL(`${trimSlash(identityBase)}/login/start`)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  if (org) url.searchParams.set('org', org)
  return url.toString()
}
