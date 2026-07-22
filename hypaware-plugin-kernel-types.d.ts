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
 */

import type { AsyncDataSource, ScanOptions, ScanResults } from 'squirreling'
import type { CachePartitioningDeclaration } from './src/core/iceberg/types.d.ts'
import type { UsagePolicyDrop } from './src/core/usage-policy/types.d.ts'

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
 * - `hypaware.embedder` — text embedding production, provided by
 *   embedder plugins (`@hypaware/embedder-openai`, future local
 *   embedders). The capability VALUE is an `EmbedderCapability`.
 *   Consumed by `@hypaware/vector-search`.
 * - `hypaware.vector-search` — vector similarity search over cached
 *   datasets, provided by `@hypaware/vector-search`. The capability
 *   VALUE is a `VectorSearchCapability`.
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
  | 'write_openclaw_settings'
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
  /**
   * Picker rows this plugin contributes to the `hyp init` wizard. One
   * plugin may contribute more than one row (e.g. `@hypaware/ai-gateway`
   * contributes both `raw-anthropic` and `raw-openai`), so this is an
   * array, sibling to the single `client` descriptor above.
   */
  picker?: PluginPickerContribution[]
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
  format: 'json' | 'toml' | 'json_path'
  settings_file: string
  marker_key?: string
  marker_header?: string
  /**
   * `json_path` only: dotted path to the managed object whose presence
   * means the client is attached (e.g. `models.providers.hypaware`).
   * Segments are plain literals split on `.` with no escaping, so a
   * key containing a dot cannot be addressed.
   */
  marker_path?: string
  /**
   * `json_path` only: dotted path RELATIVE to the marker object to a
   * string property holding the JSON-encoded self-describing undo
   * record (e.g. `headers.x-hypaware-marker`).
   */
  marker_record?: string
}

/**
 * One row in the `hyp init` wizard's client/source picker, contributed
 * declaratively by a plugin's manifest rather than a hardcoded core
 * table (LLP 0130). `name` is the picker source id that keys the row
 * (e.g. `claude`, `codex`, `raw-anthropic`); one plugin may contribute
 * more than one row (`@hypaware/ai-gateway` contributes both
 * `raw-anthropic` and `raw-openai`), so each row names its own id
 * rather than inheriting the plugin's package name. The remaining
 * fields drive the row's label, initial detection, and, for a
 * `needs_setup` row, the command that configures it.
 */
export interface PluginPickerContribution {
  /** Picker source id keying this row. */
  name: string
  /** Human-readable row label shown in the picker prompt. */
  label: string
  /** One-line description of what picking this row captures. */
  summary?: string
  /**
   * Best-effort presence probe seeding the row's initial checkbox
   * state. A probe failure means "not present," never an error.
   */
  detect?: PickerDetectProbe
  /**
   * True when picking this row is not sufficient on its own: an
   * attended `configure_command` must run to place the integration
   * (e.g. Claude Desktop's managed-preferences plist). Absent/false
   * rows are configured entirely by the picker's config write.
   */
  needs_setup?: boolean
  /**
   * Command name (as registered under `contributes.commands`) the
   * wizard's configure phase invokes for a `needs_setup` row, run in
   * process through `CommandRunContext.commands.run`.
   */
  configure_command?: string
  /**
   * Composition contribution: the data `composePickerConfig` folds to
   * build the local-layer config when this row is picked (LLP 0130). It
   * carries, in manifest data, the same knowledge the retired hardcoded
   * `composePickerConfig` switch held in core: which plugin instance the
   * pick adds, whether it needs the local AI gateway, and which gateway
   * upstream(s) it requests. Rows with no `compose` (a detection-only or
   * `needs_setup` client the picker's config write handles) contribute
   * nothing to the fold.
   */
  compose?: PluginPickerCompose
}

/**
 * A picker row's composition contribution, folded by
 * `composePickerConfig` (LLP 0130#picker-block). Every field is
 * optional: a row may add a plugin, request the gateway, contribute
 * gateway upstreams, or any combination.
 */
export interface PluginPickerCompose {
  /**
   * Plugin instance added to the composed config when this row is
   * picked. A gateway-requiring plugin (`requires_gateway: true`) is
   * placed after the export sink plugins; a gateway-independent plugin
   * is placed before them, matching the retired switch's plugin order.
   */
  plugin?: PluginConfigInstance
  /**
   * True when picking this row implies the local AI gateway
   * (`@hypaware/ai-gateway`). The gateway plugin is included once when
   * any picked row sets this.
   */
  requires_gateway?: boolean
  /**
   * Gateway upstream(s) this row requests. The fold unions the requested
   * upstreams across all picked rows, deduped by `name`, into the
   * gateway plugin's `upstreams`. Accepts a single upstream or an array.
   */
  gateway_upstream?: PluginPickerGatewayUpstream | PluginPickerGatewayUpstream[]
}

