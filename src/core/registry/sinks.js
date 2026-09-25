// @ts-check

import { Attr, getKernelInstruments, getLogger, withSpan } from '../observability/index.js'
import { compareStrings } from '../util/compare_strings.js'

/**
 * @import { PluginName, SinkContribution, SinkCreateContext, SinkEncoder, SinkInstanceConfig, SinkSupportTag, TableFormatProvider } from '../../../hypaware-plugin-kernel-types.js'
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
 * The instance name each live handle was keyed under, written at the
 * `handles.set` beside it so the record and the key are the same string.
 *
 * Weak and keyed by the handle, for the reason the `owners` map is bounded by
 * the live instances: an entry goes when its handle does, so a long-running
 * daemon holds one name per sink it is exporting rather than one per sink it
 * ever materialized. Module-scoped rather than per-registry because identity
 * is the key: a handle belongs to the one registry that built it, so no two
 * registries can key the same object.
 *
 * @type {WeakMap<object, string>}
 */
const instanceNames = new WeakMap()

/**
 * The validated `config.sinks.<name>.config` row each live handle was
 * materialized from, written at the `handles.set` beside its name.
 *
 * A copy, for the reason `register` copies `supports`: the same object goes
 * to `create()` as `SinkCreateContext.config`, so the owner holds a reference
 * and is free to edit it in place after this registry read it. Shallow is all
 * the readers need, since every field they classify on is a top-level scalar,
 * and it keeps the copy bounded by the row once per instantiation.
 *
 * Weak and module-scoped for the reasons `instanceNames` is: an entry goes
 * when its handle does, and a handle belongs to the one registry that built
 * it.
 *
 * @type {WeakMap<object, SinkInstanceConfig>}
 */
const instanceConfigs = new WeakMap()

/**
 * The instance name this module keyed `handle` under: the string
 * `instantiate` validated, out of the kernel's own record rather than off the
 * handle. A handle is a live object its owner still holds through
 * `ctx.sinks.get`, so `handle.instanceName` is a property that owner can
 * replace with an accessor of its own, and the kernel's readers dereference it
 * in loop bodies: `hyp status`, the daemon's per-tick `status.sinks` write
 * and the sink driver's due check each raised the owner's error rather than
 * naming the instance (issue #1976, the reader half of #1971).
 *
 * A handle this module did not build - a host registry's, a test double's -
 * has no record here, so its own `instanceName` is read, guarded the way
 * `shownName` guards the facade's `name` in
 * `src/core/runtime/activation.js`: a name that cannot be read, or that is no
 * longer a string, answers `''` rather than raising into the caller's loop.
 *
 * @param {ExtendedSinkHandle} handle
 * @returns {string}
 */
export function sinkInstanceName(handle) {
  const recorded = instanceNames.get(handle)
  if (recorded !== undefined) return recorded
  try {
    const declared = handle?.instanceName
    return typeof declared === 'string' ? declared : ''
  } catch {
    return ''
  }
}

/**
 * The config this module materialized `handle` from, out of the kernel's own
 * record rather than off the handle, whose `config` its owner is as free to
 * replace with an accessor as it is `instanceName`. What `hyp sync` derives
 * from that config is not a label but a filter: an owner claiming a local
 * `dir` for an instance configured with a remote `url` took its destination
 * out of the consent plan, the counts, the progress display and the receipts
 * while the driver went on exporting to it (issue #2095,
 * `describeDestination` in `src/core/commands/sync.js`).
 *
 * A handle this module did not build - a host registry's, a test double's -
 * has no record here, so its own `config` is read, guarded the way
 * `sinkInstanceName` guards a declared name: one that cannot be read, or that
 * is not an object, answers an empty config rather than raising into the
 * caller.
 *
 * @param {ExtendedSinkHandle} handle
 * @returns {SinkInstanceConfig}
 */
export function sinkInstanceConfig(handle) {
  const recorded = instanceConfigs.get(handle)
  if (recorded !== undefined) return recorded
  try {
    const declared = handle?.config
    return declared !== null && typeof declared === 'object' ? declared : {}
  } catch {
    return {}
  }
}

