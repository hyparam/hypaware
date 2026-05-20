export interface DataReader {
  view: DataView
  offset: number
}

// ---------- SSE ----------

export interface SseEvent {
  /** Event type (defaults to 'message' when no `event:` field is present). */
  event: string
  /** Event data; multiple `data:` lines are joined with `\n`. */
  data: string
  /** SSE `id:` value when present; used for `Last-Event-ID` resume. */
  id?: string
}

// ---------- Recorder / proxy exchange ----------

export interface ClientInfo {
  /** Client remote address as observed by the proxy. */
  ip: string | undefined
  /** Client User-Agent header value. */
  user_agent: string | undefined
}

export interface ExchangeRequest {
  /** HTTP method (e.g. 'POST'). */
  method: string | undefined
  /** Path + query as received. */
  path: string | undefined
  /** Headers post-redaction. */
  headers: Record<string, string | string[] | undefined>
  /** Request body as received (utf-8). Empty string for requests with no body. */
  body: string
}

export interface ExchangeResponse {
  /** HTTP status from upstream. */
  status: number | undefined
  /** Response headers post-redaction. */
  headers: Record<string, string | string[] | undefined>
  /** Response body for non-streaming responses; `undefined` for SSE (events recorded separately). */
  body: string | undefined
}

export interface ClaudeSessionContext {
  /** Claude Code working directory captured locally by the attach hook. */
  cwd?: string
  /** Git branch captured locally by the attach hook. */
  git_branch?: string
}

// ---------- Ignore filter (recording opt-out) ----------

/**
 * On-disk shape of the user-persistent ignore state living alongside the rest
 * of `~/.hyp/collectivus.json`. Schema is intentionally open — the file is
 * shared with the proxy config and may grow new top-level keys.
 */
export interface CollectivusIgnoreConfig {
  /** Normalized absolute paths whose Claude requests must not be recorded. */
  ignored_paths: string[]
  /**
   * Snapshot of the in-memory temporary session set. Returned by
   * `IgnoreFilter.snapshot()` for status output; never persisted to disk.
   */
  ignored_sessions?: string[]
}

/** Reason the filter dropped a row, alongside the matching key. */
export type IgnoreEvaluation =
  | { drop: false }
  | { drop: true, reason: 'session', match: string }
  | { drop: true, reason: 'path', match: string }
  | { drop: true, reason: 'ctvsignore', match: string }

/**
 * Closure handed to {@link Recorder.startExchange} so each Exchange can ask
 * whether it should suppress its JSONL writes. The proxy wires this to an
 * {@link import('./ignore.js').IgnoreFilter} instance, providing the
 * session-id extraction logic since the recorder is provider-agnostic.
 */
export type ShouldDropPredicate = (input: {
  requestHeaders: Record<string, string | string[] | undefined>
  requestBody: string
}) => boolean

// ---------- File sink ----------

export interface Sink {
  /** Append a row to the sink. */
  writeRow(obj: unknown): Promise<void>
  /** Flush, fsync, and release resources. */
  close(): Promise<void>
}

// ---------- Proxy ----------

export interface CompiledUpstream {
  /** Upstream key from config. */
  name: string
  /** Parsed base URL. */
  baseUrl: URL
  /** Path prefix used for routing. */
  prefix: string
}

// ---------- Config ----------

export interface OtelConfig {
  /** host:port for the OTLP receiver (e.g. '0.0.0.0:4318'). */
  listen: string
}

export interface UpstreamMatch {
  /** Request path prefix that selects this upstream. */
  path_prefix: string
}

export interface UpstreamConfig {
  /** Identifier used in logs and recorded exchange rows. Unique within the proxy. */
  name: string
  /** Origin to forward matched requests to. */
  base_url: string
  /** Match rule for routing requests to this upstream. */
  match: UpstreamMatch
}

export interface ProxyConfig {
  /** host:port the proxy listens on. */
  listen: string
  /** Upstream targets in declaration order; first matching prefix wins. */
  upstreams: UpstreamConfig[]
  /** Header names to redact in recorded traffic. */
  redact_headers?: string[]
}

export interface FileSinkConfig {
  /** Sink kind. Only 'file' is supported in v0. */
  type: 'file'
  /** Directory where recordings are written. */
  dir: string
}

