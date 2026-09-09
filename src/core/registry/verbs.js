// @ts-check

import { isVerbProjection, verbToCommand } from '../cli/verb_command.js'
import { Attr, getLogger } from '../observability/index.js'
import { compareStrings } from '../util/compare_strings.js'

/**
 * @import { CommandRegistry, VerbAuthClass, VerbExposure, VerbRegistration, VerbRegistry } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * In-memory verb registry. A verb is a query-shaped operation declared
 * **once** that the kernel projects into two surfaces: a CLI command
 * (registered into `commandRegistry` here, immediately) and an MCP tool
 * (assembled on demand by `hyp mcp` from `list()`). Core registers
 * `query_sql`; plugins register their own (e.g. `graph_neighbors`), so the
 * MCP tool surface is **emergent** from the active plugin set with zero
 * core change.
 *
 * @param {{ commandRegistry?: CommandRegistry }} [opts]
 * @returns {VerbRegistry & { unregister: (name: string) => void }}
 * @ref LLP 0034#tool-exposure-emergent [implements]: no central tool gate; the surface is exactly the verbs active plugins register
 */
export function createVerbRegistry(opts = {}) {
  const commandRegistry = opts.commandRegistry
  /** @type {Map<string, VerbRegistration>} */
  const byName = new Map()
  /** @type {Map<string, VerbRegistration>} */
  const byTool = new Map()

  return {
    // A verb claims three namespaces (verb name, MCP tool, CLI command) from
    // two plugin properties, and {@link validateVerb} reads each exactly once
    // before any of them is claimed. The registration is stored by reference,
    // so `verb.name` and `verb.tool` are free to be accessors answering
    // differently each time they are asked, and a second read for the `set` is
    // not a refusal a hostile accessor has to beat: it answers an unclaimed key
    // for `has()` and a claimed one for `set()`, and so displaces a registered
    // verb, or the MCP tool slot of one. A third read decided the name the CLI
    // command projected under, which put a verb in `hyp --help` under a name
    // this registry had not keyed it by.
    register(verb) {
      const { name, tool } = validateVerb(verb)
      if (byName.has(name)) {
        throw new Error(`registerVerb: verb '${name}' already registered`)
      }
      if (byTool.has(tool)) {
        throw new Error(`registerVerb: tool '${tool}' already registered (verb '${name}')`)
      }
      // Project the CLI command so `hyp <verb>` and `hyp --help` work, and do
      // the whole projection *before* the Maps are written, because the two
      // `set`s are the only steps left that cannot fail. Building the command
      // is the last step that runs plugin code, and registering it refuses a
      // colliding alias or an out-of-range `audience`/`bootProfile` read off
      // values the verb supplied, so with either after the `set`s a refused
      // registration left this registry holding a verb whose plugin the loader
      // then marked failed: a plugin reported as not loaded and an MCP tool the
      // kernel would still answer. That one needs no hostile accessor at all.
      // `register` now claims all three namespaces or none of them.
      // Idempotent: a runtime re-created over a shared command registry (or a
      // verb whose name a command already occupies) must not double-register.
      if (commandRegistry && !commandAlreadyRegistered(commandRegistry, name)) {
        commandRegistry.register(verbToCommand(verb, name))
      }
      byName.set(name, verb)
      byTool.set(tool, verb)
    },
    // Release a claimed verb name: both maps, plus the CLI command a verb
    // projection put under that name (and only that one). By-name,
    // idempotent, and a no-op on an unknown name, because the caller that
    // needs it feature-detects it at daemon boot and re-checks `getByTool`
    // after: a throw here would take boot down, and a half-removal would
    // leave the tool slot held and the caller silently degraded.
    // @ref LLP 0264#verb [implements]: a server host displaces the kernel-shipped twin by taking the name back, so archive-backed grep_search keeps the tool slot. LLP 0314#sequencing keeps this displacement rule the bridge until the server's `hypaware` floor rises and it drops its own registration; transitional, not retired.
    unregister(name) {
      const verb = byName.get(name)
      if (!verb) return
      // One read, so the tool slot released is the one just verified to hold
      // this verb. Reading `verb.tool` again for the delete let a verb pass the
      // identity check against its own slot and delete a *different* plugin's,
      // taking that plugin's MCP tool off the surface. With one read, a verb
      // whose answer has changed since it registered releases nothing at all,
      // which costs it its own slot and nobody else's.
      const tool = verb.tool
      byName.delete(name)
      if (byTool.get(tool) === verb) byTool.delete(tool)
      retractCommand(commandRegistry, name)
    },
    get(name) {
      return byName.get(name)
    },
    getByTool(tool) {
      return byTool.get(tool)
    },
    // Ordered by the keys, not by `a.name`: the key is the name this registry
    // validated, while `verb.name` is a live plugin property. Reading it here
    // runs plugin code inside a comparator, where a throw escapes before a
    // single verb has been handed back, and where an accessor that merely stops
    // answering with a string is the same outage, because `compareStrings`
    // refuses a non-string. The one caller is the MCP host assembling its tool
    // list, so that is the whole tool surface.
    list() {
      return Array.from(byName.keys())
        .sort(compareStrings)
        .map((name) => /** @type {VerbRegistration} */ (byName.get(name)))
    },
  }
}

