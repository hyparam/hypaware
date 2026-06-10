/**
 * Draft public interfaces for the HypAware plugin-kernel design.
 *
 * This file is a design artifact, not an implementation contract yet. It is
 * intentionally expressed as .d.ts because these shapes would become the
 * reusable public API exposed to bundled and external plugins.
 *
 * The companion design rationale lives in the LLP corpus under `llp/`; start at
 * [`llp/0000-hypaware.explainer.md`](./llp/0000-hypaware.explainer.md) and the
 * per-subsystem LLPs (e.g. plugin manifest LLP 0005, capabilities LLP 0006).
 * When the two disagree the LLPs win; this file is updated to follow.
 *
 * Filename is `collectivus-plugin-kernel-types.d.ts` only because the
 * project rename to HypAware is still pending; the contents already
 * track the HypAware design.
 */

import type { AsyncDataSource, ScanOptions, ScanResults } from 'squirreling'
import type { CachePartitioningDeclaration } from './src/core/cache/types.d.ts'

export type { AsyncDataSource, ScanOptions, ScanResults }

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}

export type PluginName = string
/**
 * Versioned capability identifier. Well-known capabilities at V1:
 * - `hypaware.ai-gateway` — local HTTP/SSE AI gateway, provided by
 *   `@hypaware/ai-gateway`. Consumed by client adapter plugins.
 * - `hypaware.blob-store` — object-store API (put/get/list/delete),
 *   provided by blob destination plugins (`@hypaware/local-fs`,
 *   `@hypaware/s3`). The capability VALUE is a `BlobStore`; consumers
 *   call its methods directly. Consumed by table-format plugins.
 * - `hypaware.encoder` — per-batch byte encoder, provided by writer
 *   plugins (`@hypaware/format-parquet`, `@hypaware/format-jsonl`).
 *   Consumed by table-format plugins and blob destinations.
 * - `hypaware.table-format` — directory layout + manifests on top of a
 *   blob store and encoder. Provided by `@hypaware/format-iceberg`.
 *   The capability VALUE is a `TableFormatProvider`.
 * - `hypaware.http-endpoint` — request destination capability, provided
 *   by request sinks (`@hypaware/central`, future `@hypaware/webhook`).
 *
 * Plugins are free to define new capability names; the kernel does not
 * gate registration on an enum.
 */
export type CapabilityName = string
export type SemverRange = string
export type SemverVersion = string

export type WriteStream = {
  write(chunk: string): unknown
}

export type PluginPermission =
  | 'read_config'
  | 'write_config'
  | 'read_home'
  | 'write_home'
  | 'read_state'
  | 'write_state'
  | 'network'
  | 'spawn_process'
  | 'read_claude_transcripts'
  | 'write_claude_settings'
  | 'write_codex_settings'
  | string

export type PluginRuntime = 'node'

// =============================================================================
// Errors
// =============================================================================

/**
 * Tagged error shape used across HypAware. Code that throws attaches
 * `hypErrorKind` to a plain `Error`; consumers (tests, log enrichers,
 * conflict detectors) read it back. Optional `code`, `status`,
 * `statusCode` mirror Node/HTTP idioms when the error originated from
 * a system or remote call.
 */
export interface HypError extends Error {
  hypErrorKind: string
  code?: string
  status?: number
  statusCode?: number
}

// =============================================================================
// Manifest and install metadata
// =============================================================================

export interface PluginManifest {
  schema_version: 1
  name: PluginName
  version: SemverVersion
  description?: string
  /** Semver range against the HypAware kernel's plugin API. */
  hypaware_api: SemverRange
  /** Execution model. V1 supports `node` only (in-process from `entrypoint`). */
  runtime: PluginRuntime
  /** Required Node engine (e.g. ">=20"). */
  node_engine?: SemverRange
  /** Path to the bundled JS entrypoint. */
  entrypoint: string
  requires?: PluginRequirements
  provides?: PluginProvides
  permissions?: PluginPermission[]
  contributes?: PluginContributionManifest
}

export interface PluginRequirements {
  /** Named plugins that must be installed and activated before this plugin. */
  plugins?: Record<PluginName, SemverRange>
  /** Versioned capabilities that must be provided by another plugin. */
  capabilities?: Record<CapabilityName, SemverRange>
}

export interface PluginProvides {
  /** Capabilities implemented by this plugin, keyed by capability name. */
  capabilities?: Record<CapabilityName, SemverVersion>
}

export interface PluginContributionManifest {
  client?: PluginClientManifest
  commands?: PluginCommandManifest[]
  config_sections?: PluginConfigSectionManifest[]
  sources?: PluginSourceManifest[]
  sinks?: PluginSinkManifest[]
  datasets?: PluginDatasetManifest[]
  skills?: PluginSkillManifest[]
  agents?: PluginAgentManifest[]
  init_presets?: PluginInitPresetManifest[]
}

export interface PluginClientManifest {
  name: string
  skill_dir: string
  /**
   * Per-client subagent directory relative to the user's home (e.g.
   * `.claude/agents`). Absent for clients without a subagent concept.
   */
  agent_dir?: string
  attach_probe?: PluginAttachProbeManifest
  required_upstreams?: string[]
}

export interface PluginAttachProbeManifest {
  format: 'json' | 'toml'
  settings_file: string
  marker_key?: string
  marker_header?: string
}

export interface PluginCommandManifest {
  name: string
  summary?: string
  usage?: string
}

export interface PluginConfigSectionManifest {
  section: string
  summary?: string
}

export interface PluginSourceManifest {
  name: string
  summary?: string
}

export interface PluginSinkManifest {
  name: string
  /**
   * Capability tags this sink supports. Renamed from the older
   * `capabilities` array to avoid clashing with the global capability
   * registry. Recognized at V1: `"queryable"`. More tags may land
   * without changing the shape.
   */
  supports: SinkSupportTag[]
  summary?: string
}

export type SinkSupportTag = 'queryable' | string

export interface PluginDatasetManifest {
  name: string
  summary?: string
  source?: string
}