/**
 * One upstream a picker row requests on the local AI gateway.
 */
export interface PluginPickerGatewayUpstream {
  name: string
  base_url: string
  path_prefix: string
  provider?: string
}

/**
 * A picker row's presence probe. Exactly one variant key is set; the
 * detector switches on which key is present.
 */
export type PickerDetectProbe =
  | { settings_file: string } // reuses the `contributes.client.attach_probe` settings-file shape
  | { app_bundle: string } // stat-exists check on a macOS `.app` bundle path
  | { path: string } // stat-exists check on a directory (honors `$FOO_HOME`-style env overrides)

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
  /**
   * Row column carrying the picker source id a row is attributed to
   * (e.g. `client_name` for `ai_gateway_messages`, where claude/codex/
   * hermes rows all land). Enables source-scoped export withholding:
   * a dataset with no declared `attribution_column` is never subject
   * to source-scoped withholding (LLP 0132).
   */
  attribution_column?: string
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
   * Verb registry (kernel-owned). A plugin registers a query-shaped
   * operation once and the kernel projects it into both a CLI command
   * and an MCP tool (LLP 0034 §verbs). `@hypaware/context-graph`
   * registers `graph neighbors` here so it yields its `graph_neighbors`
   * tool for free.
   */
  verbs: VerbRegistry
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
  /**
   * Narrow facade over the kernel config apply engine (LLP 0023). Only
   * present when the host process runs an apply engine (the daemon);
   * absent in plain CLI boots, so transport plugins must treat it as
   * optional and skip their pull loops when it is missing. The facade
   * is the only channel a plugin has into config application — the
   * kernel owns validation, install, persistence, restart, probation,
   * and rollback.
   */
  configControl?: ConfigControlFacade
  requireCapability<T = unknown>(name: CapabilityName, range?: SemverRange): T
  provideCapability<T = unknown>(name: CapabilityName, version: SemverVersion, value: T): void
}

/**
 * Plugin-facing surface of the kernel config apply engine. Handed to
 * transport plugins (e.g. `@hypaware/central`) so they can deliver a
 * downloaded config document and report poll liveness. Deliberately
 * narrow: plugins never see probation state, slot paths, or rollback
 * bookkeeping.
 */
export interface ConfigControlFacade {
  /**
   * Deliver a downloaded config document (parsed JSON) plus the ETag it
   * was served under. The kernel validates, installs pinned plugins,
   * persists, swaps, and requests a staged restart. Resolves before the
   * restart happens; callers should treat `{ ok: true }` as "apply
   * committed, restart pending".
   */
  stage(document: unknown, etag: string): Promise<ConfigStageResult>
  /**
   * Report a successful authenticated config poll (200 or 304). Clears
   * the post-apply probation window when one is active; a no-op
   * otherwise.
   */
  confirmPoll(): void
  /** ETag of the *running* config, for `If-None-Match`. Undefined when the operative config was never applied from the server (e.g. seed). */
  runningEtag(): string | undefined
}

export type ConfigStageResult =
  | { ok: true, action: 'applied' | 'noop_same_etag' | 'skipped_bad_etag' }
  | { ok: false, errorKind: ConfigApplyErrorKind, message: string }

export type ConfigApplyErrorKind =
  | 'config_invalid'
  | 'plugin_install_failed'
  | 'artifact_hash_mismatch'
  | 'bundled_version_mismatch'
  | 'document_too_large'
  | 'apply_engine_not_ready'
  | 'restart_pending'
  | 'apply_io_error'

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
  /**
   * Pinned plugin version. Set by centrally-served configs (LLP 0023):
   * the apply engine refuses a config whose pins it cannot satisfy.
   * For bundled first-party plugins the pin is checked strictly against
   * the bundled version; for fetched plugins it selects the artifact.
   */
  version?: SemverVersion
  /**
   * Pinned artifact content hash for fetched plugins. The apply engine
   * verifies the fetched artifact against this before committing the
   * install; a mismatch is an apply failure. Ignored (not checked) for
   * plugins bundled with the running kernel.
   */
  artifact_hash?: string
  /**
   * Optional explicit install source (raw source string accepted by the
   * plugin installer). Defaults to the plugin name, which the resolver
   * maps to its canonical git source.
   */
  source?: string
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

