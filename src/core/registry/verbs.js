// @ts-check

import { isVerbProjection, verbToCommand } from '../cli/verb_command.js'
import { Attr, getLogger } from '../observability/index.js'
import { compareStrings } from '../util/compare_strings.js'

/**
 * @import { CommandRegistration, CommandRegistry, PluginName, VerbAuthClass, VerbExposure, VerbRegistration, VerbRegistry } from '../../../hypaware-plugin-kernel-types.js'
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
 * @returns {VerbRegistry & {
 *   unregister: (name: string) => void,
 *   registeringAs: <T>(plugin: PluginName, fn: () => T) => T,
 *   ownerOf: (name: string) => PluginName | undefined,
 *   ownerOfTool: (tool: string) => PluginName | undefined,
 * }}
 * @ref LLP 0034#tool-exposure-emergent [implements]: no central tool gate; the surface is exactly the verbs active plugins register
 */
export function createVerbRegistry(opts = {}) {
  const commandRegistry = opts.commandRegistry
  /** @type {Map<string, VerbRegistration>} */
  const byName = new Map()
  /** @type {Map<string, VerbRegistration>} */
  const byTool = new Map()
  /**
   * The plugin whose activation registered each verb, keyed by the name this
   * registry validated. Written only inside a {@link registeringAs} bracket,
   * so a core verb (`registerCoreVerbs` runs outside one) carries no owner and
   * a plugin-registered one cannot be missing its own.
   *
   * Kept here rather than read back off `VerbRegistration.plugin` for the
   * reason `CommandRegistry.owners` is: the registration is stored by
   * reference and handed back by {@link get}, so that field is a live property
   * the plugin can rewrite after it registered. The per-plugin `ctx.verbs`
   * facade asks this before it lets a plugin release a verb (issue #1983).
   *
   * @type {Map<string, PluginName>}
   */
  const owners = new Map()
  /**
   * The same registrar, keyed by the MCP tool name this registry validated.
   * The two surfaces a verb claims dispatch on different keys: the CLI by verb
   * name, the MCP host by `getByTool(tool)`, so the ledger above answers
   * nothing the tool route can ask (issue #1982). Written and released with
   * its twin, off the same single read of `tool`, rather than derived on
   * demand from `verb.tool`, which is a live plugin property free to answer a
   * neighbour's key.
   *
   * @type {Map<string, PluginName>}
   */
  const toolOwners = new Map()
  /**
   * The plugin currently registering, or `''` outside an activation. Set only
   * by {@link registeringAs}, which brackets a synchronous `register` call,
   * so no two activations can hold it at once however they interleave. The
   * same shape `CommandRegistry` uses, and for the same reason: `verb.plugin`
   * is written by the plugin, and the registration is stored by reference, so
   * that field can answer differently every time it is read.
   */
  let registrar = ''

  /**
   * Run `fn` with `plugin` recorded as the plugin doing the registering. The
   * activation context brackets its own `register` call with this, which is
   * how this registry learns who is calling.
   *
   * @template T
   * @param {PluginName} plugin
   * @param {() => T} fn
   * @returns {T}
   * @ref LLP 0422#verb-owner [implements]: a verb's registrar is recorded by core, so the CLI command it projects is attributable to the plugin whose `operation` will run
   */
  function registeringAs(plugin, fn) {
    const previous = registrar
    registrar = typeof plugin === 'string' ? plugin : ''
    try {
      return fn()
    } finally {
      registrar = previous
    }
  }

  /**
   * The plugin that registered the verb `name`, or `undefined` when core
   * registered it or a host drove this registry itself. The discriminator the
   * per-plugin facade refuses a foreign `unregister` against, and the same
   * value `CommandRegistry.ownerOf` answers for the CLI command this verb
   * projected (LLP 0422 #verb-owner), so the two surfaces a verb claims agree
   * about who owns it.
   *
   * @param {string} name
   * @returns {PluginName | undefined}
   */
  function ownerOf(name) {
    return owners.get(name)
  }

  /**
   * The plugin that registered the verb the MCP tool `tool` dispatches to,
   * or `undefined` when core registered it or a host drove this registry
   * itself. The same answer {@link ownerOf} gives for that verb's name, asked
   * by the key the MCP host actually holds: `hyp mcp` has the registration
   * and the tool it was called by, never the verb name.
   *
   * @param {string} tool
   * @returns {PluginName | undefined}
   * @ref LLP 0425#tool-owner [implements]: the MCP host dispatches on the tool, so the registrar is keyed by the tool too, never derived from the registration's own `tool`
   */
  function ownerOfTool(tool) {
    return toolOwners.get(tool)
  }

  return {
    registeringAs,
    ownerOf,
    ownerOfTool,
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
      // Read once, before any plugin property below can run and re-enter.
      const registeredBy = registrar
      // `operation` and `render` come back as values for the reason `name` and
      // `tool` do: what runs behind the verb has to be what the shape check
      // cleared, and a second read of either is a fresh answer from a plugin
      // property. They are stored below and the projection closes over them.
      const { name, tool, operation, render } = validateVerb(verb)
      if (byName.has(name)) {
        throw new Error(`registerVerb: verb '${name}' already registered`)
      }
      if (byTool.has(tool)) {
        throw new Error(`registerVerb: tool '${tool}' already registered (verb '${name}')`)
      }
      // Project the CLI command so `hyp <verb>` and `hyp --help` work, and do
      // the whole projection *before* the Maps are written, because the two
      // `set`s are the only steps left that cannot fail. Both halves of the
      // line below still can. Building the command runs the registration's
      // accessors; registering it refuses an out-of-range `audience` and an
      // alias that collides with a registered command, and iterates whatever
      // `aliases` answered, so a value that is not iterable throws there.
      // (The same boundary refuses an out-of-range `bootProfile`, but a verb
      // never reaches that one: `verbToCommand` does not project the member,
      // so the registry's own default is the only value it ever sees.) With
      // either half after the `set`s a refusal left this registry holding a
      // verb whose plugin the loader then marked failed: a plugin reported as
      // not loaded and an MCP tool the kernel would still answer, and that one
      // needs no hostile accessor at all. `register` now claims all three
      // namespaces or none of them.
      // Idempotent: a runtime re-created over a shared command registry (or a
      // verb whose name a command already occupies) must not double-register.
      // Registered under the same registrar the verb was, so the projection
      // carries an owner the way a plugin's own command does. It was
      // ownerless (LLP 0420 #consequences), which left the plugin's
      // `operation` reading the whole effective config through a
      // `CommandRunContext` the dispatcher had nobody to narrow for
      // (issue #1978). Core's verbs register outside any bracket and stay
      // ownerless, so the discriminator is still one value and still core's.
      // The projection closes over the validated pair rather than over the
      // registration's live members, so the function `hyp <verb>` runs is the
      // one checked above however the stored record reads by then. That
      // closure is the private storage, which is why there is no `bodyOf` to
      // go with `ownerOf` above: a lookup member would be one more thing the
      // per-plugin facade reads through to, answering with the pair by
      // reference, which is the defect this closes.
      // @ref LLP 0422#verb-owner [implements]: the projected command carries the verb's registrar, so one owner lookup covers a plugin's command and its verb alike
      // @ref LLP 0423#private-body [implements]: the operation dispatch runs is the one the registry validated, held where the registrant cannot reach it
      if (commandRegistry && !commandAlreadyRegistered(commandRegistry, name)) {
        registerProjection(commandRegistry, verbToCommand(verb, name, { operation, render }), registeredBy)
      }
      byName.set(name, verb)
      byTool.set(tool, verb)
      if (registeredBy !== '') {
        owners.set(name, registeredBy)
        toolOwners.set(tool, registeredBy)
      }
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
      // Read before the ledger entry is released below: the retraction at the
      // bottom compares this against the registrar the command registry
      // recorded, and after `owners.delete` the verb's own answer is gone.
      // Not named `registrar`: that is the bracket state this closure holds
      // for `register` to read, and one identifier meaning both "the plugin
      // currently registering" and "the plugin that registered this verb" is
      // how the next line added here reads the wrong one.
      const releasedBy = owners.get(name)
      // One read, so the tool slot released is the one just verified to hold
      // this verb. Reading `verb.tool` again for the delete let a verb pass the
      // identity check against its own slot and delete a *different* plugin's,
      // taking that plugin's MCP tool off the surface. With one read, a verb
      // whose answer has changed since it registered releases nothing at all,
      // which costs it its own slot and nobody else's.
      const tool = verb.tool
      byName.delete(name)
      // The tool ledger goes with the slot, not with the name: a verb whose
      // `tool` has drifted releases neither, so the entry left behind still
      // names the plugin whose verb still holds that slot.
      if (byTool.get(tool) === verb) {
        byTool.delete(tool)
        toolOwners.delete(tool)
      }
      // Released with the name, so a name re-registered later carries the
      // owner of whoever claims it this time. The body goes with the CLI
      // command `retractCommand` takes back, which is the only thing holding
      // the closure it lives in.
      owners.delete(name)
      retractCommand(commandRegistry, name, releasedBy)
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
 * has to be the string the Maps are keyed from. `exposure`, `authClass` and
 * `inputSchema` are read once each for the same reason: a truthiness test and
 * a membership (or `typeof`) test on two reads can pass on a value that is not
 * the one checked.
 *
 * `summary` and `inputSchema` are read again by the projection, which is not a
 * second answer this function can prevent and does not need to: neither is a
 * key, the command registry re-checks its own copy of `summary`, and the whole
 * projection runs ahead of both `set`s, so a divergent second answer costs the
 * registration itself and never another plugin's.
 *
 * `operation` and `render` are returned for a stronger version of the same
 * reason: they are not keys but they are the code the projection runs, and
 * every read of a plugin property is a fresh answer, so the two checked here
 * have to be the two the caller stores. Read again at dispatch, a member that
 * cleared `typeof === 'function'` was free to answer with something else, or
 * with nothing at all, by the time it mattered.
 *
 * @param {VerbRegistration} verb
 * @returns {{ name: string, tool: string, operation: VerbRegistration['operation'], render: VerbRegistration['render'] }}
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
  const inputSchema = verb.inputSchema
  if (!inputSchema || typeof inputSchema !== 'object') {
    throw new TypeError(`registerVerb '${name}': inputSchema is required`)
  }
  const operation = verb.operation
  if (typeof operation !== 'function') {
    throw new TypeError(`registerVerb '${name}': operation() is required`)
  }
  const render = verb.render
  if (typeof render !== 'function') {
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
  return { name, tool, operation, render }
}

/**
 * Register a verb's projected CLI command, inside the command registry's own
 * `registeringAs` bracket when the verb had a registrar to carry.
 *
 * Unbracketed in the two cases that have no plugin behind them: a core verb
 * (`registerCoreVerbs` calls `register` outside any activation) and a command
 * registry a host injected that predates `registeringAs`. Both then land
 * ownerless, which is what they were before and what core's commands are.
 *
 * @param {CommandRegistry & { registeringAs?: (plugin: PluginName, fn: () => void) => void }} registry
 * @param {CommandRegistration} command
 * @param {string} registeredBy the verb's registrar, `''` outside an activation
 */
function registerProjection(registry, command, registeredBy) {
  const bracket = registry.registeringAs
  if (registeredBy === '' || typeof bracket !== 'function') {
    registry.register(command)
    return
  }
  bracket.call(registry, /** @type {PluginName} */ (registeredBy), () => { registry.register(command) })
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
 * whatever `verbToCommand` projected under it. The test is two facts, and
 * neither is a ledger kept here. The first is the mark that projection
 * carries, which says *what* the command is: `register` skips its own
 * projection when the name is already taken, and on the real boot path it
 * always is, because `registerCoreCommands` pre-projects every core verb
 * into the same command registry so `hyp --help` renders before the kernel
 * boots. A ledger of "names *this* registry projected" is empty for exactly
 * the core verbs a host wants to displace, so it would leave `hyp query sql`
 * running the verb the host just took the tool slot from.
 *
 * The second is *whose* it is, which the mark cannot say: it is an
 * enumerable symbol on a record `ctx.commands.get` hands back live, so a
 * plugin can lift it off any real projection and stamp it onto a
 * neighbour's command, then register and release a verb of that name and
 * have this function delete the record it forged (issue #1987). So the
 * released verb's recorded registrar has to agree with the registrar the
 * command registry recorded for the name. Both bindings are written by the
 * kernel inside `registeringAs` brackets, never read off the registration,
 * and the two paths with no plugin behind them agree at `undefined`: a core
 * verb is ownerless and so is the pre-boot core projection it retracts,
 * which is what keeps the host displacement above working.
 *
 * A plugin's own command that merely shares the name is not a projection
 * and survives. Tolerates a command registry that predates `unregister`,
 * the same way {@link commandAlreadyRegistered} tolerates one without
 * `has`: the verb is still released from both maps, the stale CLI command
 * is the only thing left behind. One without `ownerOf`, or without the
 * `registeringAs` bracket that is the only thing that ever fills it,
 * retracts on the mark alone: the tolerance LLP 0420 #owner and LLP 0424
 * #unknown extend to a host's own injected registry, which records no
 * registrar for anything, so there is no binding to read. Both members are
 * tested, because {@link registerProjection} keys its own tolerance on the
 * bracket: against a registry answering an `ownerOf` nothing ever fills,
 * every plugin verb's projection reads ownerless while the verb registry
 * holds the plugin, and the check below would refuse every legitimate
 * release and leave its command behind.
 *
 * The two tolerated branches warn, and so does the refusal. The caller's
 * prescribed
 * success check is `getByTool`, which the map deletion already satisfies,
 * so a half retraction reads as a win while `hyp <verb>` keeps routing at
 * the run closure of the verb the host just displaced. That is the silent
 * local-cache regression LLP 0264 §verb warns about, so it has to name
 * itself in the logs rather than only show up as a wrong answer.
 *
 * @param {(CommandRegistry & {
 *   ownerOf?: (name: string) => PluginName | undefined,
 *   registeringAs?: (plugin: PluginName, fn: () => void) => void,
 * }) | undefined} registry
 * @param {string} name
 * @param {PluginName | undefined} releasedBy the plugin recorded as having
 *   registered the released verb, `undefined` for a core verb or a host
 *   driving this registry directly
 */
function retractCommand(registry, name, releasedBy) {
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
  // The registrar the command registry recorded, never the mark, is what says
  // the projection is this verb's to take back. `owners.set` there runs only
  // inside a `registeringAs` bracket, so unlike the symbol on the record just
  // read, no plugin write can move a name from one answer to another.
  // @ref LLP 0427#two-facts [implements]: the mark says the command is a projection; agreement between the two kernel-recorded registrars says it is the released verb's own
  // Held as values, so the guard below is the one the call runs under: a
  // second read could answer differently on a host registry.
  const ownerOf = registry.ownerOf
  const bracket = registry.registeringAs
  if (typeof ownerOf === 'function' && typeof bracket === 'function') {
    const commandOwner = ownerOf.call(registry, name)
    if (commandOwner !== releasedBy) {
      // Both registrars, not just the name: this warn is the whole signal a
      // squat leaves, and `verb_name` alone cannot say which plugin to
      // remove. The same pair the facade's refusal records
      // (`command.unregister_owner_mismatch`).
      getLogger('verb-registry').warn('verb.retract.registrar_mismatch', {
        [Attr.OPERATION]: 'verb.unregister',
        [Attr.STATUS]: 'degraded',
        [Attr.ERROR_KIND]: 'command_registrar_mismatch',
        [Attr.PLUGIN]: releasedBy ?? '',
        hyp_owner_plugin: commandOwner ?? '',
        verb_name: name,
      })
      return
    }
  }
  registry.unregister(name)
}
