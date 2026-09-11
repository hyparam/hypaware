// @ts-check

import { Attr, getKernelInstruments, getLogger, withSpan } from '../observability/index.js'
import { compareStrings } from '../util/compare_strings.js'

/**
 * @import { SinkContribution, SinkCreateContext, SinkEncoder, SinkSupportTag, TableFormatProvider } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * @import {
 *   InstantiateTableFormatArgs,
 *   InstantiateArgs,
 *   ExtendedSinkHandle,
 *   ExtendedSinkRegistry,
 * } from '../../../src/core/registry/types.js'
 */

/**
 * Build the kernel-side SinkRegistry. The contract surface
 * (`register`/`get`/`list`) matches `hypaware-plugin-kernel-types.d.ts
 * §Sinks` and is what plugins see through `ctx.sinks`: plugins call
 * `register(contribution)` to declare a sink type (matching their
 * manifest `contributes.sinks[]` entry). Instance creation (per
 * `HypAwareV2Config.sinks.<name>`) is driven by the kernel through
 * `instantiate(...)`, which validates blob-vs-request shape, calls the
 * contribution's `create(ctx)`, emits a `sink.register` log with
 * `sink_kind`/`writer`/`destination`/`supports`, and ticks the
 * `hyp_sinks_registered` counter.
 *
 * @returns {ExtendedSinkRegistry}
 * @ref LLP 0014#sinks-are-export-targets-not-the-write-path: instances driven from config; sources never reach here
 */
