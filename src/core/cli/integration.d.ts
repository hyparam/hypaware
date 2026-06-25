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
  /** Parsed last JSON line of stdout, or null when none was emitted. */
  json: unknown
  stdout: string
  stderr: string
}

export interface ClientResult {
  status: 'ok' | 'failed'
  action: 'attach' | 'detach'
  client: string
  dry_run: boolean
  settings_path?: string
  changed: boolean
  port?: number
  prev_value?: unknown
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
  token: string,
  opts?: IntegrationOptions & { noDaemon?: boolean }
): Promise<CommandResult>