export type SinkInstanceConfig = JsonObject & {
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
  /**
   * Named remote MCP targets for `hyp <verb> --remote <name>` (LLP 0033
   * §targets). Lives inside the **local-only** `query{}` block, so the
   * central layer can never inject a remote target (LLP 0031). The URL is
   * non-secret and committable; the query-scoped token is never config.
   */
  remotes?: Record<string, QueryRemoteTarget>
  /** Default target used by `--remote` with no argument. Must name a key in `remotes`. */
  default_remote?: string
}

export interface QueryRemoteTarget {
  /** The server's MCP endpoint, e.g. `https://hyp.internal/mcp`. */
  url: string
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
  /**
   * Optional longer help text (may be multi-line). Rendered by the core
   * help renderer after the usage line for `hyp <name> --help`; the
   * summary stays one line for command listings.
   */
  help?: string
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
  /**
   * In-process command dispatch seam (kernel-owned). Lets a command
   * implementation invoke another registered command by name and receive
   * its exit code, without exposing the full mutable command registry.
   * The wizard's configure phase runs a `needs_setup` picker row's
   * `configure_command` through this (LLP 0130). The dispatcher always
   * populates it, so it is present for every command body.
   */
  commands: { run(name: string, argv: string[]): Promise<number> }
  /**
   * Verb registry (kernel-owned). Populated by the dispatcher. `hyp mcp`
   * enumerates this to assemble the MCP tool surface; the projected CLI
   * commands are already in the command registry (LLP 0034 §verbs).
   */
  verbs: VerbRegistry
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
  /**
   * Content-bearing columns of a dataset whose rows may lack per-row `cwd`
   * provenance (derived tables that aggregate across sessions, e.g. the
   * context-graph projection). The shared query visibility filter (LLP 0105)
   * suppresses these columns to null on unprovenanced rows when the querying
   * context may not see local-only content; structural columns pass through.
   * Datasets whose rows always carry a `cwd` column need not declare this:
   * the filter withholds by the row's own resolved class instead.
   */
  localOnlyContentColumns?: string[]
  discoverPartitions(ctx: DatasetDiscoveryContext): Promise<QueryPartition[]> | QueryPartition[]
  refreshPartition?(partition: QueryPartition, ctx: DatasetRefreshContext): Promise<DatasetRefreshResult>
  createDataSource(partitions: QueryPartition[], ctx: DatasetDataSourceContext): Promise<AsyncDataSource> | AsyncDataSource
  /**
   * Optional flush-time settlement pass. The kernel calls this once per
   * flush batch (before partition write) with the batch's rows; the
   * dataset may upgrade provisional row identity, drop duplicates, and/or
   * REMOVE a row whose usage policy (a late-resolved `.hypignore` `ignore`)
   * forbids persisting it (LLP 0085), returning the filtered rows to commit.
   * Must be cheap when there is nothing to settle. See LLP 0024.
   */
  settleBatch?(rows: Record<string, unknown>[], ctx: DatasetSettleContext): Promise<Record<string, unknown>[]>
  /**
   * Optional maintenance-time re-settlement pass (LLP 0027 "Re-settle
   * sweep"). The cache compaction calls this over a partition's
   * already-committed fallback rows; the dataset upgrades each to its
   * native identity and returns them WITHOUT dropping any (the rows are
   * already committed, so a committed-`part_id` dedupe would match a
   * non-upgraded fallback against its own copy). Compaction owns the
   * within-rewrite de-twin instead. Distinct from `settleBatch`, whose
   * dedupe assumes the rows are not yet committed.
   */
  resettleBatch?(rows: Record<string, unknown>[], ctx: DatasetSettleContext): Promise<Record<string, unknown>[]>
}

