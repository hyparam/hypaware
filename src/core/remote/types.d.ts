/**
 * Shared types for the remote OIDC client (LLP 0046-0048). Imported via
 * `@import` from the sibling `.js` modules using a repo-root-anchored `.js`
 * specifier so the published declaration build resolves them identically.
 */

import type { PersistedIdentity } from '../../../hypaware-core/plugins-workspace/central/src/types.js'

/**
 * One central forward sink seeded from a login-minted gateway credential
 * (LLP 0061 D5). `replaced` is the persisted identity the seed displaced,
 * when there was one, so the login command can report the replacement
 * rather than clobbering silently (LLP 0061 D4).
 */
export interface SeededGateway {
  /** Sink instance name in the effective config. */
  sink: string
  /** The persisted identity file the seed was written to. */
  persistedPath: string
  /** The sink's configured central URL, stamped into the seed. */
  centralUrl: string
  replaced?: PersistedIdentity
}

/**
 * The login-minted gateway credential (LLP 0061 D1): a server that
 * provisions a gateway on login returns it alongside the human session on
 * the same `authorization_code` response. It is forward-scoped (the
 * `central` sink's identity), never part of the query credential record.
 */
export interface LoginGatewayCredential {
  jwt: string
  /**
   * Unix epoch second when the gateway JWT expires. Kept as an epoch (not
   * ISO like `OidcSession.expiresAt`) because it seeds the central sink's
   * persisted `identity.json`, whose `expires_at` is an epoch second.
   */
  expiresAt: number
  gatewayId: string
}

/**
 * A full OIDC session, the result of the `authorization_code` grant. The
 * refresh token is long-lived and revocable; the access JWT is short-lived
 * and re-minted by the refresh grant.
 */
export interface OidcSession {
  refreshToken: string
  accessJwt: string
  /** ISO-8601 expiry of `accessJwt`. */
  expiresAt: string
  /** The org hypaware-server resolved for this session. */
  org: string
  /**
   * The login-minted gateway credential, when the server provisions one
   * (LLP 0061 D1). Absent against a server without login-gateway support.
   * Routed to the forward store by the login command; never written into
   * the query-scoped `oidc` record.
   */
  gateway?: LoginGatewayCredential
}

/** The result of the `refresh_token` grant: a fresh access JWT only. */
export interface RefreshedAccess {
  accessJwt: string
  /** ISO-8601 expiry of `accessJwt`. */
  expiresAt: string
  org: string
  /**
   * A rotated refresh token, when the server issues one-time-use refresh
   * tokens. Empty when the server keeps the refresh token stable, in which
   * case the caller retains the one it already stored.
   */
  refreshToken: string
}

/**
 * A legacy / static credential record: a bare query-scoped token (LLP 0033).
 * On read, a record with a `token` and no `kind` is normalized to this.
 */
export interface RemoteStaticRecord {
  kind: 'static'
  token: string
}

/**
 * An OIDC session record (LLP 0046 D4): the revocable refresh token plus the
 * cached short-lived access JWT, its expiry, and the resolved org.
 */
export interface RemoteOidcRecord {
  kind: 'oidc'
  refreshToken: string
  accessJwt: string
  /** ISO-8601 expiry of `accessJwt`. */
  expiresAt: string
  org: string
}

/**
 * One per-target record in `remote-credentials.json`, discriminated by
 * `kind`. Both kinds live in the same file, share one resolve path, and are
 * dropped by the same `removeToken`.
 */
export type RemoteCredentialRecord = RemoteStaticRecord | RemoteOidcRecord
