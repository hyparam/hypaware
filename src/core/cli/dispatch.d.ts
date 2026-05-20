import type { createCommandRegistry } from '../registry/commands.js'
import type { createKernelRuntime } from '../runtime/activation.js'

export interface DispatchOptions {
  stdout?: NodeJS.WriteStream | { write(chunk: string): unknown }
  stderr?: NodeJS.WriteStream | { write(chunk: string): unknown }
  env?: NodeJS.ProcessEnv
  cwd?: string
  workspaceDir?: string
  registry?: ReturnType<typeof createCommandRegistry>
  kernel?: ReturnType<typeof createKernelRuntime>
}

export declare function dispatch(argv: string[], opts?: DispatchOptions): Promise<number>