export interface PluginSkillManifest {
  name: string
  clients: PluginSkillClient[]
  source_dir?: string
}

export interface PluginAgentManifest {
  name: string
  clients: PluginSkillClient[]
  source_file?: string
}

export interface PluginInitPresetManifest {
  name: string
  summary?: string
}

export type PluginSkillClient = 'claude' | 'codex' | 'all'

// =============================================================================
// Plugin discovery, install, and lock
// =============================================================================

/**
 * Short-name resolver kinds. The kernel tries first-party, then scoped
 * third-party, then unscoped third-party. All three resolve down to a
 * git source — the kernel fetches a prebuilt artifact from git and
 * never runs `npm install` on the user's machine. npm is a naming
 * authority (and metadata lookup for third-party), not an install
 * source.
 */
export type PluginSourceKind =
  | 'first-party'
  | 'scoped-third-party'
  | 'unscoped-third-party'
  | 'git'
  | 'local-dir'

export interface PluginSourceSpec {
  kind: PluginSourceKind
  raw: string
  /** Resolved plugin name (e.g. `@hypaware/ai-gateway`). */
  name?: PluginName
  /** Resolved git URL (e.g. `github:hyperparam/hypaware-ai-gateway`). */
  gitUrl?: string
  /** Optional git ref (tag, branch, sha) to install from. */
  ref?: string
  /** Local directory source for development installs. */
  path?: string
  /** Optional subdirectory inside a git source. Reserved; rejected until subdir support lands. */
  subdir?: string
}

export interface PluginLockFile {
  schema_version: 1
  plugins: Record<PluginName, PluginLockEntry>
}

export interface PluginLockEntry {
  name: PluginName
  version: SemverVersion
  source: PluginSourceSpec
  install_dir: string
  /** Hash of the installed artifact tree (directory content). */
  content_hash: string
  /** Hash of the installed manifest, for fast drift detection. */
  manifest_hash: string
  installed_at: string
  /** Resolved git commit the artifact was fetched from. */
  resolved_ref?: string
  update?: PluginUpdateState
}

export interface PluginUpdateState {
  checked_at: string
  latest_version?: SemverVersion
  latest_ref?: string
  available: boolean
  error?: string
}

// =============================================================================
// Runtime module and activation context
// =============================================================================

export interface PluginModule {
  activate(ctx: PluginActivationContext): void | Promise<void>
  deactivate?(ctx: PluginDeactivationContext): void | Promise<void>
}

export interface PluginActivationContext {
  plugin: ActivePlugin
  /** Current config slice for this plugin (already validated). */
  config: JsonObject
  env: NodeJS.ProcessEnv
  paths: PluginPaths
  log: PluginLogger
  permissions: PermissionContext
  capabilities: CapabilityRegistry
  commands: CommandRegistry
  configRegistry: ConfigRegistry
  sources: SourceRegistry
  sinks: SinkRegistry
  query: QueryRegistry
  /**
   * Intrinsic storage handle for the kernel-managed query cache.
   * Plugins reach the local Iceberg-backed cache through this — they
   * never construct paths or open files themselves. The kernel owns
   * `cacheDir`; plugins ask the storage for a `tablePath` and call
   * `appendRows` / `readRows`.
   */
  storage: QueryStorageService
  skills: SkillRegistry
  agents: AgentRegistry
  initPresets: InitPresetRegistry
  /**
   * Backfill provider registry (kernel-owned). Plugins register
   * `BackfillContribution`s during activation; `hyp backfill` selects
   * providers from this registry. The shape is intentionally narrow —
   * provider authors keep dataset-specific behavior in their `run`
   * implementation rather than expanding the kernel surface.
   */
  backfills: BackfillRegistry
  /**
   * Dataset materializer registry (kernel-owned). Dataset/schema owners
   * register a materializer per `kind` they can convert into canonical
   * rows for a target dataset. The `hyp backfill` runner asks this
   * registry to materialize each `BackfillItem` yielded by a provider
   * before appending to the cache.
   */
  backfillMaterializers: BackfillMaterializerRegistry
  requireCapability<T = unknown>(name: CapabilityName, range?: SemverRange): T
  provideCapability<T = unknown>(name: CapabilityName, version: SemverVersion, value: T): void
}

export interface PluginDeactivationContext {
  plugin: ActivePlugin
  log: PluginLogger
}

export interface ActivePlugin {
  name: PluginName
  version: SemverVersion
  manifest: PluginManifest
  rootDir: string
}

export interface PluginPaths {
  rootDir: string
  stateDir: string
  cacheDir: string
  tempDir: string
}

export interface PluginLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface PermissionContext {
  has(permission: PluginPermission): boolean
  require(permission: PluginPermission): void
  request(permission: PluginPermission, reason: string): Promise<boolean>
}

export interface CapabilityRegistry {
  provide<T = unknown>(provider: PluginName | 'core', name: CapabilityName, version: SemverVersion, value: T): void
  require<T = unknown>(requester: PluginName, name: CapabilityName, range?: SemverRange): T
  has(name: CapabilityName, range?: SemverRange): boolean
  list(): CapabilityRegistration[]
  fromProvider<T = unknown>(provider: PluginName | 'core', name: CapabilityName, range?: SemverRange): T | undefined
}

export interface CapabilityRegistration {
  name: CapabilityName
  version: SemverVersion
  provider: PluginName | 'core'
}

// =============================================================================
// Config
// =============================================================================

/**
 * Breaking v2 config shape. There is no `mode` field and no
 * architectural role label — a host is described entirely by its
 * plugins, sinks, and cache retention settings.
 */
export interface HypAwareV2Config {
  version: 2
  plugins?: PluginConfigInstance[]
  sinks?: Record<string, SinkConfigInstance>
  query?: QueryConfig
  /**
   * Explicit capability-provider pins. When two installed plugins
   * provide the same capability at a compatible version, the kernel
   * refuses to choose and requires the user to disambiguate by mapping
   * the capability name to the chosen provider plugin name. The kernel
   * walks this map during cross-plugin validation; any capability not
   * listed must be unambiguously provided.
   */
  disambiguate?: Record<CapabilityName, PluginName>
}

