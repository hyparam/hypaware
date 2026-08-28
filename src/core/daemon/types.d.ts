import type {
  BackfillMaterializerRegistry,
  BackfillRegistry,
  CapabilityRegistry,
  HypAwareV2Config,
  QueryRegistry,
  QueryStorageService,
} from '../../../hypaware-plugin-kernel-types.d.ts'
import type { BackfillRunnerContext } from '../commands/types.d.ts'
import type { ActionReconciler, ConfigControlStatus, ConfigLayerDrop, V1Diagnostic } from '../config/types.d.ts'
import type {
  ExtendedSinkRegistry,
  ExtendedSourceRegistry,
} from '../registry/types.d.ts'
import type { KernelRuntime } from '../runtime/types.d.ts'
import type { CommandRunner, DurableBinResult } from '../cli/types.d.ts'
import type { FolderAskMode } from '../usage-policy/types.d.ts'

/**
 * Daemon health states the smoke and `hyp daemon status` rely on.
 *
 * - `starting`: the daemon has written its PID file but has not yet
 *   reported every configured source as up.
 * - `healthy`: every configured source returned a `StartedSource`.
 * - `degraded`: at least one source failed to start or failed status.
 * - `stopping`: SIGTERM/SIGINT received, sources are being shut down.
 * - `stopped`: shutdown completed; status file remains so a parallel
 *   `daemon status` can read the last terminal state.
 */
export type DaemonState = 'starting' | 'healthy' | 'degraded' | 'stopping' | 'stopped'

export interface SourceSnapshot {
  name: string
  plugin: string
  state: 'started' | 'failed' | 'stopped'
  error?: string
  details?: object
}

/**
 * One client surface the running gateway has produced rows for, lifted
 * out of the gateway source's `status()` details in `status.json`.
 *
 * `entrypoint` is verbatim whatever the projector wrote into the row's
 * `entrypoint` column (Codex owns `codex-tui` and whatever Codex Desktop
 * reports; Claude Desktop's 3p route reports `local-agent`). Core never
 * interprets it, which is what keeps this surface client-agnostic.
 */
export interface RecentEntrypoint {
  entrypoint: string
  /** `client_name` last seen with this entrypoint, or null when unset. */
  clientName: string | null
  /** ISO timestamp of the most recent row projected under it. */
  lastSeen: string
  /** Rows projected under it since the daemon booted. */
  rows: number
}

export interface SinkSnapshot {
  instance: string
  plugin: string
  kind: string
  lastTickAt?: string
  lastSuccessAt?: string
  failedOutboxCount?: number
  nextScheduledAt?: string
}

/**
 * Why a maintenance tick deliberately left a partition fragmented instead
 * of rewriting it (LLP 0228#reason-ids-are-span-attribute-names). The ids
 * are the `maintenance.partition` span's attribute names verbatim, which
 * are themselves named after the `MaintenancePartitionReport` fields, so
 * one spelling covers the trace, the status file, `hyp status`, and the
 * daemon log.
 *
 * - `compaction_ineffective`: this writer already rewrote the partition and
 *   reproduced the same file count (LLP 0217#record-effectiveness).
 * - `compaction_attempt_failed`: the one retry the writer generation owed it
 *   was spent by a rewrite that threw (LLP 0218#report-the-spent-attempt).
 *
 * Convergence (LLP 0199#baseline-gate) is not on this list: it is the
 * healthy majority of a cache, not a partition left fragmented.
 */
export type MaintenanceSkipReason = 'compaction_ineffective' | 'compaction_attempt_failed'

/** One partition the last maintenance tick left fragmented, and why. */
export interface MaintenanceSkippedPartition {
  dataset: string
  /** Partition tuple as `k=v/k=v`, or `all` for an unpartitioned dataset. */
  partition: string
  reason: MaintenanceSkipReason
  /**
   * The data-file count the recorded rewrite ran over, not the live one
   * (LLP 0217). Set for `compaction_ineffective` when the cursor records it.
   */
  dataFiles?: number
  /**
   * ISO time the spent attempt failed, as the cursor records it. Set for
   * `compaction_attempt_failed`.
   */
  failedAt?: string
}