export type UploadSignal = 'logs' | 'traces' | 'metrics' | 'proxy'

export interface UploadConfig {
  /** Destination bucket. Required. */
  bucket: string
  /** Object-key prefix. Default 'collectivus'. */
  prefix?: string
  /** Region for the destination bucket. Default ''. */
  region?: string
  /** Daily fire time as HH:MM (24-hour, local). Default '00:10'. */
  time?: string
  /** Subset of signals to upload. Default ['logs', 'traces', 'metrics', 'proxy']. */
  signals?: UploadSignal[]
  /** Days of past data to backfill on startup. Default 30. */
  catchupDays?: number
  /** Override base URL for S3-compatible servers (MinIO, etc.). */
  endpoint?: string
}

export interface QueryCacheConfig {
  /** Enable the local Iceberg-backed query cache. Default true. */
  enabled?: boolean
  /** Cache directory. Default `<recording-root>/.collectivus-query/cache`. */
  dir?: string
}

export interface QueryConfig {
  /** Local query-cache materialization settings. */
  cache?: QueryCacheConfig
}

/**
 * Operating mode for this collectivus instance. `standalone` (default when
 * `role` is absent) preserves single-binary behavior. `server` and `gateway`
 * activate the central-server / local-gateway split introduced by Epic A.
 */
export type CollectivusRole = 'server' | 'gateway' | 'standalone'

export interface IdentityIssuerConfig {
  /** HMAC secret used to sign control-plane JWTs. Must be ≥32 chars. */
  secret?: string
  /** Environment variable containing the HMAC secret at runtime. */
  secret_env?: string
  /** TTL applied to issued gateway JWTs. */
  jwt_ttl_seconds?: number
  /** TTL applied to operator-provisioned bootstrap tokens. */
  bootstrap_ttl_seconds?: number
  /**
   * Filesystem path to the bootstrap-token store. Required when the server
   * should accept `POST /v1/identity/bootstrap` — when omitted, the bootstrap
   * endpoint returns 503 (refresh and ordinary auth still work).
   */
  bootstrap_store_path?: string
}

export interface ServerConfig {
  /** host:port for the control-plane HTTP listener (separate from OTLP/proxy). */
  control_plane_listen: string
  /**
   * Gateway-facing base URL for this control plane. Used to build one-line
   * enrollment commands and bootstrap configs. When omitted, the server
   * derives a best-effort URL from the incoming request host. Required when
   * `admin` is configured — admin invite responses bake `public_url` into
   * the join command.
   */
  public_url?: string
  /** JWT issuer settings for the control-plane. */
  identity_issuer: IdentityIssuerConfig
  /**
   * Filesystem root for server-side state (per-gateway config registry,
   * future log-ingest spool, etc). Defaults to `~/.hyp/collectivus/server-data`
   * when omitted.
   */
  data_dir?: string
  /**
   * Filesystem root where the ingest endpoint persists shipped rows. Files
   * live at `<sink_dir>/<gateway_id>/<signal>/<YYYY-MM-DD>.jsonl`. Distinct
   * from server `data_dir` (which holds configs / bootstrap tokens). Default:
   * `~/.hyp/collectivus/server-data/ingested`.
   */
  sink_dir?: string
  /** Backpressure / disk I/O throttle settings for the ingest endpoint. */
  ingest?: IngestThrottleConfig
  /** Operator-facing admin API authentication. Enables `POST /v1/admin/invites`. */
  admin?: AdminConfig
  /** Enrollment defaults applied to invites issued through the admin API. */
  enrollment?: EnrollmentConfig
  /** Shared rendezvous backend the admin API uses to register short codes. */
  rendezvous?: ServerRendezvousConfig
}

/**
 * Operator-facing admin API authentication. Exactly one of `token` or
 * `token_env` must be set; the resolved value must be at least 32 bytes.
 */
export interface AdminConfig {
  /** Inline admin token, ≥32 chars. */
  token?: string
  /** Environment variable that holds the admin token at runtime. */
  token_env?: string
}

/**
 * Enrollment defaults applied when the admin API mints invites. Optional —
 * when omitted, invites are issued without a gateway-id namespace prefix.
 */
export interface EnrollmentConfig {
  /**
   * Optional namespace prefix prepended to gateway IDs minted from this
   * server. Validated against the same character class that the ingest
   * endpoint enforces on `claims.sub`.
   */
  gateway_prefix?: string
}