export interface DatasetSettleContext {
  storage: QueryStorageService
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
 * Opaque, versioned continuation token marking a sink's incremental-read
 * watermark: the highest `_hyp_ingest_seq` a `(sink instance, partition)` has
 * durably exported. `seq` is an int64 encoded as a decimal string to dodge
 * bigint/JSON precision hazards. Opaque + versioned so the underlying watermark
 * mechanism can change without invalidating persisted watermarks. See LLP 0040 §2.
 */
export interface SinkContinuation {
  v: 1
  seq: string
}

/** Options for the back-compatible incremental extension to `readRows`. */
export interface ReadRowsOptions {
  /**
   * Yield only rows newer than this watermark (`_hyp_ingest_seq > since.seq`).
   * Absent ⇒ full scan (today's behaviour).
   */
  since?: SinkContinuation
  /**
   * Disposition of pre-upgrade null-seq "legacy" rows when `since` is set.
   * `true` (default) treats them as new (one-time backlog export); `false`
   * treats them as already-exported (skip). A sink passes `false` once it has a
   * durable watermark, so the legacy backlog re-exports exactly once instead of
   * on every tick (LLP 0040 §6 risk #1). No new null-seq row can appear
   * post-upgrade, so excluding them after the first export never skips live data.
   */
  includeLegacy?: boolean
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
  readRows(tablePath: string, columns?: string[], opts?: ReadRowsOptions): AsyncIterable<Record<string, unknown>>
  /**
   * Cursor-aware sibling of `readRows` for sinks that must advance a
   * per-(sink instance, partition) watermark. Pairs each internal-stripped row
   * with the `after` continuation to persist ONCE that row is durably exported.
   * The internal `_hyp_ingest_seq` never reaches the row payload — it is read to
   * derive `after`, then stripped. `after` is a monotonic high-water mark, so a
   * null-seq legacy row carries the prior watermark forward unchanged. See
   * LLP 0040 §2.
   *
   * The element type is a discriminated union so the shared export read can
   * withhold `local-only` rows (LLP 0070 #enforce) without wedging the
   * watermark: a `{ dropped: true }` entry carries the running high-water
   * `after` but **no** row payload — the row was recorded locally and stays
   * locally queryable, but no sink can forward it because the payload never
   * leaves the cache read. Every consumer still advances its cursor across the
   * drop, so a partition tail of withheld rows checkpoints once and is durably
   * passed — not re-scanned each tick, not re-sent if the directory is later
   * un-excluded (LLP 0070 #incremental: drop-but-advance).
   */
  readRowsSince(
    tablePath: string,
    opts: { since?: SinkContinuation; columns?: string[]; includeLegacy?: boolean },
  ): AsyncIterable<
    | { row: Record<string, unknown>; after: SinkContinuation; dropped?: undefined }
    | { row?: undefined; after: SinkContinuation; dropped: true }
  >
}

export interface CachePartitionMeta {
  dataset: string
  partition: Record<string, string>
  path: string
  epoch: number
  rowCount: number
}

// =============================================================================
// Verbs (one declaration → CLI command + MCP tool)
// =============================================================================

/**
 * Where a verb is reachable. The default (`cli+mcp`) projects both a CLI
 * command and an MCP tool. `cli-only` suppresses the tool; `local-only`
 * keeps the tool on the local stdio host but withholds it from the
 * remote/HTTP transport — for operations that shouldn't be remotely
 * invokable. See LLP 0034 §tool-exposure-emergent.
 */
export type VerbExposure = 'cli+mcp' | 'cli-only' | 'local-only'

/**
 * Credential scope a verb's MCP tool requires. `read` (read/compute) is
 * reachable by the query-scoped credential; `operator` (mutating) needs
 * the operator token and is never reachable by a query-scoped client.
 * Gating only applies on an authed (remote/HTTP) transport — the local
 * stdio host is local-user trust and exposes both. See LLP 0034
 * §tool-auth-class.
 */
export type VerbAuthClass = 'read' | 'operator'

/**
 * A single typed input property. A deliberately small JSON-Schema subset
 * — the argv↔schema codec coerces CLI tokens to these types, and the
 * same object is emitted (minus the CLI-only `positional`/`greedy`
 * hints) as the MCP tool's `inputSchema`.
 */
export interface VerbInputProperty {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array'
  description?: string
  enum?: string[]
  default?: string | number | boolean
  minimum?: number
  items?: { type: 'string' | 'integer' | 'number', enum?: string[] }
  /** CLI-only: the final string positional absorbs all remaining tokens (e.g. a SQL string). */
  greedy?: boolean
}

export interface VerbInputSchema {
  type: 'object'
  properties: Record<string, VerbInputProperty>
  required?: string[]
  /** Property names bound to CLI positionals, in order. */
  positional?: string[]
}

/**
 * Local-execution context handed to a verb's `operation`. The CLI and
 * the local MCP host both build this from the kernel runtime; the
 * operation never touches argv or stdout.
 */
export interface VerbOperationContext {
  query: QueryRegistry
  storage: QueryStorageService
  config: HypAwareV2Config
  env: NodeJS.ProcessEnv
  log: PluginLogger
  /** Local cache freshness control (CLI `--refresh`); meaningless remotely. */
  refresh: 'never' | 'auto' | 'always'
  /**
   * The querying context's working directory, for the LLP 0105 visibility
   * filter: the terminal's cwd for a CLI invocation, the spawn directory for
   * a local stdio MCP host. `null` when no caller directory is derivable (a
   * transport that carries none), which the filter treats fail-closed.
   * Verbs whose operation reads content-bearing datasets pass this through
   * to `executeQuerySql` as `callerCwd`.
   */
  callerCwd: string | null
}

/** CLI render controls parsed by the kernel and passed to `render`. */
export interface VerbRenderControls {
  format: 'table' | 'json' | 'jsonl' | 'markdown'
  json: boolean
  output?: string
  maxCell: number
  maxBytes: number
}

/** What a verb's `render` returns; the kernel performs the actual IO. */
export interface VerbRenderResult {
  stdout: string
  stderr?: string
  file?: { path: string, content: string }
  exitCode?: number
}

/**
 * A query-shaped operation — typed params in, structured result out —
 * declared once. The kernel projects a CLI command (argv→params via
 * `inputSchema`, run `operation`, `render` to stdout) and an MCP tool
 * (`inputSchema` + `operation` → structured result) from the same
 * declaration, so the flag set and the JSON Schema can never drift.
 * See LLP 0034 §verbs.
 */
export interface VerbRegistration {
  /** CLI command name, e.g. `'graph neighbors'`. */
  name: string
  /** MCP tool name, e.g. `'graph_neighbors'`. */
  tool: string
  plugin?: PluginName
  summary: string
  inputSchema: VerbInputSchema
  /** Default `'cli+mcp'`. */
  exposure?: VerbExposure
  /** Default `'read'`. */
  authClass?: VerbAuthClass
  /** The shared core. Identical for the CLI and the MCP tool. */
  operation(params: Record<string, unknown>, ctx: VerbOperationContext): Promise<unknown> | unknown
  /** CLI-only: turn a structured result into stdout text + exit code. */
  render(result: any, controls: VerbRenderControls): VerbRenderResult
}

export interface VerbRegistry {
  register(verb: VerbRegistration): void
  get(name: string): VerbRegistration | undefined
  getByTool(tool: string): VerbRegistration | undefined
  list(): VerbRegistration[]
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
 * - register a client `attach()` helper (`registerClient`) so the
 *   shared `hyp attach` CLI can dispatch without coupling core to
 *   client-specific code (the reversing detach is a core disk-driven
 *   undo, not a per-adapter hook);
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
  /**
   * Register a flush-time settlement enricher. The gateway's dataset
   * `settleBatch` hook dispatches fallback rows to the enricher whose
   * `clientName` matches the row's `client_name`, letting an adapter
   * upgrade provisional identity once its native log has caught up. See
   * LLP 0024.
   */
  registerSettlementEnricher(enricher: AiGatewaySettlementEnricher): void
  localEndpoint(opts?: AiGatewayEndpointOptions): string
  /**
   * Look up a registered client by name. Returns `undefined` when no
   * adapter plugin has registered under that name. Used by the shared
   * `hyp attach` command router to dispatch to the right adapter
   * without coupling core to plugin-specific code.
   */
  getClient(name: string): AiGatewayClientRegistration | undefined
  /**
   * Enumerate every registered client. Used by `hyp attach --help`
   * and the walkthrough to list available adapters.
   */
  listClients(): AiGatewayClientRegistration[]
}

/**
 * Adapter-contributed flush-time enricher. Given the selected rows of a
 * flush batch (already filtered to this enricher's `clientName`), it
 * returns them with native identity applied where the adapter's log now
 * supplies it. Rows it cannot match are returned unchanged. The gateway,
 * not the enricher, performs the subsequent `part_id` dedupe.
 *
 * The returned array is positionally parallel to the input. An enricher MAY
 * mark a row for REMOVAL by returning the `UsagePolicyDrop` sentinel
 * (`src/core/usage-policy`) at that row's position - used by the Claude
 * enricher to drop a row whose `cwd`, unknown at capture (the session-start
 * race), resolves late to a `.hypignore` `ignore` (LLP 0085). The removal is
 * honored only by the flush-time `settleBatch`, before partition write; the
 * maintenance `resettleBatch` ignores it, so an already-committed row is never
 * purged.
 */
export interface AiGatewaySettlementEnricher {
  name: string
  clientName: string
  settle(rows: Record<string, unknown>[], ctx: DatasetSettleContext): Promise<Array<Record<string, unknown> | UsagePolicyDrop>>
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

/**
 * An adapter owns only `attach()`. The reversing detach is the single
 * core, disk-driven undo (`detachClientFromDisk`) that both the manual
 * `hyp detach` command and the daemon reconciler's `reverse()` route
 * through, so there is no per-adapter detach for the one undo to drift
 * from.
 *
 * @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [constrained-by] — AiGatewayClientRegistration.detach is retired; the sole undo lives in core
 */
export interface AiGatewayClientRegistration {
  name: string
  defaultUpstream: string
  attach(ctx: AiGatewayClientAttachContext): Promise<void>
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
 *
 * Returning the `USAGE_POLICY_DROP` sentinel is distinct from declining
 * with `undefined`: it is a TERMINAL `.hypignore` usage-policy drop
 * (LLP 0050). The dispatcher stops the projector walk on it (no later
 * projector is consulted) and logs it as an intentional drop, never as
 * a `no_projector_match` miss, while still writing zero rows.
 */
export interface AiGatewayExchangeProjector {
  name: string
  priority?: number
  match(input: AiGatewayExchangeInput): boolean
  project(
    input: AiGatewayExchangeInput,
    ctx: AiGatewayExchangeProjectorContext
  ):
    | AiGatewayProjectedExchange
    | UsagePolicyDrop
    | Promise<AiGatewayProjectedExchange | UsagePolicyDrop | undefined>
    | undefined
}

export interface AiGatewayExchangeProjectorContext {
  log: PluginLogger
  /**
   * Read-only membership test against the gateway's in-memory
   * ignored-session set (LLP 0066). The gateway holds only opaque
   * session-id tokens and answers this set-membership question; the
   * adapter — which alone knows which wire/body field is the canonical
   * `session_id` — resolves that id and, when it is ignored, returns the
   * terminal `USAGE_POLICY_DROP` sentinel. Absent (backfill materialization,
   * unit-test stubs) → treat as `() => false`. @ref LLP 0066#enforcement
   */
  isSessionIgnored?(sessionId: string): boolean
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
 * Provider-defined fields (`provider`, `session_id`, `conversation_id`,
 * identity) are authoritative — the gateway never overrides them when
 * present.
 */
export interface AiGatewayProjectedExchange {
  provider: string
  /**
   * Partition key and session container, always present: the Claude
   * session id or Codex `metadata.session_id`. A session holds the main
   * loop plus N subagent / side-chat threads. (LLP 0030)
   */
  session_id: string
  /**
   * Thread within the session: the Codex thread id, or null for Claude
   * (whose session id lives in `session_id`). Nullable since LLP 0030.
   */
  conversation_id?: string
  conversation_started_at?: string
  conversation_source?: string
  user_id?: string
  cwd?: string
  git_branch?: string
  /** Git remote URL of the session's repo (e.g. `git@github.com:owner/repo.git`); feeds the `Repo`/`File` bridge keys (LLP 0032). */
  git_remote?: string
  /** Full 40-hex HEAD sha at capture time; feeds the `Commit` bridge key (LLP 0032). */
  head_sha?: string
  /** Absolute repo root (`git rev-parse --show-toplevel`); relativizes a touched file's absolute path for the `File` bridge key (LLP 0032). */
  repo_root?: string
  client_name?: string
  client_version?: string
  entrypoint?: string
  user_type?: string
  permission_mode?: string
  is_sidechain?: boolean
  /** Subagent id when the whole exchange belongs to one (e.g. Claude's x-claude-code-agent-id header). */
  agent_id?: string
  /** Parent thread that spawned this subagent thread (e.g. Codex's `parent_thread_id` turn metadata). */
  parent_thread_id?: string
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
 *    `(conversation_id ?? session_id, role, content)` and stamps
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
  /**
   * Per-message model id. Live capture sets one model per exchange (one
   * request, one model) and the gateway stamps it on every row of the
   * exchange, user rows included. A backfilled exchange spans a whole session
   * that can switch models mid-stream, so backfill stamps the model per
   * assistant message instead, mirroring the transcript — which records
   * `message.model` on assistant lines only. Backfilled user-prompt and
   * tool_result rows therefore carry no model (model fidelity in backfill is
   * assistant-output-only). The gateway prefers this per-message value over
   * the exchange `model` when present and falls back to the exchange model
   * otherwise.
   */
  model?: string
  entrypoint?: string
  user_type?: string
  permission_mode?: string
  is_sidechain?: boolean
  /** Subagent id from the provider's native log (e.g. Claude transcript `agentId`). */
  agent_id?: string
  /** Parent thread that spawned this subagent thread (e.g. Codex's `parent_thread_id`). */
  parent_thread_id?: string
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
// Embedder capability (`hypaware.embedder@1.0.0`)
// =============================================================================

/**
 * Text-embedding production, provided by embedder plugins (the first is
 * `@hypaware/embedder-openai`; a local embedder is the intended
 * follow-up). Consumers (`@hypaware/vector-search`) require this
 * capability rather than binding to a specific provider, so swapping
 * embedders is a config change, not a refactor.
 *
 * The same `model` MUST be used at index-build and query time; index
 * consumers store `model` and `dimension` alongside their artifacts and
 * treat a mismatch as staleness (rebuild) or a hard error, never a
 * silent degraded result.
 */
export interface EmbedderCapability {
  /** Stable provider identifier (e.g. `"openai-compatible"`). */
  provider: string
  /** Model identifier sent with every request (e.g. `"text-embedding-3-small"`). */
  model: string
  /**
   * Requested output dimension, when the provider is configured to
   * shorten vectors (e.g. OpenAI v3 models' `dimensions` parameter).
   * Index consumers treat drift between this and a stored artifact's
   * dimension as staleness, exactly like a model change.
   */
  dimensions?: number
  /**
   * Embed a batch of texts. Returns one vector per input text, in input
   * order. Implementations chunk into provider-sized requests
   * internally; callers hand over whatever batch they have.
   */
  embed(texts: string[], opts?: EmbedOptions): Promise<EmbedResult>
}

export interface EmbedOptions {
  signal?: AbortSignal
}

export interface EmbedResult {
  /** One vector per input text, aligned with the input order. */
  vectors: Float32Array[]
  /** Vector length; identical across the batch. */
  dimension: number
  /** Model that actually produced the vectors. */
  model: string
  usage?: EmbedUsage
}

export interface EmbedUsage {
  prompt_tokens?: number
  total_tokens?: number
}

// =============================================================================
// Vector search capability (`hypaware.vector-search@1.0.0`)
// =============================================================================

/**
 * Vector similarity search over cached datasets, provided by
 * `@hypaware/vector-search`. Indexes are declared in config; artifacts
 * are per-host plugin state sharded one file per cache partition.
 */
export interface VectorSearchCapability {
  /** Embed the query text and return the merged top-K across shards. */
  search(opts: VectorSearchOptions): Promise<VectorSearchHit[]>
  /** Per-index, per-partition shard coverage and staleness. */
  status(): Promise<VectorIndexStatus[]>
}

export interface VectorSearchOptions {
  query: string
  /** Restrict to one configured index (default: all indexes). */
  index?: string
  /** Restrict to indexes over one dataset (default: all datasets). */
  dataset?: string
  topK?: number
  /**
   * `auto` (default) refreshes missing/stale shards before searching
   * (declaration, model, and dimension drift all classify stale);
   * `never` searches existing shards only and hard-errors on an
   * embedder model or dimension mismatch.
   */
  refresh?: 'auto' | 'never'
  signal?: AbortSignal
}

export interface VectorSearchHit {
  index: string
  dataset: string
  partition: Record<string, string>
  /** Shard row id (content hash by default, or the index's `id_column` value). */
  id: string
  /** Similarity score; higher is better (cosine over normalized vectors). */
  score: number
  /** Source column text for the hit, when resolvable from the cache. */
  text?: string
}

export interface VectorIndexStatus {
  index: string
  dataset: string
  column: string
  model: string
  shards: VectorShardStatus[]
}

export interface VectorShardStatus {
  partition: Record<string, string>
  state: 'fresh' | 'stale_rows' | 'stale_model' | 'stale_dimension' | 'stale_config' | 'missing' | 'orphan'
  /** Embedded (deduplicated) vector count in the shard, when built. */
  rows?: number
  model?: string
  dimension?: number
  built_at?: string
}

// =============================================================================
// Completion capability (`hypaware.completion@1.0.0`)
// =============================================================================

/**
 * Text generation, provided by completion plugins (the first two are
 * `@hypaware/completion-anthropic` and `@hypaware/completion-openai`).
 * Consumers (e.g. `@hypaware/context-graph-enrich`) require this
 * capability rather than binding to a specific provider, so swapping the
 * model backend is a config decision — which plugin is installed — not a
 * refactor. This is the same separable-capability split as
 * `hypaware.embedder`; a localhost `base_url` keeps generation on-machine.
 *
 * One installed provider serves several models: `complete`/`stream` take
 * a per-request `model` that overrides `defaultModel`, so a single
 * provider can answer both a cheap, high-recall tier and a frontier tier
 * (e.g. Anthropic Haiku vs Opus) by model selection alone.
 */
export interface CompletionCapability {
  /** Stable provider identifier (e.g. `"anthropic"`, `"openai-compatible"`). */
  provider: string
  /** Model used when a request omits `model`. */
  defaultModel: string
  /** One non-streaming generation. */
  complete(req: CompletionRequest, opts?: CompletionOptions): Promise<CompletionResult>
  /**
   * Streaming generation. Yields incremental deltas; the terminal delta
   * carries `stopReason` and `usage`. Providers parse provider-native SSE
   * internally and normalize to `CompletionDelta`.
   */
  stream(req: CompletionRequest, opts?: CompletionOptions): AsyncIterable<CompletionDelta>
  /**
   * Async batch generation, when the provider offers it (Anthropic Message
   * Batches: 50% off, asynchronous, results within ≤24h). Latency-insensitive
   * callers submit many requests at once, poll, and collect. Absent on
   * providers without a batch API — callers feature-detect and fall back to
   * sequential {@link complete}.
   */
  batch?: CompletionBatch
}

/**
 * Provider-neutral batch generation surface (Anthropic Message Batches under
 * the hood). One `submit` enqueues N requests keyed by caller-chosen
 * `customId`; `poll` reports job progress; `results` returns one outcome per
 * `customId` (a normalized {@link CompletionResult} or an error). A `refusal`
 * is a *successful* per-request result with `stopReason: "refusal"`, not an
 * error — the same contract as {@link CompletionCapability.complete}.
 */
export interface CompletionBatch {
  submit(requests: CompletionBatchRequest[], opts?: CompletionOptions): Promise<CompletionBatchStatus>
  poll(id: string, opts?: CompletionOptions): Promise<CompletionBatchStatus>
  results(id: string, opts?: CompletionOptions): Promise<CompletionBatchResult[]>
  cancel?(id: string, opts?: CompletionOptions): Promise<CompletionBatchStatus>
}

export interface CompletionBatchRequest {
  /** Caller-chosen id, echoed on the matching {@link CompletionBatchResult}. Unique within the batch. */
  customId: string
  request: CompletionRequest
}

export interface CompletionBatchStatus {
  id: string
  /** `"in_progress"` while running; `"ended"` once every request is finalized; `"canceling"` after a cancel. */
  status: 'in_progress' | 'ended' | 'canceling' | string
  /** Per-state request tallies, when the provider reports them. */
  counts?: { processing?: number, succeeded?: number, errored?: number, canceled?: number, expired?: number }
}

export interface CompletionBatchResult {
  customId: string
  /** Present when the request succeeded (including a `refusal` stop reason). */
  result?: CompletionResult
  /** Present when the request errored, expired, or was canceled. */
  error?: { type: string, message?: string }
}

export interface CompletionRequest {
  /**
   * Model id; overrides the provider's `defaultModel`. Lets one installed
   * provider serve multiple tiers (e.g. a cheap proposer and a frontier
   * curator).
   */
  model?: string
  /** Optional system prompt. */
  system?: string
  messages: CompletionMessage[]
  /** Hard output ceiling (provider-enforced). */
  max_tokens: number
  /**
   * Tools the model may call. The structured-extraction channel: force a
   * tool (via `toolChoice`) to get schema-shaped output back as a `tool_use`
   * block.
   */
  tools?: CompletionTool[]
  /**
   * Provider-neutral tool-choice control. Each provider translates to its
   * native shape, so a caller forcing structured output stays portable:
   *   - `'auto'` — the model decides whether to call a tool.
   *   - `'required'` — the model must call some tool.
   *   - `{ name }` — the model must call this specific tool.
   * Prefer this over a provider-specific `params.tool_choice`; when both are
   * set, `toolChoice` wins. Leave unset for the provider default.
   */
  toolChoice?: 'auto' | 'required' | { name: string }
  /** JSON-schema structured-output request, when the provider supports it. */
  responseFormat?: JsonValue
  /**
   * Provider-specific passthrough merged into the request body — e.g.
   * Anthropic `thinking` / `output_config.effort`. Portable callers leave
   * this unset and use the neutral fields above.
   */
  params?: JsonObject
}

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | CompletionContentBlock[]
}

/**
 * A content block. `text` carries prose; `tool_use` carries a structured
 * tool call (the channel for structured extraction). Providers normalize
 * native shapes to this union.
 */
export interface CompletionContentBlock {
  type: 'text' | 'tool_use'
  /** Present when `type === 'text'`. */
  text?: string
  /** Tool-call id, present when `type === 'tool_use'`. */
  id?: string
  /** Tool name, present when `type === 'tool_use'`. */
  name?: string
  /** Parsed tool input, present when `type === 'tool_use'`. */
  input?: JsonObject
}

export interface CompletionTool {
  name: string
  description?: string
  /** JSON Schema for the tool's input object. */
  input_schema: JsonObject
}

export interface CompletionOptions {
  signal?: AbortSignal
}

export interface CompletionResult {
  /** The assistant message (text and/or `tool_use` blocks). */
  message: CompletionMessage
  /** Model that actually produced the response. */
  model: string
  /**
   * Why generation stopped (e.g. `"end_turn"`, `"tool_use"`,
   * `"max_tokens"`, `"refusal"`). Callers MUST check for `"refusal"`
   * before trusting `message`.
   */
  stopReason?: string
  usage?: CompletionUsage
}

export interface CompletionDelta {
  /** Incremental text, when this delta carries prose. */
  text?: string
  /** Set on the terminal delta. */
  stopReason?: string
  /** Set on the terminal delta. */
  usage?: CompletionUsage
}

export interface CompletionUsage {
  input_tokens?: number
  output_tokens?: number
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