/**
 * What the daemon's last completed maintenance tick left alone, summarized
 * for a standing surface (LLP 0228). Overwritten whole by every tick,
 * including one that skipped nothing: a skip reason is a state the tick
 * re-derives from the partition cursor, so only the newest tick's answer is
 * current, and a partition that thaws drops off by itself
 * (LLP 0228#last-tick-only).
 *
 * Absent means no tick has reported (a daemon that has not reached one, or
 * maintenance disabled), which is not the same as "nothing is frozen".
 */
export interface MaintenanceSkipSnapshot {
  /** ISO time of the tick this snapshot describes. */
  tickAt: string
  /** Partitions the tick actually visited (a budget can cut the walk short). */
  partitionsVisited: number
  /** Partitions skipped for a stated reason, all reasons summed. */
  skippedTotal: number
  /** How many partitions each reason accounts for. Zero keys are kept. */
  reasons: Record<MaintenanceSkipReason, number>
  /**
   * The worst of them by name, in walk order (LLP 0199#neediest-first, so
   * descending live data-file count), capped at
   * `MAX_SKIPPED_PARTITIONS_REPORTED`. `skippedTotal` is the true count.
   */
  partitions: MaintenanceSkippedPartition[]
}

export interface DaemonStatus {
  state: DaemonState
  pid: number
  /** ISO timestamp of the daemon process boot. */
  startedAt: string
  /** ISO timestamp the daemon first reached `healthy`. */
  healthyAt?: string
  /** ISO timestamp the daemon transitioned to `stopped`. */
  stoppedAt?: string
  /** Milliseconds since `healthyAt` (0 when not yet healthy). */
  uptimeMs: number
  /** dev_run_id stamped on telemetry from this daemon. */
  runId: string
  /** `foreground` (Phase 3) or `detached` (Phase 4 installers). */
  mode: string
  /** Active config file, when one was resolved. */
  configPath?: string
  sources: SourceSnapshot[]
  sinks: SinkSnapshot[]
  /**
   * What the last completed cache-maintenance tick left fragmented, and why
   * (LLP 0228#status-file-is-the-surface). Absent until a tick has run.
   */
  maintenance?: MaintenanceSkipSnapshot
  warnings?: string[]
}

export type StatusDiagnosticKind =
  | V1Diagnostic['kind']
  | 'config_invalid'
  | 'config_missing'
  | 'config_unreadable'
  | 'config_local_unreadable'
  | 'daemon_binary_missing'
  | 'daemon_loaded_no_pid'
  | 'client_attach_missing'
  | 'client_attach_stale'
  | 'client_telemetry_stale'
  | 'client_telemetry_env_override'
  | 'client_attached_not_configured'
  | 'gateway_port_fallback'
  | 'gateway_idle_no_upstreams'
  | 'gateway_upstreams_dropped'
  | 'recent_errors'
  | 'remote_config_rolled_back'
  | 'local_only_list_unreadable'
  | 'client_sync_list_unreadable'
  | 'maintenance_partitions_skipped'
  | 'capture_gap'

/**
 * Diagnostic surfaced by `hyp status`. Carries a severity, the
 * machine-readable `kind` (so smoke tests can grep for specific
 * conditions), a human-readable `message`, and a list of `repair`
 * commands the operator can copy/paste.
 */
export interface StatusDiagnostic {
  severity: 'error' | 'warning'
  kind: StatusDiagnosticKind
  message: string
  repair: string[]
  pointer?: string
}

/**
 * Which of a bound gateway's dropped upstream names an adapter preset
 * backfilled into the routing table, and which nothing did. Produced by
 * intersecting the dropped names with `details.registered_presets`, both of
 * which the gateway source publishes; the two lists together always account
 * for every dropped name.
 *
 * Both lists are claims about the *table*, not about traffic, because that is
 * the most an intersection of names can support. Routing is by `path_prefix`
 * and `match()`, and then by rank, and none of those are published:
 *
 * `covered` is not "fine" and it is not "proxied" either. The operator's entry
 * did not take effect at all, so the preset's own `base_url`, `provider`,
 * `priority` and routing surface are in force - and where that surface is a
 * `match()` (as it is for every bundled adapter preset) the preset's
 * `path_prefix` is only a sort key, never consulted at match time. The
 * backfilled entry can also be shadowed outright by a surviving config
 * upstream that outranks it, in which case the preset routes nothing.
 *
 * `silent` is scoped to the name, not to the path. A surviving upstream
 * written with no `path_prefix` is the `/` catch-all, so traffic aimed at a
 * silent name can still be proxied and recorded under another upstream's name.
 */
