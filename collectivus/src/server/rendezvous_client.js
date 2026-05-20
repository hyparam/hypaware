import { stripTrailingSlashes } from './util.js'

/**
 * Register an enterprise-enrollment invite with a shared rendezvous service so
 * a short join code can be resolved back to this Central server. Mirrors the
 * wire format used by `POST /v1/rendezvous/invites` in `src/rendezvous/service.js`.
 *
 * The function never logs or returns the registration token. The token is
 * redacted from any error message produced from a failed HTTP response so
 * upstream callers can surface the network failure without leaking the bearer.
 *
 * @param {{
 *   fetchFn: typeof fetch,
 *   rendezvousUrl: string,
 *   registrationToken: string,
 *   joinCodeHash: string,
 *   connectUrl: string,
 *   gatewayId: string,
 *   expiresAt: string,
 *   maxUses: number,
 *   displayName?: string,
 * }} args
 * @returns {Promise<void>}
 */
export async function registerRendezvousInvite(args) {
  const base = stripTrailingSlashes(args.rendezvousUrl)
  /** @type {Record<string, string | number>} */
  const body = {
    kind: 'enterprise_enrollment',
    join_code_hash: args.joinCodeHash,
    connect_url: args.connectUrl,
    gateway_id: args.gatewayId,
    expires_at: args.expiresAt,
    max_uses: args.maxUses,
  }
  if (args.displayName !== undefined) body.display_name = args.displayName

  /** @type {Response} */
  let response
  try {
    response = await args.fetchFn(`${base}/v1/rendezvous/invites`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.registrationToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to reach rendezvous: ${redactToken(msg, args.registrationToken)}`)
  }
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(redactToken(detail, args.registrationToken))
  }
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readErrorDetail(response) {
  /** @type {unknown} */
  let parsed
  try {
    parsed = await response.json()
  } catch {
    return `HTTP ${response.status} ${response.statusText}`
  }
  if (
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    'error' in parsed && typeof parsed.error === 'string'
  ) {
    return `${parsed.error} (HTTP ${response.status})`
  }
  return `HTTP ${response.status} ${response.statusText}`
}

/**
 * Replace every occurrence of the registration token in a string with a
 * fixed `<redacted>` placeholder so callers can include arbitrary upstream
 * error text in their own messages without risking a credential leak.
 *
 * @param {string} message
 * @param {string} token
 * @returns {string}
 */
function redactToken(message, token) {
  if (token.length === 0) return message
  return message.split(token).join('<redacted>')
}
