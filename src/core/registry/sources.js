// @ts-check

import { Attr, getKernelInstruments, getLogger, withSpan } from '../observability/index.js'
import { compareStrings } from '../util/compare_strings.js'

/**
 * @import { PluginActivationContext, PluginName, SourceContribution, SourceStatus, StartedSource } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedSourceRegistry } from '../../../src/core/registry/types.js'
 */

/**
 * Build the kernel-side SourceRegistry. The contract surface
 * (`register`/`get`/`list`) matches `hypaware-plugin-kernel-types.d.ts
 * §Sources` and is what plugins see through `ctx.sources`. The kernel
 * additionally drives lifecycle via `start`/`stop`/`reload`/`status`,
 * which wrap the source's `StartedSource` handle in `source.*` spans
 * and tick `hyp_sources_started` so a `hyp status` view can report the
 * active set without reaching into plugin internals, and binds each
 * source to its registering plugin via `registeringAs`/`ownerOf`.
 * Those two are kernel-side like the lifecycle members: they live on
 * `ExtendedSourceRegistry`, not on the plugin-facing contract.
 *
 * @returns {ExtendedSourceRegistry}
 */
// @ref LLP 0012: Source subsystem: registration + kernel-driven lifecycle
export function createSourceRegistry() {
  /** @type {Map<string, SourceContribution>} */
  const contributions = new Map()
  /**
   * The plugin the kernel saw register each source, by the key `register`
   * validated. Only `registeringAs` writes it, so it is the kernel's own
   * record rather than the contribution's claim about itself.
   *
   * @type {Map<string, PluginName>}
   */
  const owners = new Map()
  /** @type {Map<string, StartedSource>} */
  const started = new Map()
  const log = getLogger('sources')
  const instruments = getKernelInstruments()
  /**
   * The plugin currently registering, or `''` outside an activation. Set only
   * by `registeringAs`, which brackets a synchronous `register` call, so no
   * two activations can hold it at once however they interleave.
   */
  let registrar = ''

  /**
   * Run `fn` with `plugin` recorded as the plugin doing the registering. The
   * activation context brackets its own `register` call with this, which is
   * how the registry learns who is calling: `contribution.plugin` is written
   * by the plugin and cannot be that answer (issue #1541).
   *
   * A bracket rather than a `register(plugin, contribution)` overload because
   * the plugin doctor substitutes a registry that wraps `register` and
   * delegates to the real one (`src/core/plugin_doctor/dry_run.js`). A second
   * entry point would route around that wrapper and run the `start()` it
   * exists to keep inert.
   *
   * Restoring the previous value rather than clearing it keeps the outer
   * call's registrar intact when a property read re-enters `register`.
   *
   * @template T
   * @param {PluginName} plugin
   * @param {() => T} fn
   * @returns {T}
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
   * The plugin the kernel recorded as registering `name`, or `undefined` when
   * the source was registered outside an activation (the kernel's own tests
   * and any host driving the registry directly).
   *
   * @param {string} name
   * @returns {PluginName | undefined}
   */
  function ownerOf(name) {
    return owners.get(name)
  }

  /**
   * The plugin a lifecycle emission is labelled with: the kernel's record when
   * it has one, and the contribution's own claim otherwise, which is what a
   * source registered outside an activation has always been labelled with.
   *
   * The record because the `hyp_sources_started` gauge is ticked up by a start
   * and down by its later stop, so a `plugin` property answering differently
   * between the two leaves the gauge holding a label pair nothing decrements.
   *
   * @param {string} name
   * @param {SourceContribution} [contribution]
   * @returns {string}
   */
  function labelPluginOf(name, contribution) {
    const recorded = owners.get(name)
    if (recorded !== undefined) return recorded
    const declared = contribution?.plugin
    return typeof declared === 'string' && declared.length > 0 ? declared : 'unknown'
  }

  // @ref LLP 0012#contribution-surface [implements]: name/plugin/start required, unique source names
  /**
   * `name`, `plugin` and `configSection` are each read once, before the Map is
   * touched, and every later step uses what this registry took.
   *
   * The contribution is stored by reference, so a plugin's `name` is free to be
   * an accessor answering differently each time it is asked, and it is both the
   * key `get()` addresses a source by and the key `list()` orders by. A second
   * read for the `set` is not a refusal a hostile accessor has to beat: it
   * answers an unclaimed name for `contributions.has()` and a claimed one for
   * `contributions.set()`, and so replaces another plugin's source, taking over
   * whatever the kernel starts under that name.
   *
   * `plugin` and `configSection` are read before the `set` for the same reason,
   * even though neither is a key: an accessor raising in the `source.register`
   * record below leaves this registry holding a contribution while the loader
   * marks the plugin's whole activation failed (`src/core/runtime/loader.js`).
   *
   * `plugin` is checked against the registrar rather than taken on trust: the
   * daemon picks the activation context a source starts under from it, so a
   * contribution naming a neighbour was handed that neighbour's config slice,
   * paths, logger, capability handles and permission context, and nothing said
   * so (issue #1541). Refusing at registration, where the two are known to
   * disagree, leaves no half-registered source for the boot walk, the status
   * walk and the doctor's report each to refuse again; it lands as an
   * activation failure like the missing `start()` and the duplicate name
   * below, and reaches a plugin author through `hyp plugin doctor`.
   *
   * @param {SourceContribution} contribution
   */
  function register(contribution) {
    // Read once, before any plugin property can run and re-enter.
    const registeredBy = registrar
    if (!contribution || typeof contribution !== 'object') {
      throw new TypeError('SourceRegistry.register: contribution must be an object')
    }
    const name = contribution.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('SourceRegistry.register: contribution.name must be a non-empty string')
    }
    const plugin = contribution.plugin
    if (typeof plugin !== 'string' || plugin.length === 0) {
      throw new TypeError(`SourceRegistry.register: '${name}' missing plugin`)
    }
    if (registeredBy !== '' && plugin !== registeredBy) {
      log.warn('source.register_plugin_mismatch', {
        [Attr.COMPONENT]: 'sources',
        [Attr.OPERATION]: 'source.register',
        [Attr.ERROR_KIND]: 'source_plugin_mismatch',
        [Attr.PLUGIN]: registeredBy,
        hyp_declared_plugin: plugin,
        hyp_source: name,
        status: 'failed',
      })
      throw new Error(
        `SourceRegistry.register: '${name}' declares plugin '${plugin}' but was registered by '${registeredBy}'`
      )
    }
    if (typeof contribution.start !== 'function') {
      throw new TypeError(`SourceRegistry.register: '${name}' missing start()`)
    }
    if (contributions.has(name)) {
      throw new Error(`SourceRegistry.register: duplicate source name '${name}'`)
    }
    const configSection = contribution.configSection ?? ''
    contributions.set(name, contribution)
    if (registeredBy !== '') owners.set(name, registeredBy)
    log.info('source.register', {
      [Attr.PLUGIN]: plugin,
      hyp_source: name,
      hyp_config_section: configSection,
    })
  }

  /** @param {string} name */
  function get(name) {
    return contributions.get(name)
  }

  /**
   * Every registered contribution, ordered by name.
   *
   * The order comes from the keys, not from `a.name`: the key is the name this
   * registry validated, while `contribution.name` is a live plugin property.
   * Reading it here runs plugin code inside a comparator, where a throw escapes
   * into every caller of `list()` - the daemon's source walk and the plugin
   * doctor's dry run - before a single source has been handed back, and where
   * an accessor that merely stops answering with a string is the same outage,
   * because `compareStrings` refuses a non-string.
   */
  function list() {
    return Array.from(contributions.keys())
      .sort(compareStrings)
      .map((name) => /** @type {SourceContribution} */ (contributions.get(name)))
  }

  /**
   * @param {string} name
   * @param {PluginActivationContext} ctx
   * @returns {Promise<StartedSource>}
   * @ref LLP 0012#observable-lifecycle [implements]: start wraps a source.start span and ticks hyp_sources_started
   */
  async function start(name, ctx) {
    const contribution = contributions.get(name)
    if (!contribution) {
      throw new Error(`SourceRegistry.start: unknown source '${name}'`)
    }
    if (started.has(name)) {
      throw new Error(`SourceRegistry.start: source '${name}' already started`)
    }
    // One read for the span and the counter both, so a single start cannot be
    // spanned under one plugin and counted under another.
    const plugin = labelPluginOf(name, contribution)
    return withSpan(
      'source.start',
      {
        [Attr.COMPONENT]: 'sources',
        [Attr.OPERATION]: 'source.start',
        [Attr.PLUGIN]: plugin,
        hyp_source: name,
        status: 'ok',
      },
      async () => {
        const handle = await contribution.start(ctx)
        if (!handle || typeof handle.stop !== 'function') {
          throw new Error(`SourceRegistry.start: source '${name}' did not return a StartedSource`)
        }
        started.set(name, handle)
        instruments.sourcesStarted.add(1, { hyp_source: name, [Attr.PLUGIN]: plugin })
        return handle
      },
      { component: 'sources' }
    )
  }

  /** @param {string} name */
  async function stop(name) {
    const handle = started.get(name)
    if (!handle) return
    const contribution = contributions.get(name)
    const plugin = labelPluginOf(name, contribution)
    await withSpan(
      'source.stop',
      {
        [Attr.COMPONENT]: 'sources',
        [Attr.OPERATION]: 'source.stop',
        [Attr.PLUGIN]: plugin,
        hyp_source: name,
        status: 'ok',
      },
      async () => {
        try {
          await handle.stop()
        } finally {
          started.delete(name)
          instruments.sourcesStarted.add(-1, { hyp_source: name, [Attr.PLUGIN]: plugin })
        }
      },
      { component: 'sources' }
    )
  }

  /**
   * @param {string} name
   * @param {PluginActivationContext} ctx
   * @ref LLP 0012#reload-context [constrained-by]: reload shares start's ActivationContext; unsupported reload still emits a skipped span
   */
  async function reload(name, ctx) {
    const handle = started.get(name)
    if (!handle) {
      throw new Error(`SourceRegistry.reload: source '${name}' is not started`)
    }
    if (typeof handle.reload !== 'function') {
      // Sources opt-out by omitting reload, surface a span anyway so the
      // operator can grep for "reload requested but not supported."
      const contribution = contributions.get(name)
      await withSpan(
        'source.reload',
        {
          [Attr.COMPONENT]: 'sources',
          [Attr.OPERATION]: 'source.reload',
          [Attr.PLUGIN]: labelPluginOf(name, contribution),
          hyp_source: name,
          status: 'skipped',
        },
        async () => {},
        { component: 'sources' }
      )
      return
    }
    const contribution = contributions.get(name)
    await withSpan(
      'source.reload',
      {
        [Attr.COMPONENT]: 'sources',
        [Attr.OPERATION]: 'source.reload',
        [Attr.PLUGIN]: labelPluginOf(name, contribution),
        hyp_source: name,
        status: 'ok',
      },
      async () => {
        await /** @type {NonNullable<StartedSource['reload']>} */ (handle.reload)(ctx)
      },
      { component: 'sources' }
    )
  }

  /** @param {string} name */
  async function status(name) {
    const handle = started.get(name)
    if (!handle) return undefined
    const contribution = contributions.get(name)
    return withSpan(
      'source.status',
      {
        [Attr.COMPONENT]: 'sources',
        [Attr.OPERATION]: 'source.status',
        [Attr.PLUGIN]: labelPluginOf(name, contribution),
        hyp_source: name,
        status: 'ok',
      },
      async () => {
        if (typeof handle.status === 'function') {
          return handle.status()
        }
        /** @type {SourceStatus} */
        const fallback = { state: 'ready' }
        return fallback
      },
      { component: 'sources' }
    )
  }

  /** @param {string} name */
  function startedOf(name) {
    return started.get(name)
  }

  function listStarted() {
    return Array.from(started.entries()).map(([name, handle]) => ({ name, started: handle }))
  }

  async function stopAll() {
    const names = Array.from(started.keys())
    for (const name of names) {
      try {
        await stop(name)
      } catch {
        // best-effort during shutdown
      }
    }
  }

  return {
    register,
    registeringAs,
    ownerOf,
    get,
    list,
    start,
    stop,
    reload,
    status,
    started: startedOf,
    listStarted,
    stopAll,
  }
}
