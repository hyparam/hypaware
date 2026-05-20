// Wire types for `@hypaware/central` ⇄ `@hypaware/server`. The server
// package (post-V1 Phase 10, separate repo) will import from this same
// file; updates here must keep both ends in sync.
//
// See `../proto.md` for the HTTP-level contract.

/** Signal name as it appears on `/v1/ingest/{signal}`. */
export type IngestSignal = 'logs' | 'traces' | 'metrics' | 'proxy'

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
   * Override the etag sidecar path used by the config-pull loop. Defaults
   * to `<plugin.stateDir>/config-etag.json`. The loop itself is opt-in.
   */
  config_etag_path?: string
  /** Poll cadence (seconds) for the config-pull loop. Default 30s. */
  poll_interval_seconds?: number
}

/** Payload of the `config-changed` event emitted by `ConfigClient`. */
export interface ConfigChangedEvent {
  newConfig: unknown
  etag: string
  fetchedAt: string
}