/** Legacy alias retained only while the project rename completes. */
export type CollectivusV2Config = HypAwareV2Config

export interface PluginConfigInstance {
  name: PluginName
  enabled?: boolean
  config?: JsonObject
}

/**
 * A user-named sink instance. The key in `HypAwareV2Config.sinks` is
 * the instance name (shown in status and logs). Sinks come in two
 * shapes:
 *
 * - **Blob sinks** compose a `writer` and a `destination` (blob store).
 *   The writer plugin must require `hypaware.blob-store` and provide
 *   either `hypaware.encoder` (encoder writer) or
 *   `hypaware.table-format` (table-format writer); the destination
 *   plugin provides `hypaware.blob-store`. The kernel rejects
 *   incompatible writer/destination pairs at config-load time.
 * - **Request sinks** are one-piece: a single `plugin` whose wire
 *   format is intrinsic (`@hypaware/central`, future
 *   `@hypaware/webhook`).
 *
 * In both shapes `config` carries the chosen plugin's settings plus a
 * `schedule` cron string. Queryability for a blob sink is derived from
 * the resolved writer/destination pair (e.g. parquet + local-fs is
 * queryable; jsonl + local-fs is not).
 */
export type SinkConfigInstance = BlobSinkConfigInstance | RequestSinkConfigInstance

export interface BlobSinkConfigInstance {
  /**
   * Writer plugin. Must require `hypaware.blob-store` and provide
   * either `hypaware.encoder` (per-batch byte encoder) or
   * `hypaware.table-format` (directory layout + manifests on top of an
   * encoder).
   */
  writer: PluginName
  /** Destination plugin: provides `hypaware.blob-store`. */
  destination: PluginName
  config?: SinkInstanceConfig
}

export interface RequestSinkConfigInstance {
  /** Single plugin whose wire format is intrinsic to the destination. */
  plugin: PluginName
  config?: SinkInstanceConfig
}

export interface SinkInstanceConfig extends JsonObject {
  /** Export cadence — standard 5-field cron expression (e.g. "0 * * * *"). */
  schedule?: string
  /**
   * For table-format writers (writer provides `hypaware.table-format`),
   * the inner encoder plugin used to encode data files. Defaults to
   * `@hypaware/format-parquet` when omitted. Ignored by encoder
   * writers (their format is intrinsic).
   */
  encoder?: PluginName
}

export interface QueryConfig {
  cache?: QueryCacheConfig
}

export interface QueryCacheConfig {
  /** Override the cache root (default: `~/.hyp/hypaware/`). Layout inside is fixed. */
  dir?: string
  retention?: QueryCacheRetentionConfig
  maintenance?: QueryCacheMaintenanceConfig
}

export interface QueryCacheMaintenanceConfig {
  enabled?: boolean
  interval_minutes?: number
  target_file_bytes?: number
  min_snapshots_to_keep?: number
  max_snapshot_age_hours?: number
  compact_file_count?: number
  compact_avg_file_bytes?: number
  compact_batch_bytes?: number
  max_tick_ms?: number
}

export interface QueryCacheRetentionConfig {
  default_days: number
  /** Per-dataset retention overrides. */
  datasets?: Record<string, number>
}

export interface ConfigRegistry {
  registerSection(registration: ConfigSectionRegistration): void
  validatePluginConfig(pluginName: PluginName, config: unknown): ValidationResult
}

export interface ConfigSectionRegistration {
  plugin: PluginName
  section: string
  validate(value: unknown, ctx: ConfigValidationContext): ValidationResult
  defaults?(): JsonObject
}

export interface ConfigValidationContext {
  pluginName: PluginName
  pointer: string
}

export type ValidationResult =
  | { ok: true }
  | { ok: false, errors: ValidationError[] }

export interface ValidationError {
  pointer: string
  message: string
}

// =============================================================================
// CLI commands
// =============================================================================

export interface CommandRegistry {
  register(command: CommandRegistration): void
  get(name: string): CommandRegistration | undefined
  list(): CommandRegistration[]
}

export interface CommandRegistration {
  name: string
  plugin?: PluginName
  summary: string
  usage: string
  aliases?: string[]
  hidden?: boolean
  run(argv: string[], ctx: CommandRunContext): Promise<number>
}

export interface CommandRunContext {
  stdout: WriteStream
  stderr: WriteStream
  stdin?: NodeJS.ReadStream
  env: NodeJS.ProcessEnv
  cwd: string
  config: HypAwareV2Config
  plugins: ActivePlugin[]
  capabilities: CapabilityRegistry
  /** Dataset registry (kernel-owned). Populated by the dispatcher. */
  query: QueryRegistry
  /** Intrinsic query cache storage. Populated by the dispatcher. */
  storage: QueryStorageService
  /**
   * Skill registry (kernel-owned). Populated by the dispatcher.
   * `hyp skills install` and the Phase 9 walkthrough enumerate this
   * to materialize plugin-contributed skills under per-client paths.
   */
  skills: SkillRegistry
  /**
   * Agent registry (kernel-owned). Populated by the dispatcher.
   * `hyp agents install` and the walkthrough enumerate this to
   * materialize plugin-contributed subagents under per-client paths.
   */
  agents: AgentRegistry
  /**
   * Source registry (kernel-owned). Populated by the dispatcher.
   * `hyp status` and the Phase 9 walkthrough enumerate this to render
   * the per-source breakdown and harvest source picks.
   */
  sources: SourceRegistry
  /**
   * Sink registry (kernel-owned). Populated by the dispatcher.
   * `hyp status` and the Phase 9 walkthrough enumerate this to render
   * the per-sink breakdown and harvest sink picks.
   */
  sinks: SinkRegistry
  /**
   * Init-preset registry (kernel-owned). Populated by the dispatcher.
   * `hyp init <preset>` resolves preset names through this registry.
   */
  initPresets: InitPresetRegistry
  /**
   * Backfill provider registry (kernel-owned). Populated by the
   * dispatcher. `hyp backfill` reads from this registry to list, plan,
   * and run providers.
   */
  backfills: BackfillRegistry
  /**
   * Dataset materializer registry (kernel-owned). Populated by the
   * dispatcher. `hyp backfill` resolves each yielded `BackfillItem` to
   * a registered materializer by `kind`.
   */
  backfillMaterializers: BackfillMaterializerRegistry
}

