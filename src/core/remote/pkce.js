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
 * @ref LLP 0058#d3 [implements]: client owns the downstream PKCE leg; verifier + S256 challenge, in-memory for one flow
 */
export function createPkcePair() {
  // `base64url` is unpadded base64url (RFC 7636 §A) natively, no replace chain.
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest().toString('base64url')
  return { verifier, challenge }
}