/**
 * Shared rendezvous backend the admin API contacts to register invite codes.
 * Exactly one of `url` / `url_env` and one of `registration_token` /
 * `registration_token_env` must be set.
 */
export interface ServerRendezvousConfig {
  /** Inline base URL for the rendezvous service (http or https). */
  url?: string
  /** Environment variable that holds the rendezvous URL at runtime. */
  url_env?: string
  /** Inline registration token used to authenticate to the rendezvous service. */
  registration_token?: string
  /** Environment variable that holds the rendezvous registration token at runtime. */
  registration_token_env?: string
}

/**
 * Server-side ingest throttle settings. All fields are optional and fall back
 * to defaults that match the spec in epic C.2: 50000 pending rows, 80%
 * high-water mark, 5s `Retry-After`, no disk-rate ceiling.
 */
export interface IngestThrottleConfig {
  /**
   * Maximum rows queued for fsync before the endpoint starts emitting
   * backpressure. A request that arrives while the queue is at or past this
   * value is rejected with 503. Default 50000.
   */
  max_pending_rows?: number
  /**
   * Percentage of `max_pending_rows` at which the endpoint starts emitting
   * 429 with `Retry-After`. Must be 1..100. Default 80.
   */
  high_water_pct?: number
  /**
   * Value emitted in the `Retry-After` response header when backpressure
   * triggers. Must be a positive integer (whole seconds). Default 5.
   */
  retry_after_seconds?: number
  /**
   * Per-process disk-write ceiling, in bytes per second. Implemented as a
   * 1-second token bucket: bursts up to `max_bytes_per_second` are allowed,
   * sustained throughput is capped at the same value. Omit (the default) to
   * disable disk-rate throttling entirely.
   */
  max_bytes_per_second?: number
}

export interface CentralServerIdentityConfig {
  /** Operator-provisioned bootstrap token, exchanged on first start. */
  bootstrap_token?: string
  /** Filesystem path where the long-lived JWT is persisted. */
  persisted_path?: string
}

export interface CentralServerConfig {
  /** Base URL of the central control-plane server. */
  url: string
  /** Identity material used by the gateway to authenticate. */
  identity: CentralServerIdentityConfig
  /**
   * Durable local delivery spool used by Gateway mode before rows are accepted
   * by Central server. Defaults to `<dirname(identity.json)>/outbox`.
   */
  outbox_dir?: string
  /**
   * Background config-pull interval in seconds. Default 30. Validator
   * constrains to [5, 3600]: the floor is the minimum useful resolution for
   * "hot reload" semantics; the ceiling keeps a misconfigured gateway from
   * drifting hours behind a config change.
   */
  poll_interval_seconds?: number
}

export interface CollectivusConfig {
  /** Schema version. Always 1 in this binary. */
  version: 1
  /** Operating mode. Defaults to `standalone` when omitted. */
  role?: CollectivusRole
  /**
   * Tenant identifier used as the first directory level under `sink.dir`.
   * Standalone defaults to the OS username (sanitized through
   * `GATEWAY_ID_PATTERN`); gateway and server modes derive it from the JWT
   * claim and reject this field. Validated against the same pattern that
   * the server's ingest endpoint enforces on `claims.sub`.
   */
  gateway_id?: string
  /** OTLP receiver. Omit to disable. */
  otel?: OtelConfig
  /** Proxy listener. Omit to disable. */
  proxy?: ProxyConfig
  /**
   * Sink for local file recordings. Required when `otel` or `proxy` is set in
   * Standalone mode. Accepted but unused by Gateway mode, which writes to the
   * durable central-server outbox instead.
   */
  sink?: FileSinkConfig
  /** Reserved upload section. Schema-validated only; uploader wires up later. */
  upload?: UploadConfig
  /** Optional local query-cache settings. */
  query?: QueryConfig
  /** Server-mode (control-plane) settings. Required iff `role === 'server'`. */
  server?: ServerConfig
  /** Gateway-mode central-server settings. Required iff `role === 'gateway'`. */
  central_server?: CentralServerConfig
  /**
   * Gascity supervisor capture cities. Each entry attaches the daemon to one
   * supervisor and produces rows in `gascity_messages`. Empty array is
   * permitted (the source is wired but captures nothing).
   */
  gascity?: import('./gascity/types.d.ts').GascityCityConfig[]
}