/**
 * Build the kernel-side SinkRegistry. The contract surface
 * (`register`/`get`/`list`) matches `hypaware-plugin-kernel-types.d.ts
 * §Sinks` and is what a plugin reaches through the per-plugin `ctx.sinks`
 * facade (`src/core/runtime/activation.js`): plugins call
 * `register(contribution)` to declare a sink type (matching their
 * manifest `contributes.sinks[]` entry). Instance creation (per
 * `HypAwareV2Config.sinks.<name>`) is driven by the kernel through
 * `instantiate(...)`, which validates blob-vs-request shape, calls the
 * contribution's `create(ctx)`, emits a `sink.register` log with
 * `sink_kind`/`writer`/`destination`/`supports`, and ticks the
 * `hyp_sinks_registered` counter.
 *
 * `registeringAs`/`ownerOf` bind each instance to the plugin the kernel built
 * it from, the way `SourceRegistry` binds a source to its registrar. They are
 * kernel-side like `instantiate`: they live on `ExtendedSinkRegistry`, not on
 * the plugin-facing contract, and the facade is what reads them.
 *
 * @returns {ExtendedSinkRegistry}
 * @ref LLP 0014#sinks-are-export-targets-not-the-write-path: instances driven from config; sources never reach here
 */
export function createSinkRegistry() {
  /** @type {Map<string, { plugin: string, contribution: SinkContribution, supports: SinkSupportTag[] }>} */
  const contributions = new Map()
  /** @type {Map<string, ExtendedSinkHandle>} */
  const handles = new Map()
  /**
   * The plugin the kernel built each sink instance from, by the instance name
   * `instantiate` validated. Written from the `ActivePlugin` record the
   * kernel's materializer resolved out of the config row, never from a
   * property of the contribution, so it is the kernel's own record of who owns
   * an instance rather than a plugin's claim about itself (issue #1961).
   * Entries go with their handle in `closeAll`, so the map is bounded by the
   * live instances rather than by everything a long-running daemon ever
   * materialized.
   *
   * @type {Map<string, PluginName>}
   */
  const owners = new Map()
  const log = getLogger('sinks')
  const instruments = getKernelInstruments()
  /**
   * The plugin currently registering, or `''` outside an activation. Set only
   * by `registeringAs`, which brackets a synchronous `register` call, so no
   * two activations can hold it at once however they interleave. It mirrors
   * `SourceRegistry` for the reason it exists there: `contribution.plugin` is
   * written by the plugin and cannot be the answer to who is calling.
   */
  let registrar = ''

  /**
   * Run `fn` with `plugin` recorded as the plugin doing the registering. The
   * activation context brackets its own `register` call with this, which is
   * how this registry learns who is calling.
   *
   * A bracket rather than a `register(plugin, contribution)` overload, for the
   * reason `SourceRegistry.registeringAs` is one: a second entry point routes
   * around whatever wraps `register` (the plugin doctor's dry run does).
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
   * The plugin the kernel built the instance `name` from, or `undefined` when
   * nothing materialized an instance under that name through a plugin record
   * (a host driving this registry itself, and the kernel's own tests).
   *
   * @param {string} name
   * @returns {PluginName | undefined}
   */
  function ownerOf(name) {
    return owners.get(name)
  }

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
   * registry checked for a registration, and published in that registration's
   * `sink.contribute`, is what every later step for an instance built from it
   * gets. Per registration, not per contribution object: one object can hold
   * two of them, which is why `registeredSupports` resolves on the owner as
   * well as the object (issue #1582).
   *
   * `plugin` is checked against the registrar rather than taken on trust, the
   * way `SourceRegistry.register` checks it. It is half the key this registry
   * indexes a contribution under, and `materializeSinks` selects the
   * contribution for a configured sink by it, so a contribution naming a
   * neighbour either captured that neighbour's configured instance (its
   * `create()` running against the neighbour's validated config, inline
   * credentials included) or made the neighbour's own materialization fail as
   * ambiguous. It is also the claim a per-plugin facade would otherwise have to
   * bracket on, which is the #1541 shape exactly (issue #1961). Refusing at
   * registration leaves no half-registered sink, and lands as an activation
   * failure like the duplicate name below.
   *
   * @param {SinkContribution} contribution
   */
  function register(contribution) {
    // Read once, before any plugin property can run and re-enter.
    const registeredBy = registrar
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
    if (registeredBy !== '' && plugin !== registeredBy) {
      log.warn('sink.register_plugin_mismatch', {
        [Attr.COMPONENT]: 'sinks',
        [Attr.OPERATION]: 'sink.register',
        [Attr.ERROR_KIND]: 'sink_plugin_mismatch',
        [Attr.PLUGIN]: registeredBy,
        hyp_declared_plugin: plugin,
        hyp_sink: name,
        status: 'failed',
      })
      throw new Error(
        `SinkRegistry.register: '${name}' declares plugin '${plugin}' but was registered by '${registeredBy}'`
      )
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

  /**
   * Every live sink instance, ordered by instance name.
   *
   * The order comes from the keys, not from `a.instanceName`: the key is the
   * instance name `instantiate` validated, while the handle is a live object
   * its owner still holds through `ctx.sinks.get`, so `instanceName` is a
   * property the owner is free to replace with an accessor of its own.
   * Reading it here runs that code inside a comparator, where a throw escapes
   * into every caller of `list()` before a single handle has been handed back
   * - a neighbour's `ctx.sinks.list()`, ahead of the facade's own guarded
   * `name` read, and the kernel's `listHandles()` readers in `hyp status` and
   * the daemon runtime - and where `compareStrings` refuses a non-string, so
   * an accessor that merely stops answering with a string is the same outage
   * (issue #1971, the `instanceName` half of #1961).
   *
   * The order is unchanged for an honest handle: both `handles.set` sites key
   * the map with the very binding they write to `handle.instanceName`.
   */
  function list() {
    return Array.from(handles.keys())
      .sort(compareStrings)
      .map((name) => /** @type {ExtendedSinkHandle} */ (handles.get(name)))
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
   * which the listing is the only route to: a plugin that could edit the array
   * it is handed here would decide `supports` after the check, which is the
   * drift #1568 closed arriving by the other door. The facade over `ctx.sinks`
   * narrows the `contribution` in each wrapper for a plugin that did not
   * register it, but the wrapper and its tags are built here.
   */
  function listContributions() {
    return Array.from(contributions.values(), (entry) => ({ ...entry, supports: entry.supports.slice() }))
  }

  /**
   * The `supports` this registry validated for the registration `owner` made
   * of `contribution`, found by object identity plus the owner the kernel
   * resolved, so no plugin-controlled property picks the record.
   *
   * `instantiate` is handed the contribution by its caller
   * (`src/core/sinks/materialize.js`), not by this index, and what the caller
   * has is the object `listContributions()` gave it, so identity finds the
   * registrations behind every configured sink. Identity alone does not find
   * *the* registration: `contribution.plugin` is a live plugin-written
   * property, so the registrar check in `register` binds each registration to
   * the plugin the kernel saw call it without forcing one object to answer one
   * name, and two plugins sharing a contribution (a shared module, or one
   * handed over as a capability value) hold two registrations of it with two
   * separately validated tag sets (issue #1582).
   *
   * `owner` is what `instantiate` read off the `ActivePlugin` record the
   * kernel's materializer took out of the config row: the value every other
   * label on the instance comes from, and on the kernel's own path the name
   * `materializeRequest`/`materializeBlob` filtered the listing on to reach
   * this contribution. That agreement holds only as far as the record does:
   * `ownerName` reads a live, unfrozen property, so a plugin that rewrites its
   * own `name` after activation moves every label on the instance, and this
   * resolution moves with them only when the rewritten owner still holds a
   * registration of this contribution (issue #2130). Otherwise the identity
   * fallback in the next paragraph applies, and the tags are another
   * registrant's validated set, a residual of #2130 this fix leaves unchanged.
   *
   * An identity match under another owner is still preferred over reading the
   * contribution, because a host driving this registry itself records no owner
   * (`ownerName` answers `''`) and reading the plugin's live property is the
   * drift #1568 closed. A contribution that was never registered has no
   * validated tags to prefer, so its own are read, once.
   *
   * @param {SinkContribution} contribution
   * @param {string} owner
   * @returns {SinkSupportTag[]}
   */
  function registeredSupports(contribution, owner) {
    /** @type {SinkSupportTag[] | undefined} */
    let identityMatch
    for (const entry of contributions.values()) {
      if (entry.contribution !== contribution) continue
      if (entry.plugin === owner) return entry.supports
      if (identityMatch === undefined) identityMatch = entry.supports
    }
    if (identityMatch !== undefined) return identityMatch
    const declared = contribution.supports
    return Array.isArray(declared) ? declared : []
  }

  /**
   * Record which plugin the kernel built an instance from. `owner` is the
   * name its caller resolved through `ownerName`, so this record and every
   * label on the same instance come from one read (issue #1961).
   *
   * @param {string} instanceName
   * @param {string} owner
   */
  function recordOwner(instanceName, owner) {
    if (owner !== '') owners.set(instanceName, /** @type {PluginName} */ (owner))
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
    // The record's copy, taken before `create()` is handed the same object.
    const recordedConfig = /** @type {SinkInstanceConfig} */ ({ ...config })
    // Every label below comes from the owner the kernel resolved, never from
    // `contribution.plugin`. That field is a live property which only had to
    // agree with its registrar at `register`, so a contribution answering a
    // neighbour's name afterwards moved the instance's whole attribution:
    // both `sink.*` records, the span, `hyp_sinks_registered`, and through
    // `handle.plugin` the driver's `sink.export` spans, its per-tick record
    // and `hyp sync`'s destination line (issue #1562).
    const owner = ownerName(args.plugin)
    const supports = resolveSupports(
      registeredSupports(contribution, owner),
      args.kind === 'blob' ? args.encoder : undefined
    )
    // Emit `sink.resolved` ahead of the destination's `create()` so the
    // resolved writer+destination+supports tuple lands in logs even when
    // `create` is slow or fails. Status code (`hyp_status`) and `hyp_sink_*`
    // attributes mirror the post-create `sink.register` log so consumers
    // can correlate the two by instance name.
    log.info('sink.resolved', {
      [Attr.PLUGIN]: owner,
      [Attr.SINK_INSTANCE]: instanceName,
      hyp_sink_kind: args.kind,
      hyp_sink_writer: args.kind === 'blob' ? args.writerPlugin : '',
      hyp_sink_destination: owner,
      hyp_sink_supports: supports.join(','),
    })

    return withSpan(
      'sink.register',
      {
        [Attr.COMPONENT]: 'sinks',
        [Attr.OPERATION]: 'sink.register',
        [Attr.PLUGIN]: owner,
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
          plugin: owner,
          supports,
          sink,
          kind: args.kind,
          config,
          ...(args.kind === 'blob' ? { writer: args.writerPlugin, destination: owner, encoder: args.encoder } : {}),
        }
        handles.set(instanceName, handle)
        instanceNames.set(handle, instanceName)
        instanceConfigs.set(handle, recordedConfig)
        recordOwner(instanceName, owner)
        instruments.sinksRegistered.add(1, {
          [Attr.SINK_INSTANCE]: instanceName,
          hyp_sink_kind: args.kind,
          [Attr.PLUGIN]: owner,
        })
        log.info('sink.register', {
          [Attr.PLUGIN]: owner,
          [Attr.SINK_INSTANCE]: instanceName,
          hyp_sink_kind: args.kind,
          hyp_sink_writer: args.kind === 'blob' ? args.writerPlugin : '',
          hyp_sink_destination: owner,
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
    // The record's copy, taken before `createSink` is handed the same object.
    const recordedConfig = /** @type {SinkInstanceConfig} */ ({ ...config })
    // One read of the provider's `format`, so the two records and the handle
    // cannot name different table formats for one instantiation.
    const format = tableFormat.format
    // This shape labels from `args.writerPlugin` / `args.destinationPlugin`,
    // kernel-supplied strings rather than properties of a live contribution,
    // so #1562 never reached it; the owner record is resolved the same way as
    // the other shape's so both write it from one place.
    const owner = ownerName(args.plugin)
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
        instanceNames.set(handle, instanceName)
        instanceConfigs.set(handle, recordedConfig)
        recordOwner(instanceName, owner)
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

  /**
   * Close every live sink instance, or only the ones `owner` was recorded as
   * owning. The kernel's shutdown passes nothing and closes the lot; the
   * per-plugin facade passes its own name, so a plugin's `closeAll` stops its
   * own exports and not a neighbour's (issue #1961). Filtering here rather
   * than in the facade keeps the handle and its owner record leaving this
   * registry together, which a facade closing sinks from outside could not do.
   *
   * @param {PluginName} [owner]
   */
  async function closeAll(owner) {
    const names = Array.from(handles.keys())
    for (const name of names) {
      const handle = handles.get(name)
      if (!handle) continue
      if (owner !== undefined && owners.get(name) !== owner) continue
      try {
        await handle.sink.close()
      } catch {
        // best-effort during shutdown
      }
      handles.delete(name)
      owners.delete(name)
    }
  }

  return {
    register,
    registeringAs,
    ownerOf,
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
 * The name off the `ActivePlugin` the materializer resolved out of the config
 * row (`src/core/sinks/materialize.js`). The loader builds that record from
 * the manifest it validated (`src/core/runtime/loader.js`), so it is the
 * kernel's own rather than a property of the contribution the instance came
 * from. It is not out of a plugin's reach: `ctx.plugin` is that very object,
 * unfrozen, so an activated plugin can still rewrite the name the kernel
 * resolves it under (issue #2130). Reading it once, here, is what keeps one
 * instantiation's labels, span, counter and owner record from disagreeing
 * whatever it answers.
 *
 * A record without a usable `name` answers `''` rather than falling back to
 * the contribution's claim, which `InstantiateArgs` makes unreachable for a
 * caller honouring the contract: with no resolved owner there is nothing to
 * attribute the instance to, and repeating a claim the kernel cannot check is
 * how #1562 read in the first place.
 *
 * @param {{ name?: unknown } | undefined} plugin
 * @returns {string}
 */
function ownerName(plugin) {
  const name = plugin?.name
  return typeof name === 'string' && name.length > 0 ? name : ''
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
