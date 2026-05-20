import type { CollectivusConfig } from '../types.js'

/** Standard claims this server emits and accepts on control-plane JWTs. */
export interface JwtClaims {
  /** Subject — the gateway identity this token represents. */
  sub: string
  /** Issued-at, seconds since the unix epoch. */
  iat: number
  /** Expiration, seconds since the unix epoch. */
  exp: number
}

/** Result of `verifyJwt`. */
export type JwtVerifyResult =
  | { valid: true, claims: JwtClaims }
  | { valid: false, error: 'malformed' | 'bad_signature' | 'expired' | 'iat_in_future' }

/** A persisted bootstrap-token record. The plaintext token is never stored. */
export interface BootstrapRecord {
  /** sha256 hex of the plaintext bootstrap token. */
  tokenHash: string
  /** Gateway identity this token will mint a JWT for. */
  gatewayId: string
  /** Expiration, seconds since the unix epoch. */
  expiresAt: number
  /** Whether the token has already been redeemed. */
  used: boolean
}

/** Result of `issueFromBootstrap`. */
export type IssueFromBootstrapResult =
  | { ok: true, jwt: string, expiresAt: number, gatewayId: string }
  | { ok: false, reason: 'unknown_token' | 'already_used' | 'expired' }

/** Result of looking up a bootstrap token without consuming it. */
export type BootstrapTokenInspection =
  | { ok: true, gatewayId: string, expiresAt: number }
  | { ok: false, reason: 'unknown_token' | 'already_used' | 'expired' }

/** A per-gateway config entry held by the server-side registry. */
export interface ConfigRegistryEntry {
  /** The gateway-shaped CollectivusConfig persisted for this gateway. */
  config: CollectivusConfig
  /** SHA-256 hex of the canonical JSON serialization of `config`. */
  etag: string
}

/** Serializable data needed by the file-backed config registry helpers. */
export interface ConfigRegistry {
  /** Directory containing one `<gateway_id>.json` file per gateway. */
  configsDir: string
}

/** Signal kinds accepted on `POST /v1/ingest/:signal`. */
export type IngestSignal = 'logs' | 'traces' | 'metrics' | 'proxy'

/** Response body shape for the ingest endpoint. */
export interface IngestResponse {
  /** Number of rows successfully persisted. */
  accepted: number
  /**
   * 1-indexed line number where parsing failed. Present only on the partial-
   * success / malformed-batch path (HTTP 400).
   */
  rejected_at_line?: number
  /** Human-readable reason for the rejection. Present only on HTTP 400. */
  error?: string
}

export interface HighWaterThrottleEvent {
  kind: 'high_water'
  gatewayId: string
  signal: string
  pendingRows: number
  highWaterRows: number
}

export interface CapacityThrottleEvent {
  kind: 'capacity'
  gatewayId: string
  signal: string
  pendingRows: number
  maxPendingRows: number
}

export interface ByteRateThrottleEvent {
  kind: 'byte_rate'
  gatewayId: string
  signal: string
  batchBytes: number
  maxBytesPerSecond: number
}

export type ThrottleEvent = HighWaterThrottleEvent | CapacityThrottleEvent | ByteRateThrottleEvent
