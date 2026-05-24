import type { createCommandRegistry } from '../registry/commands.js'
import type { createKernelRuntime } from '../runtime/activation.js'

export interface DispatchOptions {
  stdout?: NodeJS.WriteStream | { write(chunk: string): unknown }
  stderr?: NodeJS.WriteStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadStream
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Override the local plugin workspace */
  workspaceDir?: string
  registry?: ReturnType<typeof createCommandRegistry>
  kernel?: ReturnType<typeof createKernelRuntime>
}

export declare function dispatch(argv: string[], opts?: DispatchOptions): Promise<number>
