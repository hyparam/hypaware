/**
 * Shared types for the remote OIDC client (LLP 0046-0048). Imported via
 * `@import` from the sibling `.js` modules using a repo-root-anchored `.js`
 * specifier so the published declaration build resolves them identically.
 */

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