// =============================================================================
// Sources
// =============================================================================

export interface SourceRegistry {
  register(source: SourceContribution): void
  get(name: string): SourceContribution | undefined
  list(): SourceContribution[]
}

export interface SourceContribution {
  name: string
  plugin: PluginName
  summary?: string
  configSection?: string
  start(ctx: PluginActivationContext): Promise<StartedSource>
}

/**
 * `StartedSource` is the lifecycle handle returned by a source plugin's
 * `start`. `reload` receives the same `PluginActivationContext` shape
 * as `start` (with a fresh `config` slice), so a plugin reads its
 * current config from `ctx.config` in both calls.
 */
export interface StartedSource {
  status?(): Promise<SourceStatus>
  reload?(ctx: PluginActivationContext): Promise<void>
  stop(): Promise<void>
}

export interface SourceStatus {
  state: 'starting' | 'ready' | 'degraded' | 'stopped' | 'error'
  message?: string
  details?: JsonObject
  rowsWritten?: number
  lastError?: string
}

// =============================================================================
// Sinks (export targets)
// =============================================================================

/**
 * Sinks are *export targets*, not the cache. Every captured row lands
 * in the intrinsic local query cache (owned by core). The sink driver
 * reads ready partitions out of the cache on the sink's configured
 * schedule and asks each sink to export the batch.
 */
export interface SinkRegistry {
  register(contribution: SinkContribution): void
  get(name: string): SinkHandle | undefined
  list(): SinkHandle[]
}

export interface SinkContribution {
  name: string
  plugin: PluginName
  supports: SinkSupportTag[]
  create(ctx: SinkCreateContext): Promise<Sink>
}

export interface SinkCreateContext {
  /** User-chosen instance name from `HypAwareV2Config.sinks`. */
  name: string
  plugin: ActivePlugin
  config: SinkInstanceConfig
  paths: PluginPaths
  log: PluginLogger
  /**
   * For blob sinks: the resolved encoder paired with this destination.
   * Populated by the kernel from `BlobSinkConfigInstance.writer`. The
   * destination uses this to encode each partition's rows before
   * writing bytes. Undefined for request sinks (their wire format is
   * intrinsic).
   */
  encoder?: SinkEncoder
}

/**
 * Per-batch byte encoder, exposed by plugins that provide the
 * `hypaware.encoder` capability (e.g. `@hypaware/format-parquet`,
 * `@hypaware/format-jsonl`). The blob destination's `Sink` calls this
 * to turn partition rows into bytes before handing them to the
 * underlying blob store.
 */
export interface SinkEncoder {
  /** Stable identifier (e.g. "parquet", "jsonl"). */
  format: string
  /** File extension for emitted blobs (without the leading dot). */
  extension: string
  /** Tags this encoder contributes to the resolved sink's `supports` set. */
  supports: SinkSupportTag[]
  encodePartition(partition: QueryPartition, ctx: SinkEncodeContext): Promise<SinkEncodedBlob>
}

export interface SinkEncodeContext {
  log: PluginLogger
  tempDir: string
  /**
   * Column schema for the partition's dataset. Provided by the blob
   * destination so encoders that need typed coercion (Parquet, future
   * Iceberg) do not have to reach back into the query registry. JSONL-
   * style encoders may ignore it.
   */
  columns?: ColumnSpec[]
  /**
   * Async stream of rows materialized from the partition's cache table.
   * Encoders consume rows once; re-iteration is not supported. The
   * destination opens this stream from the kernel storage service.
   */
  rows?: AsyncIterable<Record<string, unknown>>
  /**
   * Column names that group rows sharing identical wide, repeated values
   * (e.g. the dataset's Iceberg partition fields like `conversation_id`).
   * Encoders that build columnar files may use these to keep each row
   * group low-cardinality so heavily-repeated columns stay dictionary-
   * encoded instead of falling back to PLAIN. Optional; encoders that do
   * not partition row groups ignore it. Empty/absent disables clustering.
   */
  clusterColumns?: readonly string[]
}

export interface SinkEncodedBlob {
  /** Filename (without directory) the destination should write under. */
  filename: string
  bytes: Uint8Array | AsyncIterable<Uint8Array>
  bytesWritten?: number
  rowCount?: number
}

/**
 * Object-store API exported by plugins that provide
 * `hypaware.blob-store`. The capability VALUE used to be a metadata-only
 * marker (`{ kind: "local-fs" }`); from V1 onwards plugins export the
 * full `BlobStore` object so table-format providers (Iceberg) and other
 * consumers can put/get/list/delete bytes without reaching for plugin
 * internals.
 *
 * `kind` is the stable identifier the destination plugin advertises
 * (e.g. `"local-fs"`, `"s3"`). Consumers may branch on it for
 * implementation-specific niceties (e.g. presigned URLs from S3) but the
 * core BlobStore methods are the lowest common denominator.
 *
 * Object keys are bytes-equivalent strings; the BlobStore implementation
 * resolves them against its configured base location. Implementations
 * MUST reject keys that escape their configured root (e.g. via `..`).
 */
export interface BlobStore {
  kind: string
  /** Advisory S3-only metadata; consumers may read it for telemetry. */
  bucket?: string
  /** Advisory prefix surfaced by stores that scope writes under one. */
  prefix?: string
  putObject(input: PutObjectInput): Promise<PutObjectResult>
  getObject(input: GetObjectInput): Promise<GetObjectResult | null>
  listObjects(input: ListObjectsInput): AsyncIterable<ListObjectResult>
  deleteObject?(input: DeleteObjectInput): Promise<void>
}

