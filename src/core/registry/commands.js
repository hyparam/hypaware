// @ts-check

import { Attr, getLogger } from '../observability/index.js'
import { compareStrings } from '../util/compare_strings.js'

/**
 * @import { CommandGroupRegistration, CommandRegistration, CommandRegistry } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Build a kernel CommandRegistry that conforms to
 * `hypaware-plugin-kernel-types.d.ts §CLI Commands`.
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
 *   match: (argv: string[]) => { command: CommandRegistration, invokedName: string, prefixLength: number, rest: string[] } | undefined,
 *   has: (name: string) => boolean,
 *   size: () => number,
 *   unregister: (name: string) => void,
 *   listGroups: () => CommandGroupRegistration[],
 * }}
 * @ref LLP 0009#core-owns-dispatch [implements]: core routes argv to the owning command; plugins only register
 */
export function createCommandRegistry() {
  /** @type {Map<string, CommandRegistration>} */
  const byName = new Map()
  /** @type {Map<string, string>} */
  const aliasIndex = new Map()
  /** @type {Map<string, CommandGroupRegistration>} */
  const groups = new Map()

  /** @param {CommandRegistration} command */
  function register(command) {
    if (!command || typeof command !== 'object') {
      throw new TypeError('CommandRegistry.register: command must be an object')
    }
    // Copy first, then check the copy. A caller's registration is an input,
    // not the registry's storage: the defaulting below has to land somewhere
    // the caller does not own, so a plugin can pass a frozen module-level
    // constant and a registration this function goes on to reject comes back
    // exactly as it arrived.
    //
    // Validating the argument and storing the copy would let the two
    // disagree, because a spread copies own enumerable properties and nothing
    // else: a class instance whose `run()` lives on its prototype passed the
    // shape check here and stored a record with no `run` at all, which
    // surfaces as a TypeError inside dispatch rather than as the boundary
    // error this function exists to raise. Everything below reads `record`
    // for that reason, the shape checks included.
    /** @type {CommandRegistration} */
    const record = { ...command }
    if (typeof record.name !== 'string' || record.name.length === 0) {
      throw new TypeError(
        `CommandRegistry.register: command.name must be a non-empty string${copyMiss(command, record, 'name')}`
      )
    }
    if (typeof record.summary !== 'string') {
      throw new TypeError(
        `CommandRegistry.register: '${record.name}' missing summary${copyMiss(command, record, 'summary')}`
      )
    }
    if (typeof record.usage !== 'string') {
      throw new TypeError(
        `CommandRegistry.register: '${record.name}' missing usage${copyMiss(command, record, 'usage')}`
      )
    }
    if (typeof record.run !== 'function') {
      throw new TypeError(
        `CommandRegistry.register: '${record.name}' missing run()${copyMiss(command, record, 'run')}`
      )
    }
    // Probed here, said below. The probe has to read the copy before the
    // defaulting, or a dropped `category` is papered over by the value
    // derived to replace it; the saying has to wait until the registration
    // has actually landed, because four refusals still stand between here
    // and that, and a WARN that says a command was registered degraded is
    // false about a command the next line refuses outright.
    const dropped = droppedOptionals(command, record)
    // Fill the common metadata at the registry boundary so third-party
    // commands participate without boilerplate. Canonical registrations can
    // override every field; aliases always inherit this one semantic record.
    // @ref LLP 0248#semantic-boot [implements]: category, audience, and boot policy live on the canonical registry entry
    record.category ??= record.plugin ? 'additional' : record.name.split(' ')[0]
    record.audience ??= record.hidden
      ? 'machine'
      : record.category === 'additional'
        ? 'operator'
        : record.category === 'dev'
          ? 'developer'
          : 'everyday'
    record.bootProfile ??= 'config'
    if (record.audience !== undefined && !['everyday', 'operator', 'developer', 'machine'].includes(record.audience)) {
      throw new TypeError(`CommandRegistry.register: '${record.name}' has invalid audience '${record.audience}'`)
    }
    if (record.bootProfile !== undefined && !['config', 'all-available', 'none'].includes(record.bootProfile)) {
      throw new TypeError(`CommandRegistry.register: '${record.name}' has invalid bootProfile '${record.bootProfile}'`)
    }
    if (byName.has(record.name) || aliasIndex.has(record.name)) {
      throw new Error(`CommandRegistry.register: duplicate command name '${record.name}'`)
    }
    for (const alias of record.aliases ?? []) {
      if (byName.has(alias) || aliasIndex.has(alias)) {
        throw new Error(
          `CommandRegistry.register: alias '${alias}' for '${record.name}' collides with an existing command`
        )
      }
    }
    byName.set(record.name, record)
    for (const alias of record.aliases ?? []) {
      aliasIndex.set(alias, record.name)
    }
    warnDroppedOptionals(record.name, dropped)
  }

  /** @param {string} name */
  function get(name) {
    if (byName.has(name)) return byName.get(name)
    const aliased = aliasIndex.get(name)
    return aliased ? byName.get(aliased) : undefined
  }

  /**
   * Release a registered command name. Accepts whatever `get` accepts
   * (the primary name or one of its aliases) and removes the command
   * along with **every** alias pointing at it: an alias left behind
   * would keep the name unclaimable and route argv at a command that is
   * no longer registered.
   *
   * By-name, idempotent, and total on an unknown name, because the one
   * caller that needs it is `VerbRegistry.unregister` retracting the CLI
   * command a verb projected, and that call must never be the thing that
   * takes daemon boot down.
   *
   * @param {string} name
   * @ref LLP 0264#verb [implements]: a verb name claimed on two surfaces has to be releasable on both
   */
  function unregister(name) {
    const primary = byName.has(name) ? name : aliasIndex.get(name)
    if (primary === undefined || !byName.has(primary)) return
    byName.delete(primary)
    for (const [alias, target] of aliasIndex) {
      if (target === primary) aliasIndex.delete(alias)
    }
  }

  /**
   * Describe a command *group* (`graph`, `query`) without registering a
   * command for it. A core group gets its header and paragraph from the
   * bare command `makeGroupCommand` builds; a plugin namespace has no bare
   * command to speak for it, so before this its `--help` was a subcommand
   * table with no prose at all.
   *
   * Registering a group is metadata only: it adds nothing to `list()`, so
   * it can never shadow a real command or appear as its own subcommand.
   * Last writer wins, deliberately, so a plugin re-describing its group on
   * reactivation is not an error.
   *
   * @param {CommandGroupRegistration} group
   * @ref LLP 0214#d2 [implements]: a plugin-owned group carries long help without inventing a bare command
   */
  function registerGroup(group) {
    if (!group || typeof group !== 'object') {
      throw new TypeError('CommandRegistry.registerGroup: group must be an object')
    }
    if (typeof group.name !== 'string' || group.name.length === 0) {
      throw new TypeError('CommandRegistry.registerGroup: group.name must be a non-empty string')
    }
    if (group.summary !== undefined && typeof group.summary !== 'string') {
      throw new TypeError(`CommandRegistry.registerGroup: '${group.name}' summary must be a string when present`)
    }
    if (group.help !== undefined && typeof group.help !== 'string') {
      throw new TypeError(`CommandRegistry.registerGroup: '${group.name}' help must be a string when present`)
    }
    groups.set(group.name, group)
  }

  /** @param {string} name */
  function getGroup(name) {
    return groups.get(name)
  }

  /**
   * Every registered group description, sorted. Group metadata is not in
   * `list()` (a description is not a command), so without this the only way
   * to see what a plugin described is to already know the name. The agreement
   * check between a manifest and what `activate()` registers needs the set,
   * not a lookup.
   */
  function listGroups() {
    return Array.from(groups.values()).sort((a, b) => compareStrings(a.name, b.name))
  }

  function list() {
    return Array.from(byName.values()).sort((a, b) => compareStrings(a.name, b.name))
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
    /** @type {{ command: CommandRegistration, invokedName: string, prefixLength: number, rest: string[] } | undefined} */
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
          invokedName: prefix,
          prefixLength: i + 1,
          rest: argv.slice(i + 1),
        }
      }
    }
    return best
  }

  return { register, registerGroup, unregister, get, getGroup, listGroups, list, has, size, match }
}

