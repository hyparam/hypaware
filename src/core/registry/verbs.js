// @ts-check

import { isVerbProjection, verbToCommand } from '../cli/verb_command.js'
import { Attr, getLogger } from '../observability/index.js'

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
    register(verb) {
      validateVerb(verb)
      if (byName.has(verb.name)) {
        throw new Error(`registerVerb: verb '${verb.name}' already registered`)
      }
      if (byTool.has(verb.tool)) {
        throw new Error(`registerVerb: tool '${verb.tool}' already registered (verb '${verb.name}')`)
      }
      byName.set(verb.name, verb)
      byTool.set(verb.tool, verb)
      // Project the CLI command now so `hyp <verb>` and `hyp --help` work.
      // Idempotent: a runtime re-created over a shared command registry (or
      // a verb whose name a command already occupies) must not double-register.
      if (commandRegistry && !commandAlreadyRegistered(commandRegistry, verb.name)) {
        commandRegistry.register(verbToCommand(verb))
      }
    },
    // Release a claimed verb name: both maps, plus the CLI command a verb
    // projection put under that name (and only that one). By-name,
    // idempotent, and a no-op on an unknown name, because the caller that
    // needs it feature-detects it at daemon boot and re-checks `getByTool`
    // after: a throw here would take boot down, and a half-removal would
    // leave the tool slot held and the caller silently degraded.
    // @ref LLP 0264#verb [implements]: a server host displaces the kernel-shipped twin by taking the name back, so archive-backed grep_search keeps the tool slot
    unregister(name) {
      const verb = byName.get(name)
      if (!verb) return
      byName.delete(name)
      if (byTool.get(verb.tool) === verb) byTool.delete(verb.tool)
      retractCommand(commandRegistry, name)
    },
    get(name) {
      return byName.get(name)
    },
    getByTool(tool) {
      return byTool.get(tool)
    },
    list() {
      return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
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

/** @param {VerbRegistration} verb */
function validateVerb(verb) {
  if (!verb || typeof verb !== 'object') {
    throw new TypeError('registerVerb: verb must be an object')
  }
  if (typeof verb.name !== 'string' || verb.name.length === 0) {
    throw new TypeError('registerVerb: verb.name is required')
  }
  if (typeof verb.tool !== 'string' || verb.tool.length === 0) {
    throw new TypeError(`registerVerb '${verb.name}': verb.tool is required`)
  }
  if (typeof verb.summary !== 'string') {
    throw new TypeError(`registerVerb '${verb.name}': summary is required`)
  }
  if (!verb.inputSchema || typeof verb.inputSchema !== 'object') {
    throw new TypeError(`registerVerb '${verb.name}': inputSchema is required`)
  }
  if (typeof verb.operation !== 'function') {
    throw new TypeError(`registerVerb '${verb.name}': operation() is required`)
  }
  if (typeof verb.render !== 'function') {
    throw new TypeError(`registerVerb '${verb.name}': render() is required`)
  }
  if (verb.exposure && !['cli+mcp', 'cli-only', 'local-only'].includes(verb.exposure)) {
    throw new TypeError(`registerVerb '${verb.name}': unknown exposure '${verb.exposure}'`)
  }
  if (verb.authClass && !['read', 'operator'].includes(verb.authClass)) {
    throw new TypeError(`registerVerb '${verb.name}': unknown authClass '${verb.authClass}'`)
  }
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
 * whatever `verbToCommand` projected under it. The test is identity, not
 * bookkeeping: `register` skips its own projection when the name is
 * already taken, and on the real boot path it always is, because
 * `registerCoreCommands` pre-projects every core verb into the same
 * command registry so `hyp --help` renders before the kernel boots. A
 * ledger of "names *this* registry projected" is empty for exactly the
 * core verbs a host wants to displace, so it would leave `hyp query sql`
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
