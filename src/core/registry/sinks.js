// @ts-check

import { Attr, getKernelInstruments, getLogger, withSpan } from '../observability/index.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').SinkRegistry} SinkRegistryContract */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SinkContribution} SinkContribution */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SinkHandle} SinkHandle */
/** @typedef {import('../../../collectivus-plugin-kernel-types').Sink} Sink */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SinkEncoder} SinkEncoder */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SinkInstanceConfig} SinkInstanceConfig */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SinkSupportTag} SinkSupportTag */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SinkCreateContext} SinkCreateContext */
/** @typedef {import('../../../collectivus-plugin-kernel-types').ActivePlugin} ActivePlugin */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginPaths} PluginPaths */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginLogger} PluginLogger */

/**
 * @typedef {Object} InstantiateBlobArgs
 * @property {'blob'} kind
 * @property {string} instanceName
 * @property {SinkContribution} destination  Sink contribution providing the destination (e.g. `local-fs`).
 * @property {string} writerPlugin           Writer plugin name (e.g. `@hypaware/format-parquet`).
 * @property {SinkEncoder} encoder           Encoder resolved from the writer plugin's `hypaware.encoder` capability.
 * @property {SinkInstanceConfig} config     Validated instance config (with `schedule`).
 * @property {ActivePlugin} plugin           The destination's active plugin record.
 * @property {PluginPaths} paths             Per-plugin paths for the destination.
 * @property {PluginLogger} log              Per-plugin logger for the destination.
 */

/**
 * @typedef {Object} InstantiateRequestArgs
 * @property {'request'} kind
 * @property {string} instanceName
 * @property {SinkContribution} contribution Sink contribution for the request destination.
 * @property {SinkInstanceConfig} config
 * @property {ActivePlugin} plugin
 * @property {PluginPaths} paths
 * @property {PluginLogger} log
 */

/** @typedef {InstantiateBlobArgs | InstantiateRequestArgs} InstantiateArgs */

/**
 * @typedef {SinkHandle & {
 *   kind: 'blob' | 'request',
 *   instanceName: string,
 *   writer?: string,
 *   destination?: string,
 *   config: SinkInstanceConfig,
 *   encoder?: SinkEncoder,
 * }} ExtendedSinkHandle
 */

/**
 * @typedef {SinkRegistryContract & {
 *   instantiate: (args: InstantiateArgs) => Promise<ExtendedSinkHandle>,
 *   getContribution: (plugin: string, sinkName: string) => SinkContribution | undefined,
 *   listContributions: () => Array<{ plugin: string, contribution: SinkContribution }>,
 *   listHandles: () => ExtendedSinkHandle[],
 *   closeAll: () => Promise<void>,
 * }} ExtendedSinkRegistry
 */

/**
 * Build the kernel-side SinkRegistry. The contract surface
 * (`register`/`get`/`list`) matches `collectivus-plugin-kernel-types.d.ts
 * §Sinks` and is what plugins see through `ctx.sinks` — plugins call
 * `register(contribution)` to declare a sink type (matching their
 * manifest `contributes.sinks[]` entry). Instance creation (per
 * `HypAwareV2Config.sinks.<name>`) is driven by the kernel through
 * `instantiate(...)`, which validates blob-vs-request shape, calls the
 * contribution's `create(ctx)`, emits a `sink.register` log with
 * `sink_kind`/`writer`/`destination`/`supports`, and ticks the
 * `hyp_sinks_registered` counter.
 *
 * @returns {ExtendedSinkRegistry}
 */