export interface PutObjectInput {
  key: string
  body: Uint8Array | NodeJS.ReadableStream
  contentType?: string
  contentLength?: number
  metadata?: Record<string, string>
  /**
   * Conditional write: only put when no object exists at `key`. Iceberg
   * needs this for metadata-file commits; S3 implements it via the
   * `If-None-Match` request header. Local-fs implements it via the
   * `O_EXCL` open flag. Implementations that cannot honour the
   * condition MUST throw with `error_kind=blob_precondition_failed`
   * rather than silently overwrite.
   */
  ifNoneMatch?: string
}

export interface PutObjectResult {
  key: string
  etag?: string
  versionId?: string
}

export interface GetObjectInput {
  key: string
}

export interface GetObjectResult {
  body: NodeJS.ReadableStream
  contentLength?: number
  etag?: string
}

export interface ListObjectsInput {
  prefix: string
  /**
   * Continuation token for paginated listings. The first call passes
   * undefined; subsequent calls pass the token from the previous page.
   * Local-fs ignores it (listings are not paginated); S3 forwards it.
   */
  continuationToken?: string
}

export interface ListObjectResult {
  key: string
  size: number
  lastModified: Date
}

export interface DeleteObjectInput {
  key: string
}

/**
 * Table-format providers expose `hypaware.table-format` and contribute a
 * sink whose `writer` config provides a directory layout + manifests on
 * top of a blob store and inner encoder. The kernel resolves the
 * `BlobStore` from the destination plugin and the inner `SinkEncoder`
 * (defaulting to `@hypaware/format-parquet`) and hands both to
 * `createSink`.
 *
 * Unlike encoder writers (which run via the destination's sink
 * contribution), a table-format writer is the sink itself — the
 * destination's contribution is bypassed. The destination still has to
 * provide `hypaware.blob-store` so the table-format sink can write
 * bytes.
 */
export interface TableFormatProvider {
  /** Stable identifier (e.g. `"iceberg"`). */
  format: string
  /** Tags this provider contributes to the resolved sink's `supports` set. */
  supports: SinkSupportTag[]
  createSink(ctx: TableFormatCreateContext): Promise<Sink>
}

export interface TableFormatCreateContext {
  /** User-chosen instance name from `HypAwareV2Config.sinks`. */
  name: string
  /** The table-format writer plugin's `ActivePlugin` record. */
  plugin: ActivePlugin
  /**
   * BlobStore resolved from the destination plugin
   * (`BlobSinkConfigInstance.destination`). The table-format sink writes
   * all bytes (data files + manifests) through this.
   */
  blobStore: BlobStore
  /**
   * Inner encoder resolved from `config.encoder`. Defaults to the
   * `@hypaware/format-parquet` capability value when the user does not
   * pin a specific encoder.
   */
  encoder: SinkEncoder
  query: QueryRegistry
  storage: QueryStorageService
  sinkInstanceConfig: SinkInstanceConfig
  paths: PluginPaths
  log: PluginLogger
}

export interface SinkHandle {
  name: string
  plugin: PluginName
  supports: SinkSupportTag[]
  sink: Sink
}

export interface Sink {
  /**
   * Called by the sink driver on the configured schedule. The driver
   * passes a batch of ready partitions from the cache; the sink writes
   * them to its destination in the configured format and acks.
   */
  exportBatch(batch: ExportBatch, opts: ExportOptions): Promise<ExportResult>
  flush?(): Promise<void>
  close(): Promise<void>
  /** Implemented by sinks that declare `supports: ["queryable"]`. */
  reader?(): SinkQueryReader
}

export interface ExportBatch {
  /** Partitions ready to export, materialized in the cache. */
  partitions: QueryPartition[]
  /** Monotonic batch id, useful for outbox-style retry semantics. */
  batchId: string
}

export interface ExportOptions {
  format: string
  schedule: string
}

export interface ExportResult {
  status: 'exported' | 'partial' | 'failed'
  partitionsExported: number
  bytesWritten?: number
  /** Partitions the sink could not export this round; will be retried. */
  retryPartitions?: QueryPartition[]
  error?: string
}

/**
 * Read API surfaced by sinks tagged `queryable`. Lets `hypaware query`
 * scan data that has already aged out of the local cache by reading
 * the sink's exported files in place.
 */
export interface SinkQueryReader {
  discoverPartitions(scope: QueryScope): Promise<QueryPartition[]> | QueryPartition[]
  createDataSource(partitions: QueryPartition[], ctx: DatasetDataSourceContext): Promise<AsyncDataSource> | AsyncDataSource
}

// =============================================================================
// Query datasets
// =============================================================================

export interface QueryRegistry {
  registerDataset(dataset: DatasetRegistration): void
  getDataset(name: string): DatasetRegistration | undefined
  listDatasets(): DatasetRegistration[]
}

export interface DatasetRegistration {
  name: string
  plugin: PluginName
  schema: DatasetSchema
  sourceSignal?: string
  primaryTimestampColumn?: string
  fallbackTimestampColumns?: string[]
  cachePartitioning?: CachePartitioningDeclaration
  discoverPartitions(ctx: DatasetDiscoveryContext): Promise<QueryPartition[]> | QueryPartition[]
  refreshPartition?(partition: QueryPartition, ctx: DatasetRefreshContext): Promise<DatasetRefreshResult>
  createDataSource(partitions: QueryPartition[], ctx: DatasetDataSourceContext): Promise<AsyncDataSource> | AsyncDataSource
}

export interface DatasetSchema {
  columns: ColumnSpec[]
}

export interface ColumnSpec {
  name: string
  type: 'STRING' | 'INT32' | 'INT64' | 'DOUBLE' | 'BOOLEAN' | 'TIMESTAMP' | 'JSON'
  nullable: boolean
}

export interface DatasetDiscoveryContext {
  config: HypAwareV2Config
  scope: QueryScope
  cacheDir?: string
  recordingRoot?: string
}

