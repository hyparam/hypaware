export type {
  CommandRegistry,
  CommandRegistration,
  CommandRunContext,
} from '../../../collectivus-plugin-kernel-types.d.ts'

export declare function createCommandRegistry(): import('../../../collectivus-plugin-kernel-types.d.ts').CommandRegistry & {
  match(argv: string[]): {
    command: import('../../../collectivus-plugin-kernel-types.d.ts').CommandRegistration
    prefixLength: number
    rest: string[]
  } | undefined
  has(name: string): boolean
  size(): number
}