export function createSinkRegistry() {
  /** @type {Map<string, { plugin: string, contribution: SinkContribution, supports: SinkSupportTag[] }>} */
  const contributions = new Map()
  /** @type {Map<string, ExtendedSinkHandle>} */
  const handles = new Map()
  const log = getLogger('sinks')
  const instruments = getKernelInstruments()

  /**
   * `name`, `plugin` and `supports` are each read once, before the Map is
   * touched, and every later step uses what this registry took.
   *
   * The contribution is stored by reference, so a plugin's `plugin` and `name`
   * are live properties free to answer differently each time they are asked,
   * and the pair is the key `getContribution()` addresses a contribution by. A
   * second read for the stored wrapper indexes the sink under one plugin name
   * and reports another to every caller of `listContributions()`, so a caller
   * round-tripping the listing back through `getContribution()` misses a sink
   * this registry holds. That round trip is what the plugin doctor's dry run
   * does (issue #1553).
   *
   * `supports` is copied and joined before the `set` for the reason
   * `SourceRegistry` reads `configSection` early: a value that raises below
   * the write leaves this registry holding a contribution while the loader
   * marks the plugin's whole activation failed (`src/core/runtime/loader.js`).
   *
   * The validated tags go into the wrapper rather than being read again at
   * instantiate time (issue #1568). `supports` is a declaration made once,
   * matching the manifest's `contributes.sinks[].supports`
   * (LLP 0014 #queryable-sinks), not a per-instance negotiation, so what this
   * registry checked, and published in `sink.contribute`, is what every later
   * step gets.
   *
   * @param {SinkContribution} contribution
   */
  function register(contribution) {
    if (!contribution || typeof contribution !== 'object') {
      throw new TypeError('SinkRegistry.register: contribution must be an object')
    }
    const name = contribution.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('SinkRegistry.register: contribution.name must be a non-empty string')
    }
    const plugin = contribution.plugin
    if (typeof plugin !== 'string' || plugin.length === 0) {
      throw new TypeError(`SinkRegistry.register: '${name}' missing plugin`)
    }
    const declaredSupports = contribution.supports
    if (!Array.isArray(declaredSupports)) {
      throw new TypeError(`SinkRegistry.register: '${name}' supports must be an array`)
    }
    // A copy, so the tags this registry reports and resolves are the ones it
    // validated: the plugin keeps a reference to its own array and is free to
    // mutate it in place after the check.
    //
    // `Array.from`, not `slice()`: `slice` builds its result through
    // `Symbol.species`, so an `Array` subclass naming its own constructor
    // gets the copy back plugin-controlled and the tags drift again through
    // the field meant to pin them. `Array.from` always yields a plain array.
    const supports = Array.from(declaredSupports)
    if (typeof contribution.create !== 'function') {
      throw new TypeError(`SinkRegistry.register: '${name}' missing create()`)
    }
    const supportsLabel = supports.join(',')
    const key = contributionKey(plugin, name)
    if (contributions.has(key)) {
      throw new Error(
        `SinkRegistry.register: duplicate sink contribution '${name}' from plugin '${plugin}'`
      )
    }
    contributions.set(key, { plugin, contribution, supports })
    log.info('sink.contribute', {
      [Attr.PLUGIN]: plugin,
      hyp_sink: name,
      hyp_sink_supports: supportsLabel,
    })
  }

  /** @param {string} name */
  function get(name) {
    return handles.get(name)
  }

  function list() {
    return Array.from(handles.values()).sort((a, b) => compareStrings(a.instanceName, b.instanceName))
  }

  /**
   * @param {string} plugin
   * @param {string} sinkName
   */
  function getContribution(plugin, sinkName) {
    return contributions.get(contributionKey(plugin, sinkName))?.contribution
  }

  /**
   * Fresh wrappers carrying a copy of the validated tags. The copy at
   * `register` guards the plugin's array; this one guards the registry's own,
   * which the listing is the only route to: `ctx.sinks` is this registry
   * (`src/core/runtime/activation.js`), so a plugin that could edit the array
   * it is handed here would decide `supports` after the check, which is the
   * drift #1568 closed arriving by the other door.
   */
  function listContributions() {
    return Array.from(contributions.values(), (entry) => ({ ...entry, supports: entry.supports.slice() }))
  }

  /**
   * The `supports` this registry validated for `contribution`, found by object
   * identity so no plugin-controlled property picks the record.
   *
   * `instantiate` is handed the contribution by its caller
   * (`src/core/sinks/materialize.js`), not by this index, and what the caller
   * has is the object `listContributions()` gave it, so identity finds the
   * registration behind every configured sink. A contribution that was never
   * registered has no validated tags to prefer, so its own are read, once.
   *
   * @param {SinkContribution} contribution
   * @returns {SinkSupportTag[]}
   */
  function registeredSupports(contribution) {
    for (const entry of contributions.values()) {
      if (entry.contribution === contribution) return entry.supports
    }
    const declared = contribution.supports
    return Array.isArray(declared) ? declared : []
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
   * @ref LLP 0014#bytes-flow-down-semantics-flow-up [implements]: blob / table-format / request shapes keep writer + destination decoupled
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
    // One read of the contribution's `plugin`: a second answer splits a single
    // instantiation across the two records, the span, the counter, and the
    // handle's own `plugin` and `destination`.
    const contributionPlugin = contribution.plugin
    const supports = resolveSupports(registeredSupports(contribution), args.kind === 'blob' ? args.encoder : undefined)
    // Emit `sink.resolved` ahead of the destination's `create()` so the
    // resolved writer+destination+supports tuple lands in logs even when
    // `create` is slow or fails. Status code (`hyp_status`) and `hyp_sink_*`
    // attributes mirror the post-create `sink.register` log so consumers
    // can correlate the two by instance name.
    log.info('sink.resolved', {
      [Attr.PLUGIN]: contributionPlugin,
      [Attr.SINK_INSTANCE]: instanceName,
      hyp_sink_kind: args.kind,
      hyp_sink_writer: args.kind === 'blob' ? args.writerPlugin : '',
      hyp_sink_destination: contributionPlugin,
      hyp_sink_supports: supports.join(','),
    })

    return withSpan(
      'sink.register',
      {
        [Attr.COMPONENT]: 'sinks',
        [Attr.OPERATION]: 'sink.register',
        [Attr.PLUGIN]: contributionPlugin,
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
          plugin: contributionPlugin,
          supports,
          sink,
          kind: args.kind,
          config,
          ...(args.kind === 'blob' ? { writer: args.writerPlugin, destination: contributionPlugin, encoder: args.encoder } : {}),
        }
        handles.set(instanceName, handle)
        instruments.sinksRegistered.add(1, {
          [Attr.SINK_INSTANCE]: instanceName,
          hyp_sink_kind: args.kind,
          [Attr.PLUGIN]: contributionPlugin,
        })
        log.info('sink.register', {
          [Attr.PLUGIN]: contributionPlugin,
          [Attr.SINK_INSTANCE]: instanceName,
          hyp_sink_kind: args.kind,
          hyp_sink_writer: args.kind === 'blob' ? args.writerPlugin : '',
          hyp_sink_destination: contributionPlugin,
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
    // One read of the provider's `format`, so the two records and the handle
    // cannot name different table formats for one instantiation.
    const format = tableFormat.format
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
      hyp_sink_table_format: format,
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
            `SinkRegistry.instantiate: table-format provider '${format}' did not return a Sink with exportBatch/close`
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
          tableFormat: format,
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
          hyp_sink_table_format: format,
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
 * @ref LLP 0014#queryable-sinks [implements]: table-format queryable only when provider and encoder both claim it
 */
function resolveTableFormatSupports(provider, encoder) {
  /** @type {Set<SinkSupportTag>} */
  const set = new Set()
  for (const tag of provider.supports ?? []) set.add(tag)
  const encoderSupports = encoder.supports
  if (Array.isArray(encoderSupports)) {
    const encoderTags = new Set(encoderSupports)
    for (const tag of Array.from(set)) {
      if (!encoderTags.has(tag)) set.delete(tag)
    }
  }
  return Array.from(set).sort()
}

/**
 * Compose the resolved `supports` set for a sink instance. The tags
 * `register` validated are the base; encoders contribute their tags
 * too so `queryable` lights up only when the writer+destination pair
 * agree (e.g. parquet+local-fs is queryable, jsonl+local-fs is not).
 *
 * @param {SinkSupportTag[]} baseSupports
 * @param {SinkEncoder | undefined} encoder
 * @returns {SinkSupportTag[]}
 * @ref LLP 0014#queryable-sinks [implements]: queryable is a property of the writer+destination pair, not either alone
 */
function resolveSupports(baseSupports, encoder) {
  /** @type {Set<SinkSupportTag>} */
  const set = new Set(baseSupports)
  // Intersect: a tag survives only when both sides claim it. This
  // mirrors the design's "Parquet+local-fs queryable, JSONL+local-fs
  // not" rule without a tag-by-tag table in the kernel. Encoders
  // without a `supports` array have no opinion and neither add nor
  // remove tags.
  // One read of `supports`: an encoder answering an array for the guard and
  // another for the intersection would set `queryable` from tags the guard
  // never saw.
  const encoderSupports = encoder?.supports
  if (Array.isArray(encoderSupports)) {
    const encoderTags = new Set(encoderSupports)
    for (const tag of Array.from(set)) {
      if (!encoderTags.has(tag)) set.delete(tag)
    }
  }
  return Array.from(set).sort()
}
