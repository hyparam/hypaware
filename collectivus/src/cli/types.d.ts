import type {
  AttachOptions,
  AttachResult,
  CodexAttachOptions,
  CodexAttachResult,
  CodexDetachOptions,
  CodexDetachResult,
  CodexIsAttachedOptions,
  CollectivusConfig,
  DetachOptions,
  DetachResult,
  IsAttachedOptions,
  ListenerFactory,
  ServerConfig,
} from '../types.js'
import type { Signal } from '../upload/upload.js'
import type { DaemonInstallOptions, DaemonUninstallOptions, MacosStatusOptions } from '../daemon/types.d.ts'
import type { ConfigClient } from '../gateway/config_client.js'
import type { EnrollmentStore } from '../server/enrollment.d.ts'
import type { BootstrapStore } from '../server/identity.js'
import type { SkillInstallOptions, SkillInstallResult } from '../skills/types.d.ts'
import type { ConfigRegistry } from '../server/types.d.ts'

// ---------- CLI top-level ----------

export interface HelpResult {
  mode: 'help'
}

export interface VersionResult {
  mode: 'version'
}

export interface ErrorResult {
  mode: 'error'
  message: string
  exitCode: number
}

export interface ConfigResult {
  mode: 'config'
  configPath?: string
  configEnv?: string
  printConfig: boolean
  strict: boolean
}

export type ParseResult = HelpResult | VersionResult | ErrorResult | ConfigResult

export interface HotReloadWiring {
  initialConfig: CollectivusConfig
  configClient: ConfigClient
  factoryBuilder: (cfg: CollectivusConfig) => Map<string, ListenerFactory>
}

/**
 * SIGHUP-driven local reload wiring for the standalone daemon. Lets the
 * `ctvs gascity attach/detach` CLI push a config edit live without a full
 * daemon restart. The handler re-runs the same diff/apply pipeline as the
 * gateway hot-reload path; gascity gets special-cased so per-city changes
 * don't take unrelated cities down.
 */
export interface LocalReloadWiring {
  initialConfig: CollectivusConfig
  factoryBuilder: (cfg: CollectivusConfig) => Map<string, ListenerFactory>
  /** Re-read the config from its original source and validate it. */
  reload: () => Promise<CollectivusConfig>
}

// ---------- CLI export ----------

export interface ExportParseResult {
  help: boolean
  error?: string
  configPath?: string
  outDir?: string
  date?: string
  gatewayId?: string
  signal?: Signal
}

export interface ExportHooks {
  stdout?: { write(chunk: string): unknown }
  stderr?: { write(chunk: string): unknown }
  /** Override for `os.homedir()` when resolving the default config path. */
  homeDir?: string
  loadConfig?: (pathOrUrl: string) => CollectivusConfig | Promise<CollectivusConfig>
}

export interface ExportFileResult {
  rows: number
  bytes: number
  outPath: string
}

export interface ProxyExportResult {
  files: ExportFileResult[]
  /**
   * `'messages'` is emitted when the proxy JSONL contained no messages the
   * walker could extract (request bodies without `messages` and no streamed
   * assistant content). Surfaces the same "nothing to write" signal the old
   * exchange/stream-event split used to.
   */
  skipped: Array<'messages'>
}

export interface ExportJob {
  /** First-level partition value: `gateway_id` under the unified layout. */
  gatewayId: string
  signal: Signal
  date: string
  jsonlPath: string
}

// ---------- CLI collect ----------

export type CollectParseResult =
  | { kind: 'help' }
  | { kind: 'error', message: string, exitCode: 2 }
  | {
    kind: 'add'
    configPath: string
    cacheDir?: string
    filePath?: string
    glob?: string
    name?: string
    replace: boolean
    timestampColumn?: string
    format: 'table' | 'json' | 'jsonl' | 'markdown'
  }
  | {
    kind: 'list'
    configPath: string
    cacheDir?: string
    replace: boolean
    format: 'table' | 'json' | 'jsonl' | 'markdown'
  }
  | {
    kind: 'remove'
    configPath: string
    cacheDir?: string
    nameOrTable?: string
    replace: boolean
    format: 'table' | 'json' | 'jsonl' | 'markdown'
  }