export interface QueryPartition {
  dataset: string
  partition: Record<string, string>
  sourcePath?: string
  cachePath?: string
  tablePath?: string
  tableUrl?: string
  sourceSize?: number
  sourceMtimeMs?: number
  meta?: JsonObject
}

export interface DatasetRefreshContext {
  cacheDir: string
  force: boolean
  log: PluginLogger
  storage: QueryStorageService
}

export interface DatasetRefreshResult {
  status: 'written' | 'skipped' | 'failed'
  rows: number
  cachePath?: string
  error?: string
}

export interface DatasetDataSourceContext {
  scope: QueryScope
  storage: QueryStorageService
}

export interface QueryScope {
  datasets?: string[]
  date?: string
  dates?: string[]
  from?: string
  to?: string
  service?: string
  limit: number
}

/**
 * Intrinsic storage service exposed by core to plugins that materialize
 * rows into the local Iceberg-backed cache. Plugins do not configure
 * storage — the cache root is HypAware-managed.
 *
 * `cacheRoot` and `cacheTablePath` let plugins discover the layout
 * convention without baking the `datasets/<name>` segment into
 * dataset code; the kernel is free to evolve the on-disk layout as
 * long as those helpers keep their contract.
 */
export interface QueryStorageService {
  cacheRoot: string
  cacheTablePath(dataset: string, partitionSegments?: string[]): string
  appendRows(tablePath: string, columns: ColumnSpec[], rows: Record<string, unknown>[]): Promise<void>
  appendRowsToPartition(
    dataset: string,
    partitionSegments: string[],
    columns: ColumnSpec[],
    rows: Record<string, unknown>[],
  ): Promise<void>
  discoverCachePartitions(scope?: Partial<QueryScope>): Promise<CachePartitionMeta[]>
  tableExists(tablePath: string): boolean
  tableUrl(tablePath: string): string
  readRows(tablePath: string, columns?: string[]): AsyncIterable<Record<string, unknown>>
}

export interface CachePartitionMeta {
  dataset: string
  partition: Record<string, string>
  path: string
  epoch: number
  rowCount: number
}

// =============================================================================
// AI gateway capability (`hypaware.ai-gateway@2.0.0`)
// =============================================================================

/**
 * Provided by `@hypaware/ai-gateway` (the HTTP/SSE AI gateway source).
 *
 * As of `hypaware.ai-gateway@2.0.0`, the gateway is a generic HTTP/SSE
 * capture and row-storage owner: all client/protocol semantics live in
 * adapter plugins. Adapter plugins (`@hypaware/claude`,
 * `@hypaware/codex`, future custom integrations) reach the gateway
 * through `ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')` and
 * use these hooks to:
 *
 * - register upstream presets (`registerUpstreamPreset`) that own
 *   routing — the gateway no longer has any hardcoded provider routing
 *   such as Anthropic-header or `/v1/messages` matching;
 * - register client attach/detach helpers (`registerClient`) so the
 *   shared `hyp attach`/`hyp detach` CLI can dispatch without coupling
 *   core to client-specific code;
 * - register exchange projectors (`registerExchangeProjector`) that
 *   turn a captured HTTP/SSE exchange into a normalized list of
 *   conversation messages. The gateway expands the projector's output
 *   into part rows in the `ai_gateway_messages` dataset, applies a
 *   fallback hash identity when the projector omits `message_id`, and
 *   stamps `attributes.gateway.*` provenance.
 *
 * The gateway owns the `ai_gateway_messages` dataset and its schema.
 * Removed in 2.0.0: `registerExchangeContextProjector` and
 * `registerMessageEnricher` — both are subsumed by the full exchange
 * projector hook.
 */
export interface AiGatewayCapability {
  registerUpstreamPreset(preset: AiGatewayUpstreamPreset): void
  registerClient(client: AiGatewayClientRegistration): void
  registerExchangeProjector(projector: AiGatewayExchangeProjector): void
  localEndpoint(opts?: AiGatewayEndpointOptions): string
  /**
   * Look up a registered client by name. Returns `undefined` when no
   * adapter plugin has registered under that name. Used by the shared
   * `hyp attach`/`hyp detach` command router to dispatch to the right
   * adapter without coupling core to plugin-specific code.
   */
  getClient(name: string): AiGatewayClientRegistration | undefined
  /**
   * Enumerate every registered client. Used by `hyp attach --help`
   * and the walkthrough to list available adapters.
   */
  listClients(): AiGatewayClientRegistration[]
}

/**
 * Routing entry registered by an adapter plugin. The gateway compiles
 * registered presets together with TOML-config upstreams into a single
 * routing table, sorted by descending `priority` then registration
 * order.
 *
 * Matching strategy per request, in order:
 *  - If `match()` is supplied, use its boolean result.
 *  - Otherwise fall back to a `path_prefix` segment match.
 *
 * `path_prefix` is optional only because adapters may prefer the more
 * expressive `match()`. Presets with neither a `match()` nor a
 * `path_prefix` never match.
 */
export interface AiGatewayUpstreamPreset {
  name: string
  base_url: string
  provider?: string
  path_prefix?: string
  priority?: number
  match?(input: AiGatewayRouteInput): boolean
}

/**
 * Read-only view of the inbound request handed to a preset's
 * `match()`. Header names are lowercased; values are arrays so callers
 * never have to special-case the `IncomingHttpHeaders` string-or-array
 * union. The body is intentionally not exposed here — matching is
 * supposed to be cheap and head-only.
 */
export interface AiGatewayRouteInput {
  method: string
  path: string
  headers: Record<string, string[]>
}

export interface AiGatewayEndpointOptions {
  pathPrefix?: string
  upstream?: string
}

export interface AiGatewayClientRegistration {
  name: string
  defaultUpstream: string
  attach(ctx: AiGatewayClientAttachContext): Promise<void>
  detach(ctx: AiGatewayClientDetachContext): Promise<void>
  status?(ctx: AiGatewayClientStatusContext): Promise<JsonObject>
}

