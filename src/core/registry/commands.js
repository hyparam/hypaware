// @ts-check

/**
 * @import { CommandRegistration, CommandRegistry } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Build a kernel CommandRegistry that conforms to
 * `collectivus-plugin-kernel-types.d.ts §CLI Commands`.
 *
 * Behavior:
 *
 * - `register` rejects duplicate names. Aliases are surfaced through
 *   `get` so plugins can ship short forms without polluting the
 *   primary command list.
 * - `list` returns commands sorted by name so help renderers are
 *   deterministic across builds.
 * - The registry also exposes a `match(argv)` helper used by the
 *   dispatcher to pick the longest space-separated prefix that has a
 *   registered command. This is the rule that lets `gascity attach`
 *   beat `gascity` when both are registered.
 *
 * @returns {CommandRegistry & {
 *   match: (argv: string[]) => { command: CommandRegistration, prefixLength: number, rest: string[] } | undefined,
 *   has: (name: string) => boolean,
 *   size: () => number,
 * }}
 * @ref LLP 0009#core-owns-dispatch [implements] — core routes argv to the owning command; plugins only register
 */
export function createCommandRegistry() {
  /** @type {Map<string, CommandRegistration>} */
  const byName = new Map()
  /** @type {Map<string, string>} */
  const aliasIndex = new Map()

  /** @param {CommandRegistration} command */
  function register(command) {
    if (!command || typeof command !== 'object') {
      throw new TypeError('CommandRegistry.register: command must be an object')
    }
    if (typeof command.name !== 'string' || command.name.length === 0) {
      throw new TypeError('CommandRegistry.register: command.name must be a non-empty string')
    }
    if (typeof command.summary !== 'string') {
      throw new TypeError(`CommandRegistry.register: '${command.name}' missing summary`)
    }
    if (typeof command.usage !== 'string') {
      throw new TypeError(`CommandRegistry.register: '${command.name}' missing usage`)
    }
    if (typeof command.run !== 'function') {
      throw new TypeError(`CommandRegistry.register: '${command.name}' missing run()`)
    }
    if (byName.has(command.name) || aliasIndex.has(command.name)) {
      throw new Error(`CommandRegistry.register: duplicate command name '${command.name}'`)
    }
    for (const alias of command.aliases ?? []) {
      if (byName.has(alias) || aliasIndex.has(alias)) {
        throw new Error(
          `CommandRegistry.register: alias '${alias}' for '${command.name}' collides with an existing command`
        )
      }
    }
    byName.set(command.name, command)
    for (const alias of command.aliases ?? []) {
      aliasIndex.set(alias, command.name)
    }
  }

  /** @param {string} name */
  function get(name) {
    if (byName.has(name)) return byName.get(name)
    const aliased = aliasIndex.get(name)
    return aliased ? byName.get(aliased) : undefined
  }

  function list() {
    return Array.from(byName.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** @param {string} name */
  function has(name) {
    return byName.has(name) || aliasIndex.has(name)
  }

  function size() {
    return byName.size
  }

  /**
   * Longest-prefix routing. Walk argv collecting space-separated
   * prefixes and pick the longest one that has a registered command
   * (or alias). Returns `{ command, prefixLength, rest }` so the
   * dispatcher can pass the remaining argv to `command.run`.
   *
   * @param {string[]} argv
   */
  function match(argv) {
    if (!Array.isArray(argv) || argv.length === 0) return undefined
    /** @type {{ command: CommandRegistration, prefixLength: number, rest: string[] } | undefined} */
    let best
    let prefix = ''
    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i]
      if (typeof token !== 'string' || token.startsWith('-')) break
      prefix = prefix.length === 0 ? token : `${prefix} ${token}`
      const command = get(prefix)
      if (command) {
        best = {
          command,
          prefixLength: i + 1,
          rest: argv.slice(i + 1),
        }
      }
    }
    return best
  }

  return { register, get, list, has, size, match }
}
