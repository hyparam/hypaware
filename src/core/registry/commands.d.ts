export type {
  CommandRegistry,
  CommandRegistration,
  CommandRunContext,
} from '../../../hypaware-plugin-kernel-types.d.ts'

export declare function createCommandRegistry(): import('../../../hypaware-plugin-kernel-types.d.ts').CommandRegistry & {
  match(argv: string[]): {
    command: import('../../../hypaware-plugin-kernel-types.d.ts').CommandRegistration
    invokedName: string
    prefixLength: number
    rest: string[]
  } | undefined
  has(name: string): boolean
  size(): number
  // Pinned as present. `CommandRegistry.unregister` is optional so that a
  // registry injected by an older kernel is a feature-detect and not a
  // boot failure, but the registry this factory builds always has it.
  unregister(name: string): void
}
