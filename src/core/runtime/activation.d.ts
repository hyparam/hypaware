import type { PluginActivationContext } from '../../../collectivus-plugin-kernel-types.d.ts'
import type {
  CreateActivationContextArgs,
  CreateKernelRuntimeArgs,
  KernelRuntime,
} from './types.d.ts'

export function createKernelRuntime(opts?: CreateKernelRuntimeArgs): KernelRuntime
export function createActivationContext(args: CreateActivationContextArgs): PluginActivationContext
