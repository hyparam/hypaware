// Wire types for `@hypaware/central` ⇄ `@hypaware/server`. The server
// package (post-V1 Phase 10, separate repo) will import from this same
// file; updates here must keep both ends in sync.
//
// See `../proto.md` for the HTTP-level contract.

/** Signal name as it appears on `/v1/ingest/{signal}`. */
export type IngestSignal = 'logs' | 'traces' | 'metrics' | 'proxy'

export type AcquireSource = 'loaded' | 'refreshed' | 'bootstrapped'

/** Body of a successful bootstrap or refresh response. */
export interface IdentityResponse {
  jwt: string
  /** Unix epoch second when the JWT expires. */
  expires_at: number
}

/** Persisted gateway identity on disk (`identity.json`, mode 0600). */
export interface PersistedIdentity {
  jwt: string
  expires_at: number
  gateway_id: string
  /**
   * Central base URL that minted this identity. Set since the
   * re-enrollment guard landed; absent on identities written by older
   * builds (treated as a mint mismatch when a bootstrap token is set).
   */
  central_url?: string
  /**
   * SHA-256 fingerprint of the bootstrap token that minted this
   * identity (never the raw token). Lets `acquire()` detect a re-join
   * that swapped the token and re-bootstrap instead of reusing a stale
   * gateway identity against a new tenant/server.
   */
  bootstrap_token_fp?: string
  /**
   * Present when this identity was seeded by `hyp remote login` (a
   * login-minted gateway, LLP 0061 D3) rather than a bootstrap-token
   * mint. No bootstrap token was involved, so the re-enrollment guard
   * must not read the missing `bootstrap_token_fp` as a mint mismatch;
   * only a `central_url` change counts. Absent on bootstrap-minted
   * identities.
   */
  origin?: 'login'
}

/** Request body for `POST /v1/identity/bootstrap`. */
export interface IdentityBootstrapRequest {
  bootstrap_token: string
}

/**
 * Per-instance config the gateway accepts under
 * `HypAwareV2Config.sinks.<name>.config`. Validated by `central/src/config.js`.
 */
export interface CentralSinkConfig {
  /** Standard 5-field cron expression. Default `0 * * * *`. */
  schedule?: string
  /** Base URL of the central server. Required. */
  url: string
  /**
   * Identity (JWT) configuration. `bootstrap_token` is required on the
   * first run; subsequent runs re-use the persisted JWT.
   */
  identity: {
    bootstrap_token?: string
    /** Absolute path to the persisted identity file. Defaults to `<plugin.stateDir>/identity.json`. */
    persisted_path?: string
  }
  /**
   * Poll cadence (seconds) for the config-pull loop. Default 300s
   * (5 minutes) — 304s are cheap, and propagation latency equals this
   * cadence (no push channel in V1). The running config's etag is
   * kernel-managed (LLP 0025); the plugin reads it through the
   * `configControl` facade, so there is no plugin-side sidecar path.
   */
  poll_interval_seconds?: number
}