export interface DroppedUpstreamAttribution {
  covered: string[]
  silent: string[]
}

/**
 * Display state of one reconciler client-action, derived for `hyp status`
 * from the persisted marker store (LLP 0036 / 0041) plus the effective
 * config: `hyp status` never runs a pass. A `failed` entry is
 * informational: it never flips `overall` to `degraded` (the gateway runs
 * fine on a valid config, LLP 0041 §failure-is-surfaced-not-fatal).
 *
 * - `done`: run-once effect completed (carries `rows` + `at`).
 * - `failed`: last attempt failed; retried next pass (carries `reason`,
 *   `lastAttempt`, `attempts`).
 * - `refused`: terminal; the reconciler will never retry it on its own,
 *   needs an explicit `hyp attach <requestKey>` re-run to clear (carries
 *   `reason` + `at`, no `attempts`). Informational like `failed`: never
 *   degrades `overall`.
 * - `pending`: desired on this joined host but no marker yet.
 * - `n/a`: suppressed (`on_join: false`) or inert (host never joined).
 */
export type ClientActionState = 'done' | 'failed' | 'pending' | 'n/a' | 'refused'

/** One reconciler action's state for the status surface. */
export interface ClientActionReport {
  /** Handler kind / marker namespace, e.g. `backfill`. */
  kind: string
  /** Request key: the owning plugin name for backfill (LLP 0041). */
  requestKey: string
  state: ClientActionState
  /** Rows imported (on `done`). */
  rows?: number
  /** ISO time the action reached `done`. */
  at?: string
  /** Failure reason (on `failed`). */
  reason?: string
  /** ISO time of the most recent attempt (on `failed`). */
  lastAttempt?: string
  /** Attempts so far (on `failed`). */
  attempts?: number
}

/**
 * Client-action reconciler state (LLP 0036 / 0041) read from the marker
 * file for `hyp status`. The report field is null when nothing applies (no
 * markers and no backfill-configured plugins), so the V1 status surface is
 * unchanged on an ordinary host.
 */
export interface ClientActionsReport {
  actions: ClientActionReport[]
}

/** Per-client attach state probed off the user's home directory. */
export interface ClientAttachReport {
  /** `claude` or `codex`. */
  name: string
  /** The plugin that owns this client (for layer provenance, LLP 0031). */
  plugin: string
  /** Plugin enabled in config. */
  configured: boolean
  /**
   * The client declares an `attach_probe`, so attach is a state that can be
   * observed (and reversed). False for a probe-less client (`claude-desktop`
   * is the only one shipping today, LLP 0115 #no-attach-on-join), whose attach
   * state is not applicable rather than negative: `attached` is then
   * structurally false and means nothing (LLP 0229
   * #status-derives-by-the-same-gate). Read off the descriptor, so a client
   * that gains or loses a probe changes this answer with no core change.
   */
  attachable: boolean
  /** Settings file carries the HypAware marker. Only meaningful when `attachable`. */
  attached: boolean
  /** Path the probe inspected. */
  settingsPath?: string
  /** Adapter version recorded in the marker, when present. */
  version?: string
  /** Local gateway port the adapter routes through, when recorded. */
  port?: string
  /** Attach mode recorded in the marker (`base_url` / `proxy` / `otel`), when present. */
  mode?: string
  /** ISO timestamp the marker records the attach at, when present. */
  attachedAt?: string
  /**
   * Port the marker's managed `OTEL_EXPORTER_OTLP_ENDPOINT` sends telemetry
   * to, when the marker carries one. Distinct from `port` above (the
   * gateway's): in `otel` mode this is the only address capture depends on,
   * and it is what `client_telemetry_stale` compares against the listener's
   * live bind.
   */
  telemetryPort?: number
  /** Probe error string, when the file was unreadable. */
  error?: string
}

/**
 * One otel-attached client's capture health: what its own file trail says it
 * did (`lastTranscriptActivityAt`, the newest activity-probe mtime) held
 * against what the telemetry path actually captured (`lastEventAt`, from the
 * listener source's status.json details). `state` is `gap` when activity ran
 * past the capture baseline by more than the threshold; the paired
 * `capture_gap` diagnostic carries the severity and repair
 * (LLP 0257#status-and-health).
 */