/**
 * Every optional member of `CommandRegistration`. The four required ones are
 * refused above by name; these are the ones a silent drop can reach.
 *
 * @type {readonly string[]}
 */
const OPTIONAL_MEMBERS = Object.freeze([
  'plugin',
  'category',
  'audience',
  'bootProfile',
  'group',
  'help',
  'aliases',
  'hidden',
])

/**
 * Which optional members the copy dropped, of those the registration still
 * declares.
 *
 * Read before the defaulting, so a dropped `category` is reported rather than
 * papered over by the value derived to replace it. Presence-only, by reusing
 * the same probe: naming a member must not run the accessor that provides it,
 * which is the whole reason {@link copyMiss} reads `in`.
 *
 * @param {CommandRegistration} command the registration as passed
 * @param {CommandRegistration} record the own-enumerable copy the checks read
 * @returns {string[]} the dropped member names, in declaration order
 */
function droppedOptionals(command, record) {
  return OPTIONAL_MEMBERS.filter((key) => copyMiss(command, record, key) !== '')
}

/**
 * Say that the copy dropped an optional member the registration still
 * declares.
 *
 * {@link copyMiss} explains the same loss where a required member makes it a
 * refusal. An optional one fails no shape check, so there is no refusal to
 * hang the diagnosis on: registration succeeds and the command runs without
 * it. Every symptom is an absence - the alias index gets nothing, a command
 * that asked to be `hidden` lists in `hyp --help`, and a lost `plugin`
 * re-derives `category` from the command's own name and `audience` from
 * that - which is exactly the shape LLP 0329 settled must reach a channel
 * that exists with no telemetry configured, so the warning takes the stderr
 * mirror. It fires only on a registration that lost something, so an ordinary
 * one stays as quiet as it was.
 *
 * Said once the command is in both indexes, never before: everything this
 * line asserts is about a registration that happened, and a refusal for a
 * duplicate name, a colliding alias, or an invalid `audience` still stands
 * between the probe and here.
 *
 * @param {string} name the registered command's name
 * @param {string[]} dropped what {@link droppedOptionals} found, possibly none
 * @ref LLP 0329#stderr-mirror [implements]: a degradation observable only as an absence opts into the mirror
 */
