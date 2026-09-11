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
    // The copy above is shallow, so `record.aliases` is still the plugin's
    // own value, and iterating it twice puts the same question to a
    // plugin-controlled `Symbol.iterator` with nothing making it answer
    // alike. One that names an unclaimed alias to the collision check and a
    // claimed one to the write overwrites the alias it would have been
    // refused; one that yields cleanly and then throws leaves `byName`
    // holding the command with the alias index half written. Drained once,
    // the names checked are the names written and every step after
    // `byName.set` is total, so a registration claims both indexes or
    // neither.
    //
    // Drained with the loop the two passes already used, not a spread: for a
    // non-iterable `aliases` V8 names the offending value ("number 7 is not
    // iterable"), where a spread names the expression that read it
    // ("(record.aliases ?? []) is not iterable"). Every boundary error here
    // exists to point a plugin author at their own registration, which is the
    // whole reason `copyMiss` below says which member the copy did not carry,
    // so an error naming a registry internal instead of the value passed is
    // the one worth spending a second line to avoid.
    /** @type {string[]} */
    const aliases = []
    for (const alias of record.aliases ?? []) aliases.push(alias)
    // Shape, checked after the drain and not before it: every non-iterable
    // fails this check too, and answering `aliases: 7` here would replace the
    // boundary error the loop above raises, which names the value passed,
    // with one about a list the author never wrote.
    //
    // A string is refused by name because no member rule can catch it:
    // `aliases: 'st'`, the ordinary typo for this field, drains into 's' and
    // 't', which are perfectly good aliases. Unrefused it claims two single
    // letters globally, so the next plugin to register 's' for real is
    // refused with a collision naming a command that never meant to claim it,
    // one activation removed from the typo.
    if (typeof record.aliases === 'string') {
      throw new TypeError(
        `CommandRegistry.register: '${record.name}' has invalid aliases '${record.aliases}' - ` +
          'aliases must be a list of strings, and a bare string is read one character at a time'
      )
    }
    // Named by index and type, never by rendering the member: a boundary
    // error is the plugin author's only feedback, and converting a value they
    // control is the one step here their own code could make throw.
    for (let i = 0; i < aliases.length; i += 1) {
      const alias = aliases[i]
      if (typeof alias !== 'string' || alias.length === 0) {
        throw new TypeError(
          `CommandRegistry.register: '${record.name}' has invalid alias at index ${i} - every alias must ` +
            `be a non-empty string, and this one is ${typeof alias === 'string' ? 'empty' : `of type ${typeof alias}`}`
        )
      }
    }
    for (const alias of aliases) {
      if (byName.has(alias) || aliasIndex.has(alias)) {
        throw new Error(
          `CommandRegistry.register: alias '${alias}' for '${record.name}' collides with an existing command`
        )
      }
    }
    byName.set(record.name, record)
    for (const alias of aliases) {
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
    // Read once, and key the map on what this line validated. Unlike
    // `register` above there is no copy, so `group.name` is a live plugin
    // property: reading it again for the `set` would store the group under a
    // name nothing had checked, which is also the key `listGroups` orders by.
    const name = group.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('CommandRegistry.registerGroup: group.name must be a non-empty string')
    }
    if (group.summary !== undefined && typeof group.summary !== 'string') {
      throw new TypeError(`CommandRegistry.registerGroup: '${name}' summary must be a string when present`)
    }
    if (group.help !== undefined && typeof group.help !== 'string') {
      throw new TypeError(`CommandRegistry.registerGroup: '${name}' help must be a string when present`)
    }
    groups.set(name, group)
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
   *
   * The order comes from the keys, not from `a.name`: the key is the name
   * `registerGroup` validated, while `group.name` is a live property of the
   * plugin's own object, which that function stores by reference. Reading it
   * here would run plugin code inside a comparator, where a throw escapes
   * into every caller of `listGroups()` before a single group has been handed
   * back, and where `compareStrings` refuses a non-string, so an accessor
   * that merely stops answering with a string is the same outage
   * (issue #1555, after #1524 in the dataset registry).
   */
  function listGroups() {
    return Array.from(groups.keys())
      .sort(compareStrings)
      .map((name) => /** @type {CommandGroupRegistration} */ (groups.get(name)))
  }

  /**
   * Every registered command, ordered by name.
   *
   * Ordered by the keys for the reason {@link listGroups} gives, which
   * survives the copy `register` takes: the key is the name validated off
   * that copy, but `get()` hands the copy itself back to the registering
   * plugin during `activate()`, so `record.name` can be redefined as an
   * accessor afterwards. The callers a throw would escape into are
   * `hyp --help`, group help, every dispatch that renders a command list,
   * and the plugin doctor's dry run.
   */
  function list() {
    return Array.from(byName.keys())
      .sort(compareStrings)
      .map((name) => /** @type {CommandRegistration} */ (byName.get(name)))
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
 * that - which is the shape LLP 0329 settled must reach a channel that
 * exists with no telemetry configured, and LLP 0362 admits on a site that
 * refuses nothing, so the warning takes the stderr mirror. It fires only on
 * a registration that lost something, so an ordinary one stays as quiet as
 * it was.
 *
 * Said once the command is in both indexes, never before: everything this
 * line asserts is about a registration that happened, and a refusal for a
 * duplicate name, a colliding alias, or an invalid `audience` still stands
 * between the probe and here.
 *
 * Which is exactly why the say is contained the way {@link copyMiss} contains
 * the probe. There the rule is that a throwing `has` trap costs the warning
 * and never the registration it was only commenting on; here the same rule
 * has to hold from the other side, because this line runs *after* `byName`
 * and the alias index were written. The mirror's `process.stderr.write` is
 * the one step of the emit not already guarded, and a throw escaping it would
 * take `register` down over a command it had just registered: the caller sees
 * a failure, `activatePlugins` files a `plugin.activate_failed`, and the
 * command stays live and dispatchable under a plugin reported as not loaded.
 * A diagnostic may cost itself. It may not cost the thing it describes.
 *
 * The members are named as *declared*, not as stored: `category`, `audience`
 * and `bootProfile` are defaulted a few lines above the probe, so the record
 * does carry a value for them, just not the one the registration declared.
 *
 * @param {string} name the registered command's name
 * @param {string[]} dropped what {@link droppedOptionals} found, possibly none
 * @ref LLP 0362#absence-not-refusal [implements]: the mirror opt-in is admitted on a site that refuses nothing, because the symptom is only the absence
 */
function warnDroppedOptionals(name, dropped) {
  if (dropped.length === 0) return
  const named = dropped.map((key) => `'${key}'`).join(', ')
  try {
    getLogger('command-registry', { mirrorStderr: true }).warn(
      `CommandRegistry.register: '${name}' registered without the declared ${named} - ` +
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
  } catch {
    // Nothing to say it on: the channel that would carry the report is the
    // thing that just failed. The registration stands either way.
  }
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
