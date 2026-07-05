export type {
  CommandRegistry,
  CommandRegistration,
  CommandRunContext,
} from '../../../hypaware-plugin-kernel-types.d.ts'

export declare function createCommandRegistry(): import('../../../hypaware-plugin-kernel-types.d.ts').CommandRegistry & {
  match(argv: string[]): {
    command: import('../../../hypaware-plugin-kernel-types.d.ts').CommandRegistration
    prefixLength: number
    rest: string[]
  } | undefined
  has(name: string): boolean
  size(): number
}
