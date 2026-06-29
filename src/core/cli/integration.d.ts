import type {
  ClientResult,
  IntegrationCommandResult,
  IntegrationOptions,
} from './types.d.ts'

// `./integration` is a public package entry (see package.json `exports`), so
// its option/result types must stay importable by name from it. The interfaces
// themselves live in `./types.d.ts`; this is the one place a re-export is
// warranted, to hold the public API stable. `CommandResult` keeps its original
// public name here (internally `IntegrationCommandResult`, renamed only to
// avoid colliding with the cli command-result type in `./types.d.ts`).
export type {
  ClientResult,
  IntegrationOptions,
  IntegrationCommandResult as CommandResult,
} from './types.d.ts'

export declare class HypAwareCommandError extends Error {
  constructor(message: string, detail: { code: number; stdout: string; stderr: string; json: unknown })
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