export interface CaptureHealthReport {
  /** Client name (`claude`). */
  client: string
  /** The plugin that owns the client and its listener source. */
  plugin: string
  /** The listener source's snapshot name in status.json, or null when no daemon recorded one. */
  source: string | null
  /** Last telemetry event the listener saw, or null when none is recorded. */
  lastEventAt: string | null
  /** Newest activity-probe file mtime, or null when the trail is empty or unprobed. */
  lastTranscriptActivityAt: string | null
  /** The attach timestamp the marker records, or null when unreadable. */
  attachedAt: string | null
  /**
   * When the live listener started, or null when no daemon is running. The
   * third baseline the gap is measured from: `lastEventAt` is in-process
   * state, so a restart republishes it as null however long capture has been
   * healthy, and without this the gap would be measured from an attach that
   * can be weeks old.
   */
  listenerStartedAt: string | null
  /** Milliseconds of activity past the capture baseline (0 when none). */
  gapMs: number
  state: 'ok' | 'gap'
}

/** Service-level daemon state surfaced by `hyp status`. */
export interface ServiceState {
  /** Service file present at the platform path. */
  installed: boolean
  /** Service registered with launchd/systemd. */
  loaded: boolean
  /** A process is currently running. */
  running: boolean
  /** PID, if running. */
  pid?: number
  /** Last reported daemon state, when a status file exists. */
  state?: DaemonState
  /** dev_run_id of the active daemon process. */
  runId?: string
  /** `foreground` / `detached`. */
  mode?: string
  platform: NodeJS.Platform
  /** Error reading installer state, if any. */
  error?: string
}

/**
 * What proxy-mode capture depends on and nothing else reports: the local
 * CA's identity, whether the login keychain still trusts it (LLP 0237), and
 * whether `NODE_USE_SYSTEM_CA` is live in the launchd user environment
 * (LLP 0239). Both are macOS mechanisms, so this is only ever built on
 * darwin with a CA on disk; see `HypAwareStatusReport.proxyTrust`.
 *
 * `trusted` / `launchdEnvSet` are tri-state on purpose: `null` is "the probe
 * could not run", which is not the same claim as "not trusted".
 */
export interface ProxyTrustReport {
  /** SHA-256 fingerprint of the CA on disk, colon-separated uppercase hex. */
  caFingerprint: string
  /**
   * The CA's permitted `dNSName` subtrees: every host this grant lets the CA
   * vouch for, which is the full provider set and not the subset this install
   * captures (LLP 0238#full-provider-constraints). Empty only for a
   * certificate carrying no dNSName constraints at all. Passed through
   * `displayableCaHosts`, because the bytes come from the certificate on disk
   * rather than from us (LLP 0225): entries are sanitized, and a list longer
   * than any real CA's ends in a `(+N more ...)` entry rather than being
   * silently shortened.
   */
  hosts: string[]
  /** `security verify-cert -p ssl` against the CA, or null when it could not run. */
  trusted: boolean | null
  /** `launchctl getenv NODE_USE_SYSTEM_CA` is `1`, or null when it could not run. */
  launchdEnvSet: boolean | null
  /**
   * Whether an enabled gateway entry in the effective config still carries
   * `proxy_mode: true`, or null when the config could not be read at all.
   * The two probes above cannot tell a CA in live use from residue an old
   * proxy attach left behind, and the advice differs completely: a
   * proxy-mode gateway re-mints this CA on every start and terminates TLS
   * with it, so purging it breaks capture rather than tidying it up. Null is
   * "cannot tell", which a consumer must not read as "proxy_mode is off".
   */
  proxyModeConfigured: boolean | null
}

