export type {
  CommandRegistry,
  CommandRegistration,
  CommandRunContext,
} from '../../../collectivus-plugin-kernel-types'

export declare function createCommandRegistry(): import('../../../collectivus-plugin-kernel-types').CommandRegistry & {
  match(argv: string[]): {
    command: import('../../../collectivus-plugin-kernel-types').CommandRegistration
    prefixLength: number
    rest: string[]
  } | undefined
  has(name: string): boolean
  size(): number
}
