// @ts-check

import { verbToCommand } from '../cli/verb_command.js'

/**
 * @import { CommandRegistry, VerbRegistration, VerbRegistry } from '../../../collectivus-plugin-kernel-types.js'
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
 * @returns {VerbRegistry}
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
 * @returns {import('../../../collectivus-plugin-kernel-types.d.ts').VerbExposure}
 */
export function verbExposure(verb) {
  return verb.exposure ?? 'cli+mcp'
}

/**
 * Effective auth class of a verb (default `'read'`).
 * @param {VerbRegistration} verb
 * @returns {import('../../../collectivus-plugin-kernel-types.d.ts').VerbAuthClass}
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
