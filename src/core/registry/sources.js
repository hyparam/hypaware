// @ts-check

import { Attr, getKernelInstruments, getLogger, withSpan } from '../observability/index.js'

/**
 * @import { PluginActivationContext, SourceContribution, SourceRegistry, SourceStatus, StartedSource } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedSourceRegistry } from './types.d.ts'
 */

/**
 * Build the kernel-side SourceRegistry. The contract surface
 * (`register`/`get`/`list`) matches `collectivus-plugin-kernel-types.d.ts
 * §Sources` and is what plugins see through `ctx.sources`. The kernel
 * additionally drives lifecycle via `start`/`stop`/`reload`/`status`,
 * which wrap the source's `StartedSource` handle in `source.*` spans
 * and tick `hyp_sources_started` so a `hyp status` view can report the
 * active set without reaching into plugin internals.
 *
 * @returns {ExtendedSourceRegistry}
 */
export function createSourceRegistry() {
  /** @type {Map<string, SourceContribution>} */
  const contributions = new Map()
  /** @type {Map<string, StartedSource>} */
  const started = new Map()
  const log = getLogger('sources')
  const instruments = getKernelInstruments()

  /** @param {SourceContribution} contribution */
  function register(contribution) {
    if (!contribution || typeof contribution !== 'object') {
      throw new TypeError('SourceRegistry.register: contribution must be an object')
    }
    if (typeof contribution.name !== 'string' || contribution.name.length === 0) {
      throw new TypeError('SourceRegistry.register: contribution.name must be a non-empty string')
    }
    if (typeof contribution.plugin !== 'string' || contribution.plugin.length === 0) {
      throw new TypeError(`SourceRegistry.register: '${contribution.name}' missing plugin`)
    }
    if (typeof contribution.start !== 'function') {
      throw new TypeError(`SourceRegistry.register: '${contribution.name}' missing start()`)
    }
    if (contributions.has(contribution.name)) {
      throw new Error(`SourceRegistry.register: duplicate source name '${contribution.name}'`)
    }
    contributions.set(contribution.name, contribution)
    log.info('source.register', {
      [Attr.PLUGIN]: contribution.plugin,
      hyp_source: contribution.name,
      hyp_config_section: contribution.configSection ?? '',
    })
  }

  /** @param {string} name */
  function get(name) {
    return contributions.get(name)
  }

  function list() {
    return Array.from(contributions.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * @param {string} name
   * @param {PluginActivationContext} ctx
   * @returns {Promise<StartedSource>}
   */
  async function start(name, ctx) {
    const contribution = contributions.get(name)
    if (!contribution) {
      throw new Error(`SourceRegistry.start: unknown source '${name}'`)
    }
    if (started.has(name)) {
      throw new Error(`SourceRegistry.start: source '${name}' already started`)
    }
    return withSpan(
      'source.start',
      {
        [Attr.COMPONENT]: 'sources',
        [Attr.OPERATION]: 'source.start',
        [Attr.PLUGIN]: contribution.plugin,
        hyp_source: name,
        status: 'ok',
      },
      async () => {
        const handle = await contribution.start(ctx)
        if (!handle || typeof handle.stop !== 'function') {
          throw new Error(`SourceRegistry.start: source '${name}' did not return a StartedSource`)
        }
        started.set(name, handle)
        instruments.sourcesStarted.add(1, { hyp_source: name, [Attr.PLUGIN]: contribution.plugin })
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
    const plugin = contribution?.plugin ?? 'unknown'
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
   */
  async function reload(name, ctx) {
    const handle = started.get(name)
    if (!handle) {
      throw new Error(`SourceRegistry.reload: source '${name}' is not started`)
    }
    if (typeof handle.reload !== 'function') {
      // Sources opt-out by omitting reload — surface a span anyway so the
      // operator can grep for "reload requested but not supported."
      const contribution = contributions.get(name)
      await withSpan(
        'source.reload',
        {
          [Attr.COMPONENT]: 'sources',
          [Attr.OPERATION]: 'source.reload',
          [Attr.PLUGIN]: contribution?.plugin ?? 'unknown',
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
        [Attr.PLUGIN]: contribution?.plugin ?? 'unknown',
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
        [Attr.PLUGIN]: contribution?.plugin ?? 'unknown',
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