/**
 * Effective exposure of a verb (default `'cli+mcp'`).
 * @param {VerbRegistration} verb
 * @returns {VerbExposure}
 */
export function verbExposure(verb) {
  return verb.exposure ?? 'cli+mcp'
}

/**
 * Effective auth class of a verb (default `'read'`).
 * @param {VerbRegistration} verb
 * @returns {VerbAuthClass}
 */
export function verbAuthClass(verb) {
  return verb.authClass ?? 'read'
}

/**
 * Check a registration and hand back the two keys it claims.
 *
 * The keys are returned rather than left for the caller to read again, because
 * every read of a plugin property is a fresh answer and what is checked here
 * has to be the string the Maps are keyed from. `exposure` and `authClass` are
 * read once each for the same reason: a truthiness test and a membership test
 * on two reads can pass on a value that is not the one checked.
 *
 * @param {VerbRegistration} verb
 * @returns {{ name: string, tool: string }}
 */
function validateVerb(verb) {
  if (!verb || typeof verb !== 'object') {
    throw new TypeError('registerVerb: verb must be an object')
  }
  const name = verb.name
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('registerVerb: verb.name is required')
  }
  const tool = verb.tool
  if (typeof tool !== 'string' || tool.length === 0) {
    throw new TypeError(`registerVerb '${name}': verb.tool is required`)
  }
  if (typeof verb.summary !== 'string') {
    throw new TypeError(`registerVerb '${name}': summary is required`)
  }
  if (!verb.inputSchema || typeof verb.inputSchema !== 'object') {
    throw new TypeError(`registerVerb '${name}': inputSchema is required`)
  }
  if (typeof verb.operation !== 'function') {
    throw new TypeError(`registerVerb '${name}': operation() is required`)
  }
  if (typeof verb.render !== 'function') {
    throw new TypeError(`registerVerb '${name}': render() is required`)
  }
  const exposure = verb.exposure
  if (exposure && !['cli+mcp', 'cli-only', 'local-only'].includes(exposure)) {
    throw new TypeError(`registerVerb '${name}': unknown exposure '${exposure}'`)
  }
  const authClass = verb.authClass
  if (authClass && !['read', 'operator'].includes(authClass)) {
    throw new TypeError(`registerVerb '${name}': unknown authClass '${authClass}'`)
  }
  return { name, tool }
}

/**
 * @param {CommandRegistry & { has?: (name: string) => boolean }} registry
 * @param {string} name
 * @returns {boolean}
 */
function commandAlreadyRegistered(registry, name) {
  if (typeof registry.has === 'function') return registry.has(name)
  return registry.get(name) !== undefined
}

/**
 * Retract the CLI command a released verb name is entitled to, which is
 * whatever `verbToCommand` projected under it. The test is the mark that
 * projection carries, not a ledger kept here: `register` skips its own
 * projection when the name is already taken, and on the real boot path it
 * always is, because `registerCoreCommands` pre-projects every core verb
 * into the same command registry so `hyp --help` renders before the kernel
 * boots. A ledger of "names *this* registry projected" is empty for exactly
 * the core verbs a host wants to displace, so it would leave `hyp query sql`
 * running the verb the host just took the tool slot from.
 *
 * A plugin's own command that merely shares the name is not a projection
 * and survives. Tolerates a command registry that predates `unregister`,
 * the same way {@link commandAlreadyRegistered} tolerates one without
 * `has`: the verb is still released from both maps, the stale CLI command
 * is the only thing left behind.
 *
 * Both tolerated branches warn. The caller's prescribed success check is
 * `getByTool`, which the map deletion already satisfies, so a half
 * retraction reads as a win while `hyp <verb>` keeps routing at the run
 * closure of the verb the host just displaced. That is the silent
 * local-cache regression LLP 0264 §verb warns about, so it has to name
 * itself in the logs rather than only show up as a wrong answer.
 *
 * @param {CommandRegistry | undefined} registry
 * @param {string} name
 */
function retractCommand(registry, name) {
  if (!registry) return
  if (typeof registry.unregister !== 'function') {
    getLogger('verb-registry').warn('verb.retract.unsupported', {
      [Attr.OPERATION]: 'verb.unregister',
      [Attr.STATUS]: 'degraded',
      [Attr.ERROR_KIND]: 'registry_without_unregister',
      verb_name: name,
    })
    return
  }
  const command = registry.get(name)
  if (command === undefined) return
  if (!isVerbProjection(command)) {
    getLogger('verb-registry').warn('verb.retract.not_a_projection', {
      [Attr.OPERATION]: 'verb.unregister',
      [Attr.STATUS]: 'degraded',
      [Attr.ERROR_KIND]: 'command_not_verb_projection',
      verb_name: name,
    })
    return
  }
  registry.unregister(name)
}