export interface CollectHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  loadConfig?: (pathOrUrl: string) => CollectivusConfig | Promise<CollectivusConfig>
}

// ---------- CLI subcommand parse results / hooks ----------

export interface AttachParseResult {
  configPath?: string
  port?: number
  client?: 'claude' | 'codex' | 'all'
  help: boolean
  error?: string
}

export interface DetachParseResult {
  client: 'claude' | 'codex' | 'all'
  help: boolean
  error?: string
}

export interface StatusParseResult {
  help: boolean
  error?: string
}

export interface InstallParseResult {
  configPath?: string
  yes: boolean
  no: boolean
  help: boolean
  error?: string
}

export interface UninstallParseResult {
  help: boolean
  error?: string
}

export interface SkillsParseResult {
  command: 'install'
  client: 'claude' | 'codex' | 'all'
  force: boolean
  dryRun: boolean
  help: boolean
  error?: string
}

export interface ConfigCliHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  isTTY?: boolean
  prompt?: (q: string) => Promise<string>
  loadConfig?: (p: string) => CollectivusConfig
  readFile?: (p: string) => string
  makeRegistry?: (server: ServerConfig) => ConfigRegistry
  makeBootstrapStore?: (storePath: string) => BootstrapStore
  makeEnrollmentStore?: (storePath: string) => EnrollmentStore
}

export interface ParsedServerConfigSource {
  serverConfig?: string
  serverConfigEnv?: string
}

export interface ParsedHelp {
  kind: 'help'
}

export interface ParsedError {
  kind: 'error'
  message: string
  exitCode: 2
}

export interface ParsedSet extends ParsedServerConfigSource {
  kind: 'set'
  gatewayId: string
  file: string
}

export interface ParsedGet extends ParsedServerConfigSource {
  kind: 'get'
  gatewayId: string
}

export interface ParsedList extends ParsedServerConfigSource {
  kind: 'list'
}

export interface ParsedDelete extends ParsedServerConfigSource {
  kind: 'delete'
  gatewayId: string
  yes: boolean
}

export interface ParsedTokenIssue extends ParsedServerConfigSource {
  kind: 'token-issue'
  gatewayId: string
  ttlSeconds?: number
  maxUses?: number
  rendezvous?: string
  rendezvousToken?: string
}

export interface ParsedTokenRevoke extends ParsedServerConfigSource {
  kind: 'token-revoke'
  gatewayId: string
}

export type ParsedConfigArgs =
  | ParsedHelp
  | ParsedError
  | ParsedSet
  | ParsedGet
  | ParsedList
  | ParsedDelete
  | ParsedTokenIssue
  | ParsedTokenRevoke

export interface WriteStream {
  write(s: string): void
}

export interface AttachHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  version?: string
  /** Override for `os.homedir()` when resolving the default config path. */
  homeDir?: string
  /** CLI path written into managed Claude Code hooks. */
  binPath?: string
  /** Override for `~/.claude/settings.json`. */
  settingsPath?: string
  /** Override for `~/.codex/config.toml`. */
  codexConfigPath?: string
  /** Back-compat alias for attachClaude. */
  attach?: (opts: AttachOptions) => Promise<AttachResult>
  attachClaude?: (opts: AttachOptions) => Promise<AttachResult>
  attachCodex?: (opts: CodexAttachOptions) => Promise<CodexAttachResult>
  loadConfig?: (pathOrUrl: string) => CollectivusConfig | Promise<CollectivusConfig>
  /** Inject a fake skill installer in tests. */
  installSkillBundle?: (opts: SkillInstallOptions) => Promise<SkillInstallResult>
}

export interface DetachHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Override for `~/.claude/settings.json`. */
  settingsPath?: string
  /** Override for `~/.codex/config.toml`. */
  codexConfigPath?: string
  /** Back-compat alias for detachClaude. */
  detach?: (opts?: DetachOptions) => Promise<DetachResult>
  detachClaude?: (opts?: DetachOptions) => Promise<DetachResult>
  detachCodex?: (opts?: CodexDetachOptions) => Promise<CodexDetachResult>
}

