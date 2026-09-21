import type { CommandGroupRegistration, CommandRegistration, PluginName } from '../../../hypaware-plugin-kernel-types.d.ts'

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
  /** Every registered group description, sorted by name. Groups are not in `list()`. */
  listGroups(): CommandGroupRegistration[]
  /**
   * Run `fn` with `plugin` recorded as the plugin doing the registering,
   * so a command registered inside the bracket is bound to its registrar.
   */
  registeringAs<T>(plugin: PluginName, fn: () => T): T
  /**
   * The plugin that registered the command `name` addresses, or `undefined`
   * for a core command, a verb projection, or a host-driven registration.
   */
  ownerOf(name: string): PluginName | undefined
  /**
   * The `run` the command `name` addresses was registered with, or
   * `undefined` when nothing is registered under it. What the dispatcher
   * calls: `get(name).run` is a writable property of a record the
   * registering plugin holds, so it cannot say whose code should execute.
   */
  bodyOf(name: string): CommandRegistration['run'] | undefined
}
