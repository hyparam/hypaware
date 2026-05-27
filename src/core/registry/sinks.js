// @ts-check

import { Attr, getKernelInstruments, getLogger, withSpan } from '../observability/index.js'

/**
 * @import { ActivePlugin, BlobStore, PluginLogger, PluginPaths, QueryRegistry, QueryStorageService, Sink, SinkContribution, SinkCreateContext, SinkEncoder, SinkHandle, SinkInstanceConfig, SinkRegistry, SinkSupportTag, TableFormatProvider } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * @import {
 *   InstantiateBlobArgs,
 *   InstantiateTableFormatArgs,
 *   InstantiateRequestArgs,
 *   InstantiateArgs,
 *   ExtendedSinkHandle,
 *   ExtendedSinkRegistry,
 * } from './types.d.ts'
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
   * Materialize a sink instance from a validated config row. Three
   * shapes:
   *
   * - `blob`           encoder writer + blob-store destination; the
   *                    destination's sink contribution does the
   *                    encode+write.
   * - `table-format`   table-format writer + blob-store destination;
   *                    the writer's `TableFormatProvider.createSink`
   *                    builds the sink and the destination's
   *                    contribution is bypassed (its bytes flow
   *                    through the BlobStore the table-format sink
   *                    received).
   * - `request`        one-piece request destination.
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

    if (args.kind === 'table-format') {
      return instantiateTableFormat(args)
    }

    const contribution = args.kind === 'blob' ? args.destination : args.contribution
    if (!contribution) {
      throw new Error(`SinkRegistry.instantiate: contribution required for '${instanceName}'`)
    }
    const supports = resolveSupports(contribution, args.kind === 'blob' ? args.encoder : undefined)
    // Emit `sink.resolved` ahead of the destination's `create()` so the
    // resolved writer+destination+supports tuple lands in logs even when
    // `create` is slow or fails. Status code (`hyp_status`) and `hyp_sink_*`
    // attributes mirror the post-create `sink.register` log so consumers
    // can correlate the two by instance name.
    log.info('sink.resolved', {
      [Attr.PLUGIN]: contribution.plugin,
      [Attr.SINK_INSTANCE]: instanceName,
      hyp_sink_kind: args.kind,
      hyp_sink_writer: args.kind === 'blob' ? args.writerPlugin : '',
      hyp_sink_destination: contribution.plugin,
      hyp_sink_supports: supports.join(','),
    })

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

  /**
   * @param {InstantiateTableFormatArgs} args
   * @returns {Promise<ExtendedSinkHandle>}
   */
  async function instantiateTableFormat(args) {
    const { instanceName, config, tableFormat, encoder, blobStore } = args
    if (!tableFormat || typeof tableFormat.createSink !== 'function') {
      throw new TypeError(
        `SinkRegistry.instantiate: table-format provider for '${instanceName}' missing createSink()`
      )
    }
    if (!encoder) {
      throw new TypeError(
        `SinkRegistry.instantiate: table-format sink '${instanceName}' requires an inner encoder`
      )
    }
    if (!blobStore || typeof blobStore.putObject !== 'function') {
      throw new TypeError(
        `SinkRegistry.instantiate: table-format sink '${instanceName}' requires a BlobStore destination`
      )
    }
    // `resolveSupports` intersects the table-format provider's tags
    // with the encoder's tags, mirroring the encoder-writer rule
    // (queryable only when both sides claim it).
    const supports = resolveTableFormatSupports(tableFormat, encoder)

    log.info('sink.resolved', {
      [Attr.PLUGIN]: args.writerPlugin,
      [Attr.SINK_INSTANCE]: instanceName,
      hyp_sink_kind: 'table-format',
      hyp_sink_writer: args.writerPlugin,
      hyp_sink_destination: args.destinationPlugin,
      hyp_sink_table_format: tableFormat.format,
      hyp_sink_supports: supports.join(','),
    })

    return withSpan(
      'sink.register',
      {
        [Attr.COMPONENT]: 'sinks',
        [Attr.OPERATION]: 'sink.register',
        [Attr.PLUGIN]: args.writerPlugin,
        [Attr.SINK_INSTANCE]: instanceName,
        hyp_sink_kind: 'table-format',
        status: 'ok',
      },
      async () => {
        const sink = await tableFormat.createSink({
          name: instanceName,
          plugin: args.plugin,
          blobStore,
          encoder,
          query: args.query,
          storage: args.storage,
          sinkInstanceConfig: config,
          paths: args.paths,
          log: args.log,
        })
        if (!sink || typeof sink.exportBatch !== 'function' || typeof sink.close !== 'function') {
          throw new Error(
            `SinkRegistry.instantiate: table-format provider '${tableFormat.format}' did not return a Sink with exportBatch/close`
          )
        }
        /** @type {ExtendedSinkHandle} */
        const handle = {
          name: instanceName,
          instanceName,
          plugin: args.writerPlugin,
          supports,
          sink,
          kind: 'table-format',
          config,
          writer: args.writerPlugin,
          destination: args.destinationPlugin,
          encoder,
          tableFormat: tableFormat.format,
          blobStore,
        }
        handles.set(instanceName, handle)
        instruments.sinksRegistered.add(1, {
          [Attr.SINK_INSTANCE]: instanceName,
          hyp_sink_kind: 'table-format',
          [Attr.PLUGIN]: args.writerPlugin,
        })
        log.info('sink.register', {
          [Attr.PLUGIN]: args.writerPlugin,
          [Attr.SINK_INSTANCE]: instanceName,
          hyp_sink_kind: 'table-format',
          hyp_sink_writer: args.writerPlugin,
          hyp_sink_destination: args.destinationPlugin,
          hyp_sink_table_format: tableFormat.format,
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
 * Compose the resolved `supports` set for a table-format sink. The
 * provider's tags are the base; the inner encoder's tags intersect in,
 * so `queryable` lights up only when both the table-format provider
 * and the inner encoder agree.
 *
 * @param {TableFormatProvider} provider
 * @param {SinkEncoder} encoder
 * @returns {SinkSupportTag[]}
 */
function resolveTableFormatSupports(provider, encoder) {
  /** @type {Set<SinkSupportTag>} */
  const set = new Set()
  for (const tag of provider.supports ?? []) set.add(tag)
  if (Array.isArray(encoder.supports)) {
    const encoderTags = new Set(encoder.supports)
    for (const tag of Array.from(set)) {
      if (!encoderTags.has(tag)) set.delete(tag)
    }
  }
  return Array.from(set).sort()
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