export interface StatusHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  plistPath?: string
  logDir?: string
  settingsPath?: string
  /** Default config path used when the LaunchAgent plist doesn't supply one. */
  configPath?: string
  launchAgentStatus?: (opts: MacosStatusOptions) => Promise<{ loaded: boolean, pid?: number }>
  isLaunchAgentInstalled?: (opts: { label: string, plistDir?: string }) => Promise<boolean>
  isAttached?: (opts?: IsAttachedOptions) => Promise<boolean>
  readInstalledPlist?: (plistPath: string) => InstalledPlistFields | undefined
  /** Override for raw read of settings.json (returns undefined on ENOENT). */
  readSettingsRaw?: (p: string) => Promise<string | undefined>
  /** Load and validate a config; throws on parse/validation errors. */
  loadConfig?: (pathOrUrl: string) => CollectivusConfig | Promise<CollectivusConfig>
  /** Stat a file; resolve to undefined when missing. */
  statFile?: (p: string) => Promise<{ size: number, mtimeMs: number } | undefined>
  /** Count `*.jsonl` files under `dir` (recursive). Undefined when dir is missing. */
  countSinkFiles?: (dir: string) => Promise<number | undefined>
  /**
   * Find the most-recently-written `<id>/proxy/<date>.jsonl` under `sinkDir`.
   * Returns the human-relative `name` (e.g. `tester/proxy/2026-05-11.jsonl`)
   * plus its size and mtime. Resolves to undefined when no proxy directories
   * exist yet.
   */
  findLatestProxyFile?: (sinkDir: string) => Promise<{ size: number, mtimeMs: number, name: string } | undefined>
  /** Override for reading the collectivus version from package.json. */
  readVersion?: () => string
}

export interface InitHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Override for `process.argv[1]` in tests. Drives npx-detection. */
  binPath?: string
  /** Override the readline prompt. */
  prompt?: (question: string) => Promise<string>
  /** Override file write. */
  writeFile?: (path: string, contents: string) => void
  /** Override the read used to detect an existing config at the default path. */
  readConfig?: (path: string) => CollectivusConfig | undefined
  /** Override the npx bootstrap global install step. */
  installGlobal?: () => Promise<boolean>
  /** Override lookup of the stable globally installed CLI path. */
  resolveGlobalBinPath?: () => Promise<string>
  /** Override `collectivus install` chain entry. */
  runInstall?: (args: string[], hooks?: InstallHooks) => Promise<number>
  /** Override `ctvs gascity backfill` chain entry. */
  runGascityBackfill?: (args: string[], hooks?: { stdout?: WriteStream, stderr?: WriteStream }) => Promise<number>
  /** Override PATH lookup for the gc binary in tests. */
  hasGcBinary?: () => boolean | Promise<boolean>
  /** Override `process.platform`. */
  platform?: NodeJS.Platform
  /** Override `process.cwd()`. */
  cwd?: string
  /** Override the default `~/.hyp/collectivus.json` save path. */
  defaultConfigPath?: string
  /** Override the default `~/.hyp/collectivus` sink directory. */
  defaultSinkDir?: string
}

export interface InstallHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Override for `process.argv[1]` in tests. */
  binPath?: string
  /** Override for the version recorded in the marker. */
  version?: string
  /** Override for `os.homedir()` when resolving the default config path. */
  homeDir?: string
  /** Override for `~/.hyp/collectivus`. */
  logDir?: string
  /** Forwarded to installDaemon (`~/Library/LaunchAgents` override). */
  plistDir?: string
  /** Override for `~/.claude/settings.json`. */
  settingsPath?: string
  /** Force the TTY decision in tests. */
  isTTY?: boolean
  /** Override the readline prompt. */
  prompt?: (question: string) => Promise<string>
  installLaunchAgent?: (opts: DaemonInstallOptions) => Promise<void>
  attach?: (opts: AttachOptions) => Promise<AttachResult>
  loadConfig?: (pathOrUrl: string) => CollectivusConfig | Promise<CollectivusConfig>
}