export interface HypAwareStatusReport {
  configPath: string
  configExists: boolean
  configValid: boolean
  /**
   * Whether anything on this machine records an answer to onboarding's pick
   * question (LLP 0277 #answer-less), as opposed to a config existing only
   * because a writer that never asked one created it. True when the local
   * layer records a pick answer, or when the central layer carries capture of
   * its own (the fleet having answered on the machine's behalf); the bare
   * `@hypaware/central` enrollment seed is not such an answer.
   * `hyp remote add` and the enrolling `hyp remote login` before the first
   * `hyp init` leave `configExists` true and this false; that pair is what the
   * returning gate reads (LLP 0281 #returning-gate).
   */
  configRecordsAnswer: boolean
  activePlugins: string[]
  /**
   * Two-layer provenance (LLP 0031). Null on a host that never joined (a
   * single local layer: the V1 surface is unchanged). When set, the
   * gateway is centrally managed: `centralPlugins` / `centralSinks` name
   * the entries the central layer locks (everything else in
   * `activePlugins` / `sinks` is local), `drops` lists local entries that
   * lost a collision and are not applied, and `centralQueryIgnored` flags
   * a `query` block the central layer tried (and is not allowed) to set.
   */
  layered: {
    hasCentral: true
    centralPlugins: string[]
    centralSinks: string[]
    drops: ConfigLayerDrop[]
    centralQueryIgnored: boolean
  } | null
  daemon: ServiceState
  sources: SourceSnapshot[]
  sinks: SinkSnapshot[]
  clients: ClientAttachReport[]
  /**
   * Picked (configured) clients grouped by two-layer provenance (LLP
   * 0132): `syncing` are the clients the central layer manages (their rows
   * forward to the org sink), `localOnly` are user-added local-layer
   * clients whose rows are collected and locally queryable but never
   * forwarded (LLP 0132 #rule). Null on a solo host with no central layer
   * (nothing is withheld, so the V1 surface is unchanged); a managed host's
   * local addition must never be a silent state (LLP 0132 #never-silent).
   */
  clientSync: { syncing: string[]; localOnly: string[] } | null
  retention: { days: number; source: 'config' | 'default' }
  cache: { totalBytes: number; oldestDate: string | null }
  recentErrorCount: number
  diagnostics: StatusDiagnostic[]
  overall: 'healthy' | 'degraded'
  /**
   * Remote-config apply state (LLP 0025): probation, last rollback +
   * structured reason, remembered bad etag, and the running config's
   * etag. Null only when the probe itself failed; a gateway that has
   * never applied a remote config reports all-null fields.
   */
  remoteConfig: ConfigControlStatus | null
  /**
   * Client-action reconciler state (LLP 0036 / 0041): per-provider
   * backfill-on-join (and future reconciled actions), read from the marker
   * file via `readClientActionStatus`, `hyp status` never runs a pass.
   * Null when nothing applies, so the V1 status surface is unchanged. A
   * `failed` entry is informational and is deliberately excluded from
   * `overall === 'degraded'`.
   */
  clientActions: ClientActionsReport | null
  /**
   * Machine-local `local-only` directory-withholding state (LLP 0069 R9 /
   * LLP 0071): a best-effort count of directories the export seam withholds
   * from forwarding, read from the machine-local exclusion list. Null only
   * when the list itself could not be read or parsed (see the
   * `local_only_list_unreadable` diagnostic) - never a silent zero.
   *
   * `folderAsk` is the standing new-folder ask (LLP 0200): `sync` is the
   * default (unclassified folders sync and nothing interrupts the session),
   * `ask` means the user opted into a session-start question per new folder.
   * It rides here for the same never-silent reason as the count: the default
   * is the mode with data consequences, so it is exactly the one that must
   * not be silent.
   */
  usagePolicy: { localOnlyDirCount: number, folderAsk: FolderAskMode } | null
  /**
   * The pending first-sync export hold's absolute deadline (epoch ms), read
   * from the machine-local marker (LLP 0101). Null whenever no hold is live:
   * never written (a re-login or `hyp join`), already expired, or unreadable
   * - `readFirstSyncDeadline`'s fail-open contract reads all three as absent,
   * matching exactly what the sink driver itself sees before it stops
   * holding ticks. A held machine must never be a silent state (LLP 0100 R9).
   */
  firstSyncHoldDeadline: number | null
  /**
   * Client surfaces the running (or last-run) daemon's gateway produced rows
   * for, most recent first, read from `status.json` (LLP 0164). Empty when no
   * daemon has run for this state root, when the gateway recorded nothing, or
   * when the daemon predates the tracker - `hyp status` activates no plugins
   * and reads no cache, so this is the only place the answer can come from.
   */
  recentEntrypoints: RecentEntrypoint[]
  /**
   * What the daemon's last cache-maintenance tick deliberately left
   * fragmented (LLP 0228). Read from `status.json`, like
   * `recentEntrypoints`: the daemon runs the hourly walk, and `hyp status`
   * activates no plugins and reads no cache, so re-deriving this would mean
   * running a second walk from a status command. Null when no daemon has
   * reported a tick for this state root.
   */
  maintenance: MaintenanceSkipSnapshot | null
  /**
   * Capture health for every otel-attached client (LLP 0257#status-and-health,
   * the RFC 0262 open-question-1 duty): last event seen on the telemetry path
   * vs the client's own last activity. Empty when no configured client is
   * otel-attached, so the pre-otel surface is unchanged. Like
   * `recentEntrypoints` this reads status.json without a liveness gate: a
   * dead daemon's stale `lastEventAt` is exactly the evidence a capture gap
   * is made of.
   */
  captureHealth: CaptureHealthReport[]
  /**
   * Proxy-mode trust state (LLP 0237, LLP 0239). Null whenever the question
   * does not apply: a non-darwin host (both mechanisms are macOS-only, LLP
   * 0237#darwin-only), or no local CA on disk (proxy mode was never on). An
   * absent section is the honest answer there, and a quieter one than an
   * "unknown" a user could not act on.
   */
  proxyTrust: ProxyTrustReport | null
  /**
   * Kernel self-update health (LLP 0309). `line` is null when there is
   * nothing worth surfacing on the text renderer; `json` always carries
   * version, cached auto_update flag, provenance, and the last probe.
   */
  selfUpdate: { line: string | null, json: Record<string, unknown> }
}