export interface AiGatewayClientAttachContext {
  endpoint: string
  config: JsonObject
  stdout: WriteStream
  stderr: WriteStream
  /**
   * When true the adapter must report what it *would* write without
   * touching the user's filesystem or external state.
   */
  dryRun?: boolean
  /**
   * When true the adapter must emit machine-readable JSON on stdout
   * instead of human prose. One JSON object per attach call,
   * containing at minimum `status`, `action`, `client`, `dry_run`,
   * and any adapter-specific fields (e.g. `settings_path`, `port`,
   * `changed`, `prev_value`).
   */
  json?: boolean
}

export interface AiGatewayClientDetachContext {
  config: JsonObject
  stdout: WriteStream
  stderr: WriteStream
  dryRun?: boolean
  /**
   * When true the adapter must emit machine-readable JSON on stdout
   * instead of human prose. One JSON object per detach call.
   */
  json?: boolean
}

export interface AiGatewayClientStatusContext {
  config: JsonObject
}

/**
 * Exchange projector contributed by an adapter plugin. The gateway
 * dispatches each finalized exchange through every projector whose
 * `match()` returns true (sorted by descending priority, then
 * registration order); the first projector that returns a non-empty
 * `AiGatewayProjectedExchange` wins. Projectors that throw, return
 * `undefined`, or return an invalid shape are warned and skipped. If
 * no projector succeeds the gateway still emits pass-through
 * telemetry (the `aigw.exchange` log and `aigw.exchange_bytes` meter)
 * but writes zero rows into `ai_gateway_messages`.
 */
export interface AiGatewayExchangeProjector {
  name: string
  priority?: number
  match(input: AiGatewayExchangeInput): boolean
  project(
    input: AiGatewayExchangeInput,
    ctx: AiGatewayExchangeProjectorContext
  ): AiGatewayProjectedExchange | Promise<AiGatewayProjectedExchange | undefined> | undefined
}

export interface AiGatewayExchangeProjectorContext {
  log: PluginLogger
}

/**
 * Captured exchange envelope handed to projectors. Mirrors the
 * recorder's finalized row shape; bodies are post-redaction strings,
 * headers are JSON-stringified, and the gateway has not yet computed
 * fallback identity. `stream_events` is the parsed SSE event stream
 * (oldest-first) when `is_sse` is true.
 */
export interface AiGatewayExchangeInput {
  exchange_id: string
  ts_start: string
  ts_end: string | null
  duration_ms: number | null
  upstream: string
  provider: string | null
  method: string | null
  path: string | null
  status_code: number | null
  request_bytes: number | null
  response_bytes: number | null
  is_sse: boolean | null
  stream_event_count: number | null
  request_headers: string | null
  request_body: string | null
  response_headers: string | null
  response_body: string | null
  error: string | null
  metadata: string | null
  stream_events: Array<{
    kind: 'stream_event'
    exchange_id: string
    t_ms: number
    event: string
    data: string
    id?: string
  }>
}

/**
 * Normalized projection result returned by an exchange projector. The
 * gateway treats this as the canonical exchange shape: it copies the
 * conversation-level fields onto every emitted row, applies any
 * fallback identity for messages lacking `message_id`, and expands
 * each `messages[]` entry into part rows in `ai_gateway_messages`.
 *
 * Provider-defined fields (`provider`, `conversation_id`, identity)
 * are authoritative — the gateway never overrides them when present.
 */
export interface AiGatewayProjectedExchange {
  provider: string
  conversation_id: string
  conversation_started_at?: string
  conversation_source?: string
  user_id?: string
  cwd?: string
  git_branch?: string
  client_name?: string
  client_version?: string
  entrypoint?: string
  user_type?: string
  permission_mode?: string
  is_sidechain?: boolean
  model?: string
  system_text?: string
  tools?: JsonValue
  request_id?: string
  prompt_id?: string
  /**
   * Conversation-level attributes merged into every emitted row's
   * `attributes` column. The gateway adds `attributes.gateway.*`
   * provenance on top.
   */
  attributes?: JsonObject
  messages: AiGatewayProjectedMessage[]
}

/**
 * A normalized message inside an `AiGatewayProjectedExchange`.
 *
 * Identity rules:
 *  - If the projector supplies `message_id`, the gateway uses it
 *    verbatim and never overwrites it.
 *  - If `message_id` is omitted, the gateway computes a hash id from
 *    `(conversation_id, role, content)` and stamps
 *    `attributes.gateway.identity_source = "gateway_fallback"`.
 *  - `previous_message_id` is preserved when the projector supplies
 *    it (an empty array marks a conversation root). When the
 *    projector omits it AND fallback identity was applied, the
 *    gateway fills a linear chain of prior message ids in this
 *    exchange.
 */
export interface AiGatewayProjectedMessage {
  role: string
  content: string | JsonObject[]
  message_id?: string
  previous_message_id?: string[]
  message_created_at?: string
  provider_uuid?: string
  parent_uuid?: string
  logical_parent_uuid?: string
  source_tool_assistant_uuid?: string
  request_id?: string
  prompt_id?: string
  provider_type?: string
  provider_subtype?: string
  entrypoint?: string
  user_type?: string
  permission_mode?: string
  is_sidechain?: boolean
  attachment_type?: string
  hook_event?: string
  is_compact_summary?: boolean
  compact_metadata?: JsonValue
  raw_frame?: JsonObject
  attributes?: JsonObject
  /** Provider-supplied finish/stop reason for the message; consumed by the gateway to derive `finish_reason`. */
  stop_reason?: string
}

// =============================================================================
// Skills and init presets
// =============================================================================

export interface SkillRegistry {
  register(skill: SkillContribution): void
  list(): SkillContribution[]
}

export interface SkillContribution {
  name: string
  plugin: PluginName
  clients: PluginSkillClient[]
  sourceDir: string
  /**
   * When true, the skill is copied into the active project's per-client
   * skill directory (`.claude/skills/`, `.codex/skills/`) instead of
   * the user-global location.
   */
  projectLocal?: boolean
}

