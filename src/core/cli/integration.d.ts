import type {
  ClientResult,
  IntegrationCommandResult,
  IntegrationOptions,
} from './types.d.ts'

export declare class HypAwareCommandError extends Error {
  code: number
  stdout: string
  stderr: string
  json: unknown
}

export declare function run(argv: string[], opts?: IntegrationOptions): Promise<IntegrationCommandResult>
export declare function attach(client?: string, opts?: IntegrationOptions): Promise<ClientResult>
export declare function detach(client?: string, opts?: IntegrationOptions): Promise<ClientResult>
export declare function join(
  url: string,
  token?: string,
  opts?: Omit<IntegrationOptions, 'dryRun'> & { noDaemon?: boolean }
): Promise<IntegrationCommandResult>