export interface CollectStatusOptions {
  env?: NodeJS.ProcessEnv
  /** Optional kernel runtime (already booted by the caller). */
  runtime?: {
    sources?: ExtendedSourceRegistry
    sinks?: ExtendedSinkRegistry
    capabilities?: CapabilityRegistry
    query?: QueryRegistry
    storage?: { cacheRoot: string }
  }
  /** Override platform (tests). */
  platform?: NodeJS.Platform
  /** Override $HOME (tests). */
  homeDir?: string
  /** Absolute path to the daemon binary the installer recorded. */
  binPath?: string
  isLaunchAgentInstalled?: (opts: { label?: string; plistDir?: string; homeDir?: string }) => boolean
  launchAgentStatus?: (opts: { label?: string; launchctl?: LaunchctlAdapter; userDomain?: string; homeDir?: string; platform?: NodeJS.Platform }) => Promise<{ loaded: boolean; pid?: number }>
  isSystemdUnitInstalled?: (opts: { label?: string; unitDir?: string; homeDir?: string }) => boolean
  systemdUnitStatus?: (opts: { label?: string; systemctl?: SystemctlAdapter; homeDir?: string; platform?: NodeJS.Platform }) => Promise<{ loaded: boolean; pid?: number }>
  /** Keychain trust probe (tests, and any caller that must not shell out). */
  isCaTrusted?: (args: { certPath: string }) => Promise<boolean>
  /** Launchd user-environment probe (tests, and any caller that must not shell out). */
  isLaunchdEnvSet?: () => Promise<boolean>
}

export interface SystemctlResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SystemctlAdapter {
  daemonReload(): Promise<SystemctlResult>
  enable(unit: string): Promise<SystemctlResult>
  disable(unit: string): Promise<SystemctlResult>
  start(unit: string): Promise<SystemctlResult>
  stop(unit: string): Promise<SystemctlResult>
  restart(unit: string): Promise<SystemctlResult>
  status(unit: string): Promise<SystemctlResult>
  show(unit: string): Promise<SystemctlResult>
}

export interface BuildUnitOptions {
  label?: string
  description?: string
  nodePath: string
  binPath: string
  configPath: string
  logDir: string
  env?: Record<string, string>
  restart?: boolean
  restartSec?: number
  foreground?: boolean
}

export interface PlanSystemdInstallOptions {
  binPath: string
  configPath: string
  label?: string
  description?: string
  logDir?: string
  nodePath?: string
  homeDir?: string
  unitDir?: string
  env?: Record<string, string>
  restart?: boolean
  restartSec?: number
  foreground?: boolean
}

export interface SystemdInstallPlan {
  platform: 'linux'
  label: string
  unitName: string
  targetPath: string
  content: string
  binPath: string
  configPath: string
  logDir: string
  nodePath: string
  unitDir: string
  manageCommands: string[][]
  /** Result of the npx->durable global-bin upgrade installDaemon ran (if any). */
  globalInstall?: DurableBinResult
}

export interface LaunchctlResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface LaunchctlAdapter {
  bootstrap(args: string[]): Promise<LaunchctlResult>
  bootout(args: string[]): Promise<LaunchctlResult>
  kickstart(args: string[]): Promise<LaunchctlResult>
  print(args: string[]): Promise<LaunchctlResult>
}

