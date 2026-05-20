import type { CollectivusConfig } from '../types.js'
import type { IngestSignal } from '../server/types.d.ts'

/**
 * Gateway-side persisted identity. Written by `IdentityClient` after a
 * successful `bootstrap` or `refresh`, read on subsequent gateway start so
 * the JWT survives process restarts.
 */
export interface PersistedIdentity {
  /** The control-plane JWT this gateway uses for every authenticated call. */
  jwt: string
  /** Expiration of `jwt`, seconds since the unix epoch. */
  expires_at: number
  /** Gateway identity claim (`sub`) recovered from the JWT at issue time. */
  gateway_id: string
}

/**
 * Result of `IdentityClient.acquire` — captures whichever path actually ran so
 * the CLI can log a single deterministic line and tests can assert on it.
 */
export type AcquireSource = 'bootstrapped' | 'loaded' | 'refreshed'

/**
 * Subset of `IdentityClient` that `ShippingSink` actually needs. Declared
 * structurally so tests can supply a small fake without re-implementing the
 * full identity lifecycle, mirroring the `IdentitySource` pattern used by
 * `ConfigClient`.
 */
export interface ShippingSinkIdentitySource {
  /** Resolve to the current bearer JWT, refreshing in-place if near expiry. */
  getCurrentJwt(): Promise<string>
  /** Force a refresh against the central server. */
  refresh(): Promise<void>
}

/** Per-signal flush thresholds for `ShippingSink`. */
export interface ShippingSinkBatchOptions {
  /** Maximum rows per batch before a flush. Default 1000. */
  maxRows?: number
  /** Maximum bytes per batch (NDJSON, including newlines) before a flush. Default 1048576 (1 MB). */
  maxBytes?: number
  /** Maximum seconds the oldest row may sit in a batch before a flush. Default 5. */
  maxSeconds?: number
}

/** Construction options for `ShippingSink`. */
export interface ShippingSinkOptions {
  /** Base URL of the central control-plane server (same as `central_server.url`). */
  centralUrl: string
  /** Identity source providing JWTs and refresh — typically the gateway's `IdentityClient`. */
  identityClient: ShippingSinkIdentitySource
  /**
   * Signal label embedded in the ingest URL (`/v1/ingest/<signal>`). Default
   * `proxy`, matching the only existing `Sink` consumer (the recorder). Future
   * multi-signal variants will override per-instance or route per-row.
   */
  signal?: IngestSignal
  /** Batching thresholds. Defaults match the bead spec (1000 / 1 MB / 5 s). */
  batch?: ShippingSinkBatchOptions
}

/** Construction options for the durable gateway outbox sink. */
export interface OutboxSinkOptions {
  /** Directory where per-signal outbox files are spooled. */
  outboxDir: string
  /** Base URL of the central control-plane server (same as `central_server.url`). */
  centralUrl: string
  /** Identity source providing JWTs and refresh — typically the gateway's `IdentityClient`. */
  identityClient: ShippingSinkIdentitySource
  /** Signal label embedded in the ingest URL (`/v1/ingest/<signal>`). */
  signal: IngestSignal
  /** Rotation thresholds. Defaults match the bead spec (1000 / 1 MB / 5 s). */
  batch?: ShippingSinkBatchOptions
}

/**
 * Emitted by `ConfigClient` whenever a `GET /v1/config` returns 200 with a
 * config that passes gateway-side validation. B.4's hot-reload code subscribes
 * to this and diffs `newConfig` against the running config.
 */
export interface ConfigChangedEvent {
  /** The newly fetched config — already validated. */
  newConfig: CollectivusConfig
  /** SHA-256 hex of the canonical JSON serialization of `newConfig`. */
  etag: string
  /** ISO-8601 timestamp of the moment the gateway accepted the config. */
  fetchedAt: string
}

/**
 * Subset of `IdentityClient` that `ConfigClient` actually needs. Declared
 * structurally so tests can supply a small fake without re-implementing the
 * full identity lifecycle, and so future identity sources can drop in without
 * inheriting from a class.
 */
export interface IdentitySource {
  persistedPath: string
  getCurrentJwt(): Promise<string>
  refresh(): Promise<void>
}

export interface ConfigClientChangeListener extends ConfigChangedEvent {}

/**
 * Sections compared by `diffConfig`. The first three (`otel`, `proxy`, `sink`)
 * cover the listener footprint a gateway can hot-reload; `upload` covers the
 * scheduler.
 */
export type SectionStatus = 'unchanged' | 'changed' | 'added' | 'removed'

export interface ConfigDiff {
  otel: SectionStatus
  proxy: SectionStatus
  sink: SectionStatus
  upload: SectionStatus
}

/**
 * Section names whose listeners actually run in the registry. `sink` is
 * intentionally absent because the sink is owned by its consumers.
 */
export type ReloadableListener = 'otel' | 'proxy' | 'upload'