export interface AgentRegistry {
  register(agent: AgentContribution): void
  list(): AgentContribution[]
}

/**
 * A custom subagent contributed by a client-adapter plugin. Unlike
 * skills (a directory tree around a `SKILL.md`), an agent is a single
 * markdown definition file installed flat into the per-client agent
 * directory as `<agent_dir>/<name>.md`.
 */
export interface AgentContribution {
  name: string
  plugin: PluginName
  clients: PluginSkillClient[]
  sourceFile: string
}

export interface InitPresetRegistry {
  register(preset: InitPresetContribution): void
  get(name: string): InitPresetContribution | undefined
  list(): InitPresetContribution[]
}

export interface InitPresetContribution {
  name: string
  plugin: PluginName
  summary: string
  run(argv: string[], ctx: CommandRunContext): Promise<number>
}

// =============================================================================
// Backfill (first-class client history import)
// =============================================================================

/**
 * Plugin-registered backfill providers. Each provider plans and yields
 * `BackfillItem` envelopes (and optional `BackfillEvent` lifecycle
 * signals) for one or more datasets. Core owns the runner, telemetry
 * envelope, dry-run behavior, and dataset materialization; providers
 * own native-format discovery, parsing, and projection.
 */
export interface BackfillRegistry {
  register(contribution: BackfillContribution): void
  get(name: string): BackfillContribution | undefined
  list(): BackfillContribution[]
}

export interface BackfillContribution {
  /** Stable, kebab-case provider identifier (e.g. `claude`, `codex`). */
  name: string
  /** Owning plugin (e.g. `@hypaware/claude`). */
  plugin: PluginName
  /** Datasets this provider contributes rows to. */
  datasets: string[]
  /** Short human-readable description for `hyp backfill list`. */
  summary?: string
  /**
   * Optional planning hook. Called by `hyp backfill plan` to surface
   * what would be scanned without committing to writes. Returning
   * `undefined` means the provider has no planning information.
   */
  plan?(ctx: BackfillPlanContext): Promise<BackfillPlan | undefined>
  /**
   * Stream `BackfillItem` envelopes (one per scanned record) and
   * optional `BackfillEvent` lifecycle signals. The runner consumes
   * each `BackfillItem` by resolving its `kind` against the
   * dataset-materializer registry.
   */
  run(ctx: BackfillRunContext): AsyncIterable<BackfillItem | BackfillEvent>
}

export interface BackfillPlanContext {
  env: NodeJS.ProcessEnv
  cacheRoot: string
  /** Effective lower bound for record timestamps (ISO string). */
  since?: string
  /** Effective upper bound for record timestamps (ISO string). */
  until?: string
  /**
   * Retention window resolved from CLI flag or
   * `config.query.cache.retentionDays`. Providers should not import
   * records older than this when no explicit `since` was supplied.
   */
  retentionDays?: number
  log: PluginLogger
  signal?: AbortSignal
}

export interface BackfillRunContext extends BackfillPlanContext {
  storage: QueryStorageService
  /**
   * When true, the runner expects the provider to scan and yield items
   * without performing irreversible side effects. The runner skips the
   * materialize/write/flush steps in dry-run mode.
   */
  dryRun: boolean
}

/**
 * A provider-yielded record. The runner does not interpret `value`
 * itself; it resolves `kind` against the dataset-materializer registry
 * and asks the registered materializer to produce canonical rows.
 */
export interface BackfillItem {
  type?: 'item'
  /** Target dataset (must match the materializer's `dataset`). */
  dataset: string
  /** Materializer dispatch key (e.g. `ai_gateway.projected_exchange`). */
  kind: string
  /** Materializer input. Shape is owned by the kind/materializer pair. */
  value: Record<string, unknown>
  /** Optional provenance hints surfaced in telemetry. */
  provenance?: BackfillProvenance
}

export interface BackfillProvenance {
  /** Client name attribution (e.g. `claude`, `codex`). */
  client_name?: string
  /** Source-file pointer (e.g. transcript path). */
  source_path?: string
  /** Native record identifier when available. */
  native_id?: string
}

export interface BackfillEvent {
  type: 'event'
  /** Free-form event name (e.g. `scan_started`, `unsupported_location`). */
  event: string
  /** Optional structured attributes. */
  attributes?: Record<string, unknown>
}

export interface BackfillPlan {
  /** Provider-supplied estimate of records that would be scanned. */
  estimated_items?: number
  /** Free-form scan-location descriptors (e.g. file paths). */
  sources?: string[]
  /** Optional human-readable notes (`hyp backfill plan` surfaces these). */
  notes?: string[]
}

/**
 * Dataset-owner materializers convert `BackfillItem.value` payloads
 * into canonical rows for a target dataset. One materializer per
 * `kind`; the runner asks the registry to look up by `kind` and calls
 * `materialize(item, ctx)` for each provider-yielded item.
 */
export interface BackfillMaterializerRegistry {
  register(contribution: BackfillMaterializerContribution): void
  get(kind: string): BackfillMaterializerContribution | undefined
  list(): BackfillMaterializerContribution[]
}

export interface BackfillMaterializerContribution {
  /** Dispatch key matched against `BackfillItem.kind`. */
  kind: string
  /** Target dataset (e.g. `ai_gateway_messages`). */
  dataset: string
  /** Owning plugin (e.g. `@hypaware/ai-gateway`). */
  plugin: PluginName
  /**
   * Convert one provider-yielded item into canonical rows for `dataset`.
   * Implementations must be pure with respect to `item.value` so reruns
   * produce identical row identity.
   */
  materialize(
    item: BackfillItem,
    ctx: BackfillMaterializeContext,
  ): Promise<Record<string, unknown>[]> | Record<string, unknown>[]
}

export interface BackfillMaterializeContext {
  log: PluginLogger
  env: NodeJS.ProcessEnv
  storage: QueryStorageService
  /** Stable run id propagated from the CLI runner. */
  devRunId?: string
}