function warnDroppedOptionals(name, dropped) {
  if (dropped.length === 0) return
  const named = dropped.map((key) => `'${key}'`).join(', ')
  getLogger('command-registry', { mirrorStderr: true }).warn(
    `CommandRegistry.register: '${name}' registered without ${named} - ` +
      'reachable on the registration but not an own enumerable property, so the ' +
      "registry's copy did not carry it (a prototype member, or one defined non-enumerable)",
    {
      [Attr.OPERATION]: 'command.register',
      [Attr.STATUS]: 'degraded',
      [Attr.ERROR_KIND]: 'optional_member_not_copied',
      command_name: name,
      dropped_members: dropped.join(','),
    }
  )
}

/**
 * Explain a shape check the stored record failed but the registration as
 * passed would have satisfied. The record is `{ ...command }`, which carries
 * own enumerable properties and nothing else, so a member living on a
 * prototype (a class instance, an `Object.create` registration) or defined
 * non-enumerable is simply not in what the checks read.
 *
 * The published `CommandRegistration` type cannot warn about it up front:
 * TypeScript has no notion of property ownership or enumerability, so a class
 * whose `run()` sits on the prototype compiles clean under `--strict`. And a
 * plugin whose `activate()` throws is caught per plugin and logged as
 * `plugin.activate_failed`, so the plugin simply does not load. That leaves
 * this clause as the whole diagnosis its author gets, and a bare
 * `missing run()` about a registration that visibly declares `run()` sends
 * them looking in the wrong place.
 *
 * @param {CommandRegistration} command the registration as passed
 * @param {CommandRegistration} record the own-enumerable copy the checks read
 * @param {string} key the member the check rejected
 * @returns {string} a clause to append, or '' when the member is genuinely
 *   absent and there is nothing to explain
 */
function copyMiss(command, record, key) {
  if (key in record) return ''
  // Presence, not value. Reading `command[key]` would run a prototype
  // accessor, and a class instance is one of the shapes this clause exists to
  // diagnose: a lazily-initializing getter would fire on a path that rejects,
  // against the promise above that a rejected registration comes back exactly
  // as it arrived, and a throwing one would replace this boundary error with
  // its own, which is the opposite of what this function is for. `in` walks
  // the chain without invoking anything, and the `has` trap of a Proxy
  // registration, the one thing left that can object, does not get to break
  // the error either.
  try {
    if (!(key in /** @type {any} */ (command))) return ''
  } catch {
    return ''
  }
  return (
    ` - '${key}' is reachable on the registration but is not an own enumerable property, ` +
    "so the registry's copy did not carry it (a prototype member, or one defined non-enumerable)"
  )
}
