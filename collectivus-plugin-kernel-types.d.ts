/**
 * Draft public interfaces for the HypAware plugin-kernel design.
 *
 * This file is a design artifact, not an implementation contract yet. It is
 * intentionally expressed as .d.ts because these shapes would become the
 * reusable public API exposed to bundled and external plugins.
 *
 * The companion design document is
 * [`hypaware-design.md`](./hypaware-design.md). When the two disagree the
 * design document wins; this file is updated to follow.
 *
 * Filename is `collectivus-plugin-kernel-types.d.ts` only because the
 * project rename to HypAware is still pending; the contents already
 * track the HypAware design.
 */

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
 * - `hypaware.blob-store` — "put these bytes at this path" destination,
 *   provided by blob sink plugins (`@hypaware/local-fs`, future
 *   `@hypaware/s3`). Consumed by writer plugins.
 * - `hypaware.encoder` — per-batch byte encoder, provided by writer
 *   plugins (`@hypaware/format-parquet`, `@hypaware/format-jsonl`).
 *   Consumed by table-format plugins.
 * - `hypaware.table-format` — directory layout + manifests on top of a
 *   blob store and encoder. Provided by post-V1 `@hypaware/format-iceberg`.
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
  commands?: PluginCommandManifest[]
  config_sections?: PluginConfigSectionManifest[]
  sources?: PluginSourceManifest[]
  sinks?: PluginSinkManifest[]
  datasets?: PluginDatasetManifest[]
  skills?: PluginSkillManifest[]
  init_presets?: PluginInitPresetManifest[]
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
  initPresets: InitPresetRegistry
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
 * - **Blob sinks** compose a `writer` (encoder) and a `destination`
 *   (blob store). The writer plugin requires `hypaware.blob-store` and
 *   provides `hypaware.encoder`; the destination plugin provides
 *   `hypaware.blob-store`. The kernel rejects incompatible
 *   writer/destination pairs at config-load time.
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
  /** Writer plugin: requires `hypaware.blob-store`, provides `hypaware.encoder`. */
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
}

export interface QueryConfig {
  cache?: QueryCacheConfig
}

export interface QueryCacheConfig {
  /** Override the cache root (default: `~/.hyp/hypaware/`). Layout inside is fixed. */
  dir?: string
  retention?: QueryCacheRetentionConfig
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
}

export interface SinkEncodedBlob {
  /** Filename (without directory) the destination should write under. */
  filename: string
  bytes: Uint8Array | AsyncIterable<Uint8Array>
  bytesWritten?: number
  rowCount?: number
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
  createDataSource(partitions: QueryPartition[], ctx: DatasetDataSourceContext): Promise<QueryDataSource> | QueryDataSource
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
  discoverPartitions(ctx: DatasetDiscoveryContext): Promise<QueryPartition[]> | QueryPartition[]
  refreshPartition?(partition: QueryPartition, ctx: DatasetRefreshContext): Promise<DatasetRefreshResult>
  createDataSource(partitions: QueryPartition[], ctx: DatasetDataSourceContext): Promise<QueryDataSource> | QueryDataSource
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

export interface QueryDataSource {
  columns: string[]
  numRows?: number
  scan(options: QueryScanOptions): QueryScanResult
}

export interface QueryScanOptions {
  limit?: number
  offset?: number
  where?: unknown
  columns?: string[]
}

export interface QueryScanResult {
  appliedWhere: boolean
  appliedLimitOffset: boolean
  rows(): AsyncIterable<Record<string, unknown>>
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
  tableExists(tablePath: string): boolean
  tableUrl(tablePath: string): string
  readRows(tablePath: string, columns?: string[]): AsyncIterable<Record<string, unknown>>
}

// =============================================================================
// AI gateway capability (`hypaware.ai-gateway`)
// =============================================================================

/**
 * Provided by `@hypaware/ai-gateway` (the HTTP/SSE AI gateway source).
 * Client-adapter plugins (`@hypaware/claude`, `@hypaware/codex`) reach
 * the gateway through `ctx.requireCapability('hypaware.ai-gateway', ...)`
 * and use these hooks to register upstream presets, attach/detach
 * client settings, and contribute row enrichers for the
 * `ai_gateway_messages` dataset.
 *
 * The gateway plugin owns the `ai_gateway_messages` dataset and its
 * schema; adapter enrichers compile against that single-owner table
 * (see the "one source, one table" naming rule in the design).
 */
export interface AiGatewayCapability {
  registerUpstreamPreset(preset: AiGatewayUpstreamPreset): void
  registerClient(client: AiGatewayClientRegistration): void
  registerMessageEnricher(enricher: AiGatewayMessageEnricher): void
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
   * and the Phase 9 walkthrough to list available adapters.
   */
  listClients(): AiGatewayClientRegistration[]
}

export interface AiGatewayUpstreamPreset {
  name: string
  base_url: string
  path_prefix: string
  provider?: string
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
   * touching the user's filesystem or external state. Phase 6 will
   * harden adapters around this flag; Phase 2 uses it to verify the
   * dispatcher reaches the right adapter under `hyp attach --dry-run`.
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

export interface AiGatewayMessageEnricher {
  name: string
  enrich(row: Record<string, unknown>, ctx: AiGatewayMessageEnricherContext): Promise<Record<string, unknown>> | Record<string, unknown>
}

export interface AiGatewayMessageEnricherContext {
  homeDir: string
  cacheDir: string
  log: PluginLogger
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