export interface BuildPlistOptions {
  label?: string
  nodePath: string
  binPath: string
  configPath: string
  logDir: string
  env?: Record<string, string>
  keepAlive?: boolean
  runAtLoad?: boolean
  foreground?: boolean
}

export interface PlanLaunchAgentInstallOptions {
  binPath: string
  configPath: string
  label?: string
  logDir?: string
  nodePath?: string
  homeDir?: string
  plistDir?: string
  env?: Record<string, string>
  keepAlive?: boolean
  runAtLoad?: boolean
  foreground?: boolean
}

export interface LaunchAgentInstallPlan {
  platform: 'darwin'
  label: string
  targetPath: string
  content: string
  binPath: string
  configPath: string
  logDir: string
  nodePath: string
  plistDir: string
  manageCommands: string[][]
  /** Result of the npx->durable global-bin upgrade installDaemon ran (if any). */
  globalInstall?: DurableBinResult
}

export type DaemonInstallPlan = LaunchAgentInstallPlan | SystemdInstallPlan

/**
 * Override seam for the npx->durable global-bin upgrade installDaemon
 * runs before writing the service unit. Production leaves this unset
 * (process.env / process streams / the real npm runner); tests inject a
 * fake env + runner so no global npm install actually happens.
 */
export interface DurableBinUpgradeSeam {
  env?: NodeJS.ProcessEnv
  stdout?: { write(chunk: string): unknown }
  stderr?: { write(chunk: string): unknown }
  runner?: CommandRunner
}

export interface DaemonInstallOptions {
  /** Absolute path to the HypAware CLI entrypoint. */
  binPath: string
  /**
   * binPath came from an explicit `--bin`, so installDaemon must NOT
   * rewrite it into a durable global bin even if it looks like an
   * `_npx` path (the explicit-bin escape hatch).
   */
  binExplicit?: boolean
  /** Override seam for the npx->durable global-bin upgrade (tests only). */
  durableBin?: DurableBinUpgradeSeam
  /** Config path passed to the daemon (defaults to ~/.hyp/hypaware-config.json). */
  configPath?: string
  /** Override the launch label (defaults to com.hyperparam.hypaware). */
  label?: string
  /** Override stdout/stderr log dir (defaults to ~/.hyp/hypaware/logs). */
  logDir?: string
  /** Override the node binary used as ProgramArguments[0] (defaults to process.execPath). */
  nodePath?: string
  /** Override $HOME for resolving default dirs (used in tests). */
  homeDir?: string
  /** Force platform selection for dry-runs / tests. */
  platform?: NodeJS.Platform
  /** Extra environment variables for the launched daemon. */
  env?: Record<string, string>
  /** macOS: KeepAlive (default true). */
  keepAlive?: boolean
  /** macOS: RunAtLoad (default true). */
  runAtLoad?: boolean
  /** Linux: Restart=always vs Restart=no (default true). */
  restart?: boolean
  /** Linux: RestartSec= seconds (default 5). */
  restartSec?: number
  /** Pass `--foreground` to the daemon (default true). */
  foreground?: boolean
  /** macOS: override LaunchAgents dir. */
  plistDir?: string
  /** Linux: override systemd --user unit dir. */
  unitDir?: string
  /** Linux: override [Unit] Description value. */
  description?: string
  launchctl?: LaunchctlAdapter
  systemctl?: SystemctlAdapter
  /** macOS: override the launchctl user domain (e.g. gui/501). */
  userDomain?: string
  /** Override the poll delay the installers use while waiting (tests only). */
  sleep?: (ms: number) => Promise<void>
}

export interface DaemonUninstallOptions {
  label?: string
  homeDir?: string
  plistDir?: string
  unitDir?: string
  platform?: NodeJS.Platform
  launchctl?: LaunchctlAdapter
  systemctl?: SystemctlAdapter
  userDomain?: string
}

export interface DaemonServiceOptions {
  label?: string
  platform?: NodeJS.Platform
  homeDir?: string
  plistDir?: string
  unitDir?: string
  launchctl?: LaunchctlAdapter
  systemctl?: SystemctlAdapter
  userDomain?: string
}

