// @ts-check

import crypto from 'node:crypto'

/**
 * PKCE (RFC 7636) for the client's **downstream** OAuth leg: `hyp` is the
 * OAuth app talking to hypaware-server. The client generates a verifier and
 * an S256 challenge, sends the challenge to `/login/start`, and holds the
 * verifier to present at `/token`. The upstream leg (hypaware-server to the
 * IdP) is server-internal and the client never sees it.
 *
 * Pure and synchronous over stdlib `crypto`; no I/O, no persistence. The
 * verifier lives in memory for one flow and is never logged.
 */

/**
 * Generate a one-flow PKCE pair. The verifier is 32 random bytes base64url
 * encoded; the challenge is the base64url SHA-256 of the verifier ASCII.
 *
 * @returns {{ verifier: string, challenge: string }}
 * @ref LLP 0046#d3 [implements]: client owns the downstream PKCE leg; verifier + S256 challenge, in-memory for one flow
 */
export function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * Base64url with no padding (RFC 7636 §A).
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