export function createSinkRegistry() {
  /** @type {Map<string, { plugin: string, contribution: SinkContribution }>} */
  const contributions = new Map()
  /** @type {Map<string, ExtendedSinkHandle>} */
  const handles = new Map()
  const log = getLogger('sinks')
  const instruments = getKernelInstruments()

  /** @param {SinkContribution} contribution */
  function register(contribution) {
    if (!contribution || typeof contribution !== 'object') {
      throw new TypeError('SinkRegistry.register: contribution must be an object')
    }
    if (typeof contribution.name !== 'string' || contribution.name.length === 0) {
      throw new TypeError('SinkRegistry.register: contribution.name must be a non-empty string')
    }
    if (typeof contribution.plugin !== 'string' || contribution.plugin.length === 0) {
      throw new TypeError(`SinkRegistry.register: '${contribution.name}' missing plugin`)
    }
    if (!Array.isArray(contribution.supports)) {
      throw new TypeError(`SinkRegistry.register: '${contribution.name}' supports must be an array`)
    }
    if (typeof contribution.create !== 'function') {
      throw new TypeError(`SinkRegistry.register: '${contribution.name}' missing create()`)
    }
    const key = contributionKey(contribution.plugin, contribution.name)
    if (contributions.has(key)) {
      throw new Error(
        `SinkRegistry.register: duplicate sink contribution '${contribution.name}' from plugin '${contribution.plugin}'`
      )
    }
    contributions.set(key, { plugin: contribution.plugin, contribution })
    log.info('sink.contribute', {
      [Attr.PLUGIN]: contribution.plugin,
      hyp_sink: contribution.name,
      hyp_sink_supports: contribution.supports.join(','),
    })
  }

  /** @param {string} name */
  function get(name) {
    return handles.get(name)
  }

  function list() {
    return Array.from(handles.values()).sort((a, b) =>
      a.instanceName.localeCompare(b.instanceName)
    )
  }

  /**
   * @param {string} plugin
   * @param {string} sinkName
   */
  function getContribution(plugin, sinkName) {
    return contributions.get(contributionKey(plugin, sinkName))?.contribution
  }

  function listContributions() {
    return Array.from(contributions.values())
  }

  function listHandles() {
    return list()
  }

  /**
   * Materialize a sink instance from a validated config row. Blob sinks
   * carry a `writer`/`destination` pair (and the kernel resolves the
   * encoder); request sinks carry a single `plugin`.
   *
   * @param {InstantiateArgs} args
   * @returns {Promise<ExtendedSinkHandle>}
   */
  async function instantiate(args) {
    const { instanceName, config } = args
    if (typeof instanceName !== 'string' || instanceName.length === 0) {
      throw new TypeError('SinkRegistry.instantiate: instanceName required')
    }
    if (handles.has(instanceName)) {
      throw new Error(`SinkRegistry.instantiate: sink instance '${instanceName}' already registered`)
    }
    const contribution = args.kind === 'blob' ? args.destination : args.contribution
    if (!contribution) {
      throw new Error(`SinkRegistry.instantiate: contribution required for '${instanceName}'`)
    }
    const supports = resolveSupports(contribution, args.kind === 'blob' ? args.encoder : undefined)

    return withSpan(
      'sink.register',
      {
        [Attr.COMPONENT]: 'sinks',
        [Attr.OPERATION]: 'sink.register',
        [Attr.PLUGIN]: contribution.plugin,
        [Attr.SINK_INSTANCE]: instanceName,
        hyp_sink_kind: args.kind,
        status: 'ok',
      },
      async () => {
        /** @type {SinkCreateContext} */
        const createCtx = {
          name: instanceName,
          plugin: args.plugin,
          config,
          paths: args.paths,
          log: args.log,
          encoder: args.kind === 'blob' ? args.encoder : undefined,
        }
        const sink = await contribution.create(createCtx)
        if (!sink || typeof sink.exportBatch !== 'function' || typeof sink.close !== 'function') {
          throw new Error(
            `SinkRegistry.instantiate: contribution '${contribution.name}' did not return a Sink with exportBatch/close`
          )
        }
        /** @type {ExtendedSinkHandle} */
        const handle = {
          name: instanceName,
          instanceName,
          plugin: contribution.plugin,
          supports,
          sink,
          kind: args.kind,
          config,
          ...(args.kind === 'blob' ? { writer: args.writerPlugin, destination: contribution.plugin, encoder: args.encoder } : {}),
        }
        handles.set(instanceName, handle)
        instruments.sinksRegistered.add(1, {
          [Attr.SINK_INSTANCE]: instanceName,
          hyp_sink_kind: args.kind,
          [Attr.PLUGIN]: contribution.plugin,
        })
        log.info('sink.register', {
          [Attr.PLUGIN]: contribution.plugin,
          [Attr.SINK_INSTANCE]: instanceName,
          hyp_sink_kind: args.kind,
          hyp_sink_writer: args.kind === 'blob' ? args.writerPlugin : '',
          hyp_sink_destination: args.kind === 'blob' ? contribution.plugin : contribution.plugin,
          hyp_sink_supports: supports.join(','),
        })
        return handle
      },
      { component: 'sinks' }
    )
  }

  async function closeAll() {
    const names = Array.from(handles.keys())
    for (const name of names) {
      const handle = handles.get(name)
      if (!handle) continue
      try {
        await handle.sink.close()
      } catch {
        // best-effort during shutdown
      }
      handles.delete(name)
    }
  }

  return {
    register,
    get,
    list,
    instantiate,
    getContribution,
    listContributions,
    listHandles,
    closeAll,
  }
}

/**
 * @param {string} plugin
 * @param {string} name
 */
function contributionKey(plugin, name) {
  return `${plugin}::${name}`
}

/**
 * Compose the resolved `supports` set for a sink instance. The
 * contribution's own tags are the base; encoders contribute their tags
 * too so `queryable` lights up only when the writer+destination pair
 * agree (e.g. parquet+local-fs is queryable, jsonl+local-fs is not).
 *
 * @param {SinkContribution} contribution
 * @param {SinkEncoder | undefined} encoder
 * @returns {SinkSupportTag[]}
 */
function resolveSupports(contribution, encoder) {
  /** @type {Set<SinkSupportTag>} */
  const set = new Set()
  for (const tag of contribution.supports ?? []) set.add(tag)
  if (encoder) {
    if (!Array.isArray(encoder.supports)) {
      // Encoders without an opinion neither add nor remove tags; missing
      // tags only block on the destination-side declaration.
    } else {
      // Intersect: a tag survives only when both sides claim it. This
      // mirrors the design's "Parquet+local-fs queryable, JSONL+local-fs
      // not" rule without a tag-by-tag table in the kernel.
      const encoderTags = new Set(encoder.supports)
      for (const tag of Array.from(set)) {
        if (!encoderTags.has(tag)) set.delete(tag)
      }
    }
  }
  return Array.from(set).sort()
}