export interface DaemonHandle {
  /** Resolves with the daemon exit code after shutdown. */
  done: Promise<number>
  /** Trigger an orderly shutdown (SIGTERM-equivalent). */
  stop(): Promise<number>
  /** Read the current in-memory status. */
  snapshot(): DaemonStatus
  /** Trigger a config reload (SIGHUP-equivalent). */
  reload(): Promise<void>
  /**
   * Phase 3 test affordance. The runtime the daemon activated:
   * exposed so smoke flows can drive sink instantiation, dispatch,
   * and per-test setup until config-driven sink setup lands.
   */
  runtime: KernelRuntime
}

export interface RunDaemonOptions {
  /** Override HYP_HOME (defaults from env). */
  hypHome?: string
  /** Explicit config file path. */
  configPath?: string
  env?: NodeJS.ProcessEnv
  /** dev_run_id for telemetry stamping. */
  runId?: string
  /** Sink tick cadence (default 60_000). */
  tickIntervalMs?: number
  /** Default true; smoke flows opt out and drive shutdown directly. */
  installSignalHandlers?: boolean
  /** Phase 3 only supports foreground; surfaced for symmetry with `--foreground`. */
  foreground?: boolean
  /** Temp directory root for sink materialization scratch files. */
  tmpRoot?: string
  /**
   * Injected client-action reconciler (LLP 0041). Defaults to one built with
   * the v1 `[backfillHandler]`; tests pass a fake to drive the boot
   * already-confirmed pass and the confirmation-edge wiring without a real
   * `hyp backfill` subprocess.
   */
  actionReconciler?: ActionReconciler
}

export interface DaemonLogger {
  /** Absolute path to the open log file. */
  path: string
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
  /** Flush all buffered lines and close the file; resolves when durable. */
  close(): Promise<void>
}

export interface PidFileEntry {
  pid: number
  /** ISO timestamp written by the daemon at boot. */
  startedAt: string
  /** dev_run_id stamped on telemetry from this daemon process. */
  runId: string
  /** `foreground` (Phase 3) or `detached` (Phase 4 installers). */
  mode: string
}

/**
 * The runner the sweep driver fires per due contribution: exactly
 * `runBackfillProvider`'s (`src/core/commands/backfill.js`) shape, narrowed to
 * the arguments a sweep passes. Declared as a type rather than taken from the
 * import so the driver can accept an injected fake in a unit test without the
 * test having to stand up a real cache, storage service, and materializer set.
 */
export interface BackfillSweepRunner {
  (args: {
    ctx: BackfillRunnerContext
    provider: string
    dryRun: boolean
    devRunId?: string
  }): Promise<{ ok: boolean, scanned: number, rowsWritten: number, skipped: number }>
}

export interface BackfillSweepDriverOptions {
  backfills: BackfillRegistry
  backfillMaterializers: BackfillMaterializerRegistry
  env: NodeJS.ProcessEnv
  storage: QueryStorageService
  /**
   * Dataset registry. `runBackfillProvider`'s write/flush path
   * (`writeRows`/`flushDataset` in `src/core/commands/backfill.js`) resolves
   * a dataset's registered table path through this before it can commit a
   * row, so a fired sweep run needs it on `BackfillRunnerContext` exactly
   * like `hyp backfill`'s CLI path already gets it from `CommandRunContext`.
   */
  query: QueryRegistry
  /** The daemon's effective config; absent on a host with no readable document. */
  config?: HypAwareV2Config
  /** Test seam: defaults to `runBackfillProvider`. */
  runBackfill?: BackfillSweepRunner
}

export interface BackfillSweepTickOptions {
  /** Tick instant the cron due-check evaluates against. Defaults to `new Date()`. */
  now?: Date
  /** Ignore the cron due-check and fire every sweep-bearing provider (test use). */
  force?: boolean
}

/**
 * What one `tick()` decided, for the caller's telemetry and for tests. Runs are
 * fired unblocked, so `fired` names the providers a run was *started* for, never
 * the ones that finished.
 */
export interface BackfillSweepTickReport {
  fired: string[]
}

export interface BackfillSweepDriver {
  tick(opts?: BackfillSweepTickOptions): Promise<BackfillSweepTickReport>
}

/**
 * One control request the boot-time clear could not remove
 * (`clearControlRequests`), handed to `watchControlRequests` as
 * `staleRequests` so the watcher consumes a matching leftover without
 * dispatching it.
 */
export interface UnclearedRequest {
  /** The file's bytes when readable, else null (matched conservatively). */
  content: string | null
  /** The error that kept the clear from removing the file. */
  message: string
}
