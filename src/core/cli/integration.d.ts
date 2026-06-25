export interface IntegrationOptions {
  /** State dir; overlays `HYP_HOME` for this call. Defaults to the ambient env. */
  hypHome?: string
  /** Base environment. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Working directory for the command. */
  cwd?: string
  /** Resolve and report what would change without writing anything. */
  dryRun?: boolean
}

export interface CommandResult {
  /** Process-style exit code (0 = success). */
  code: number
  /** Last stdout line that parses as JSON (scanning past trailing non-JSON prose), or null when none does. */
  json: unknown
  stdout: string
  stderr: string
}

/**
 * Parsed `--json` result of an `attach`/`detach` for a single client. The
 * common fields are always present; the remaining fields are the union of
 * what the bundled adapters emit, so which appear depends on the client
 * (`claude` vs `codex`) and the path (attach vs detach, success vs failure).
 * See `hypaware-core/plugins-workspace/{claude,codex}/src/index.js`.
 */
export interface ClientResult {
  status: 'ok' | 'failed'
  action: 'attach' | 'detach'
  client: string
  dry_run: boolean
  changed: boolean
  /** Path to the edited client settings file (claude). */
  settings_path?: string
  /** Path to the edited client config file (codex). */
  config_path?: string
  /** Local gateway port the client was pointed at (attach). */
  port?: number
  /** Base URL written into the client config (codex attach). */
  base_url?: string
  /** Prior value the attach overwrote, when it changed something. */
  prev_value?: unknown
  /** Value removed on detach, when one was present. */
  removed?: string
  /** Prior value restored on detach (codex). */
  restored_value?: string
  /** Non-fatal warning emitted by the adapter. */
  warning?: string
  /** Machine-readable failure category on the error path. */
  error_kind?: string
  /** Human-readable error message on the error path. */
  error?: string
}

export declare class HypAwareCommandError extends Error {
  code: number
  stdout: string
  stderr: string
  json: unknown
}

export declare function run(argv: string[], opts?: IntegrationOptions): Promise<CommandResult>
export declare function attach(client?: string, opts?: IntegrationOptions): Promise<ClientResult>
export declare function detach(client?: string, opts?: IntegrationOptions): Promise<ClientResult>
export declare function join(
  url: string,
  token?: string,
  opts?: Omit<IntegrationOptions, 'dryRun'> & { noDaemon?: boolean }
): Promise<CommandResult>