// ---------- Collector / OTLP normalization ----------

export type NormalizedLogRow = Record<string, unknown> & {
  serviceName: string
  timestamp?: string
  observedTimestamp?: string
  severityNumber?: number
  severityText?: string
  body: unknown
  traceId?: string
  spanId?: string
  flags?: number
  droppedAttributesCount?: number
  resource: Record<string, unknown>
  scope: {
    name?: string
    version?: string
    attributes: Record<string, unknown>
  }
  attributes: Record<string, unknown>
}

export type NormalizedServiceRow = Record<string, unknown> & { serviceName: string }

export interface MetricRowBase {
  serviceName: string
  metricName?: string
  description?: string
  unit?: string
  resource: Record<string, unknown>
  scope: {
    name?: string
    version?: string
    attributes: Record<string, unknown>
  }
  metadata: Record<string, unknown>
}

export interface StartedListener {
  description: string
  stop(): Promise<void>
}

export type ListenerFactory = () => Promise<StartedListener>

// ---------- Claude Code settings ----------

export interface CollectivusMarker {
  attached_at?: string
  version?: string
  port?: number
}

export interface AttachOptions {
  /** TCP port (1..65535) the local proxy listens on. */
  port: number
  /** Non-empty version string recorded in the marker. */
  version: string
  /** CLI path used by managed Claude Code hooks. Default `ctvs`. */
  binPath?: string
  /** Override the settings.json path (default: `~/.claude/settings.json`). */
  settingsPath?: string
}

export interface AttachResult {
  /** Always true; attach always (re)writes the marker. */
  changed: true
  /** Previous value of `env.ANTHROPIC_BASE_URL`, if any. */
  prevValue?: string
}

export interface DetachOptions {
  /** Override the settings.json path (default: `~/.claude/settings.json`). */
  settingsPath?: string
}

export interface DetachResult {
  /** True if the file was modified, false when no marker was present. */
  changed: boolean
  /** The `ANTHROPIC_BASE_URL` value that was removed when it matched the marker port. */
  removed?: string
  /** Set when `ANTHROPIC_BASE_URL` was overridden externally and was left in place. */
  warning?: string
}

export interface IsAttachedOptions {
  /** Override the settings.json path (default: `~/.claude/settings.json`). */
  settingsPath?: string
}

export interface ReadSettingsResult {
  /** Parsed object (mutable). */
  value: Record<string, unknown>
  /** Whether the file was on disk. */
  existed: boolean
  /** mtime captured at read time (undefined when the file did not exist). */
  mtimeMs: number | undefined
}

// ---------- Codex settings ----------

export interface CodexAttachOptions {
  /** TCP port (1..65535) the local proxy listens on. */
  port: number
  /** Non-empty version string recorded in managed comments. */
  version: string
  /** Override the config.toml path (default: `~/.codex/config.toml`). */
  configPath?: string
}

export interface CodexAttachResult {
  /** Always true; attach always (re)writes the managed config. */
  changed: true
  /** Previous root `model_provider`, if one existed before collectivus attached. */
  prevValue?: string
}

export interface CodexDetachOptions {
  /** Override the config.toml path (default: `~/.codex/config.toml`). */
  configPath?: string
}

export interface CodexDetachResult {
  /** True if the file was modified, false when no managed block was present. */
  changed: boolean
  /** The managed provider base_url that was removed. */
  removed?: string
  /** Previous root `model_provider` restored from the managed marker, if any. */
  restoredValue?: string
  /** Set when a user-edited root model_provider was left in place. */
  warning?: string
}

export interface CodexIsAttachedOptions {
  /** Override the config.toml path (default: `~/.codex/config.toml`). */
  configPath?: string
}

export type TomlMultilineStringDelimiter = '"""' | "'''"

// ---------- Upload scheduler ----------

export interface TickResult {
  /** Schedule a fast retry instead of waiting until the next daily fire. */
  retry?: boolean
}

export interface SchedulerDeps {
  /** For tests. */
  now?: () => Date
  setTimeoutFn?: (handler: () => void, ms: number) => NodeJS.Timeout | number
  clearTimeoutFn?: (handle: NodeJS.Timeout | number) => void
}