export interface UninstallHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Forwarded to uninstallDaemon (`~/Library/LaunchAgents` override). */
  plistDir?: string
  /** Override for `~/.claude/settings.json`. */
  settingsPath?: string
  /** Override for `~/.codex/config.toml`. */
  codexConfigPath?: string
  uninstallLaunchAgent?: (opts: DaemonUninstallOptions) => Promise<void>
  /** Back-compat alias for detachClaude. */
  detach?: (opts?: DetachOptions) => Promise<DetachResult>
  detachClaude?: (opts?: DetachOptions) => Promise<DetachResult>
  detachCodex?: (opts?: CodexDetachOptions) => Promise<CodexDetachResult>
  /** Back-compat alias for isClaudeAttached. */
  isAttached?: (opts?: IsAttachedOptions) => Promise<boolean>
  isClaudeAttached?: (opts?: IsAttachedOptions) => Promise<boolean>
  isCodexAttached?: (opts?: CodexIsAttachedOptions) => Promise<boolean>
}

export interface SkillsHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  homeDir?: string
  codexHome?: string
  sourceDir?: string
  installSkill?: (opts: SkillInstallOptions) => Promise<SkillInstallResult>
}

export type IgnoreParseResult =
  | { help: true, error?: undefined, command?: undefined, path?: undefined }
  | { help?: undefined, error: string, command?: undefined, path?: undefined }
  | { help?: undefined, error?: undefined, command: 'list', path?: undefined }
  | { help?: undefined, error?: undefined, command: 'add', path: string }
  | { help?: undefined, error?: undefined, command: 'remove', path: string }

export interface IgnoreCliHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Override for `process.cwd()`. */
  cwd?: string
  /** Override for `os.homedir()` when resolving the default config path. */
  homeDir?: string
  /** Override the config file path entirely (takes precedence over homeDir). */
  configPath?: string
  /** Inject a pre-built filter for tests. */
  filter?: import('../ignore.js').IgnoreFilter
}

// ---------- CLI admin ----------

export interface AdminConfigFile {
  central_url: string
  admin_token: string
}

export type AdminParseResult =
  | { kind: 'help' }
  | { kind: 'configure-help' }
  | { kind: 'status-help' }
  | { kind: 'clear-help' }
  | { kind: 'error', message: string, exitCode: number }
  | { kind: 'configure', central: string, adminToken: string }
  | { kind: 'status' }
  | { kind: 'clear' }

export interface AdminHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Override for `~`. */
  homeDir?: string
  /** Override the resolved config path entirely (takes precedence over homeDir). */
  configPath?: string
  readAdminConfig?: (configPath: string) => AdminConfigFile | undefined
  writeAdminConfig?: (configPath: string, config: AdminConfigFile) => void
  clearAdminConfig?: (configPath: string) => boolean
}

// ---------- CLI invite ----------

export interface InviteResponseBody {
  joinCode: string
  expiresAt: string
  maxUses: number
  gatewayPrefix: string
  rendezvousUrl: string
  command: string
}

export interface InviteCreateOptions {
  adminUrl?: string
  adminToken?: string
  gatewayPrefix?: string
  maxUses?: number
  ttlSeconds?: number
  displayName?: string
  json: boolean
}

export type InviteParseResult =
  | { kind: 'help' }
  | { kind: 'create-help' }
  | { kind: 'error', message: string, exitCode: number }
  | ({ kind: 'create' } & InviteCreateOptions)

export interface InviteHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Override for `~`. */
  homeDir?: string
  /** Override the resolved admin config path. */
  configPath?: string
  /** Override `process.env` for env-var resolution. */
  env?: NodeJS.ProcessEnv
  /** Override `fetch`. */
  fetchFn?: typeof fetch
  readAdminConfig?: (configPath: string) => AdminConfigFile | undefined
}

export interface InstalledPlistFields {
  /** Path passed via `--config` in ProgramArguments. */
  configPath?: string
  /** Value of `StandardOutPath`. */
  stdoutPath?: string
  /** Value of `StandardErrorPath`. */
  stderrPath?: string
}
