import type {
  HypAwareV2Config,
  CapabilityRegistry,
  QueryRegistry,
} from '../../../hypaware-plugin-kernel-types.d.ts'
import type { ActionReconciler, ConfigControlStatus, ConfigLayerDrop, V1Diagnostic, ConfigValidationError } from '../config/types.d.ts'
import type {
  ExtendedSinkRegistry,
  ExtendedSourceRegistry,
} from '../registry/types.d.ts'
import type { KernelRuntime } from '../runtime/types.d.ts'

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

export interface SinkSnapshot {
  instance: string
  plugin: string
  kind: string
  lastTickAt?: string
  lastSuccessAt?: string
  failedOutboxCount?: number
  nextScheduledAt?: string
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
  | 'recent_errors'
  | 'remote_config_rolled_back'

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
 * Display state of one reconciler client-action, derived for `hyp status`
 * from the persisted marker store (LLP 0036 / 0041) plus the effective
 * config — `hyp status` never runs a pass. A `failed` entry is
 * informational: it never flips `overall` to `degraded` (the gateway runs
 * fine on a valid config, LLP 0041 §failure-is-surfaced-not-fatal).
 *
 * - `done` — run-once effect completed (carries `rows` + `at`).
 * - `failed` — last attempt failed; retried next pass (carries `reason`,
 *   `lastAttempt`, `attempts`).
 * - `pending` — desired on this joined host but no marker yet.
 * - `n/a` — suppressed (`on_join: false`) or inert (host never joined).
 */
export type ClientActionState = 'done' | 'failed' | 'pending' | 'n/a'

/** One reconciler action's state for the status surface. */
export interface ClientActionReport {
  /** Handler kind / marker namespace, e.g. `backfill`. */
  kind: string
  /** Request key — the owning plugin name for backfill (LLP 0041). */
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
  /** Settings file carries the HypAware marker. */
  attached: boolean
  /** Path the probe inspected. */
  settingsPath?: string
  /** Adapter version recorded in the marker, when present. */
  version?: string
  /** Local gateway port the adapter routes through, when recorded. */
  port?: string
  /** Probe error string, when the file was unreadable. */
  error?: string
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

export interface HypAwareStatusReport {
  configPath: string
  configExists: boolean
  configValid: boolean
  activePlugins: string[]
  /**
   * Two-layer provenance (LLP 0031). Null on a host that never joined (a
   * single local layer — the V1 surface is unchanged). When set, the
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
   * file via `readClientActionStatus` — `hyp status` never runs a pass.
   * Null when nothing applies, so the V1 status surface is unchanged. A
   * `failed` entry is informational and is deliberately excluded from
   * `overall === 'degraded'`.
   */
  clientActions: ClientActionsReport | null
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
}

export type DaemonInstallPlan = LaunchAgentInstallPlan | SystemdInstallPlan

export interface DaemonInstallOptions {
  /** Absolute path to the HypAware CLI entrypoint. */
  binPath: string
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
   * Phase 3 test affordance. The runtime the daemon activated —
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
