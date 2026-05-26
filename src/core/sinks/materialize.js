// @ts-check

import { Attr, getLogger, withSpan } from '../observability/index.js'
import {
  CAP_BLOB_STORE,
  CAP_ENCODER,
  CAP_TABLE_FORMAT,
} from '../config/validate.js'

/**
 * @import {
 *   ActivePlugin,
 *   BlobSinkConfigInstance,
 *   BlobStore,
 *   HypAwareV2Config,
 *   PluginName,
 *   RequestSinkConfigInstance,
 *   SinkEncoder,
 *   TableFormatProvider,
 * } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { KernelRuntime } from '../runtime/activation.d.ts'
 * @import { ExtendedSinkHandle } from '../registry/types.d.ts'
 */

/**
 * @typedef {object} MaterializeResult
 * @property {ExtendedSinkHandle[]} handles
 * @property {MaterializeError[]} errors
 */

/**
 * @typedef {object} MaterializeError
 * @property {string} instance
 * @property {string} errorKind
 * @property {string} message
 */

/**
 * Materialize every sink instance declared in `config.sinks` by
 * resolving capabilities from the activated plugin registries and
 * calling `runtime.sinks.instantiate(...)`.
 *
 * Three sink shapes are supported:
 *
 * - **request**: `{ plugin }` — resolves that plugin's registered sink
 *   contribution.
 * - **blob**: `{ writer, destination }` where the writer provides
 *   `hypaware.encoder` — resolves encoder and destination blob-store
 *   contributions.
 * - **table-format**: `{ writer, destination }` where the writer provides
 *   `hypaware.table-format` — resolves table-format provider, blob-store
 *   from destination, inner encoder from `config.encoder` pin or default
 *   `@hypaware/format-parquet`.
 *
 * Errors are collected, not thrown, so a single misconfigured sink does
 * not block the others. Each error is logged with `sink.materialize_failed`.
 *
 * @param {KernelRuntime} runtime
 * @param {HypAwareV2Config | null} config
 * @param {{ stateRoot: string, runId: string, tmpRoot?: string }} opts
 * @returns {Promise<MaterializeResult>}
 */
export async function materializeSinks(runtime, config, opts) {
  const log = getLogger('sinks')

  if (!config?.sinks || Object.keys(config.sinks).length === 0) {
    return { handles: [], errors: [] }
  }

  return withSpan(
    'sink.materialize',
    {
      [Attr.COMPONENT]: 'sinks',
      [Attr.OPERATION]: 'sink.materialize',
      sink_count: Object.keys(config.sinks).length,
      status: 'ok',
    },
    async (span) => {
      /** @type {ExtendedSinkHandle[]} */
      const handles = []
      /** @type {MaterializeError[]} */
      const errors = []

      for (const [instanceName, raw] of Object.entries(config.sinks)) {
        try {
          const handle = await materializeOne(
            runtime, instanceName, raw, config, opts, log
          )
          handles.push(handle)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const errorKind = (err && typeof err === 'object' && 'errorKind' in err)
            ? String(/** @type {any} */ (err).errorKind)
            : 'sink_materialize_failed'
          errors.push({ instance: instanceName, errorKind, message })
          log.error('sink.materialize_failed', {
            [Attr.SINK_INSTANCE]: instanceName,
            [Attr.ERROR_KIND]: errorKind,
            message,
          })
        }
      }

      if (errors.length > 0) {
        span.setAttribute('status', 'degraded')
        span.setAttribute('sink_errors', errors.length)
      }
      span.setAttribute('sinks_materialized', handles.length)

      return { handles, errors }
    },
    { component: 'sinks' }
  )
}

/**
 * @param {KernelRuntime} runtime
 * @param {string} instanceName
 * @param {BlobSinkConfigInstance | RequestSinkConfigInstance} raw
 * @param {HypAwareV2Config} config
 * @param {{ stateRoot: string, runId: string, tmpRoot?: string }} opts
 * @param {ReturnType<import('../observability/index.js').getLogger>} log
 * @returns {Promise<ExtendedSinkHandle>}
 */
async function materializeOne(runtime, instanceName, raw, config, opts, log) {
  if ('plugin' in raw && !('writer' in raw)) {
    return materializeRequest(runtime, instanceName, raw, opts)
  }
  if ('writer' in raw && 'destination' in raw) {
    return materializeBlob(runtime, instanceName, raw, config, opts)
  }
  throw materializeError(
    'sink_config_invalid',
    `sink '${instanceName}' has neither writer/destination nor plugin`
  )
}

/**
 * @param {KernelRuntime} runtime
 * @param {string} instanceName
 * @param {RequestSinkConfigInstance} raw
 * @param {{ stateRoot: string, runId: string, tmpRoot?: string }} opts
 * @returns {Promise<ExtendedSinkHandle>}
 */
async function materializeRequest(runtime, instanceName, raw, opts) {
  const pluginName = /** @type {PluginName} */ (raw.plugin)

  const ctx = runtime.activationContexts.get(pluginName)
  if (!ctx) {
    throw materializeError(
      'sink_plugin_not_active',
      `sink '${instanceName}': plugin '${pluginName}' is not active`
    )
  }

  const contributions = runtime.sinks.listContributions()
    .filter((c) => c.plugin === pluginName)
  if (contributions.length === 0) {
    throw materializeError(
      'sink_contribution_missing',
      `sink '${instanceName}': plugin '${pluginName}' is active but registered no sink contributions`
    )
  }
  if (contributions.length > 1) {
    throw materializeError(
      'sink_contribution_ambiguous',
      `sink '${instanceName}': plugin '${pluginName}' registered ${contributions.length} sink contributions — cannot select unambiguously`
    )
  }

  const { contribution } = contributions[0]
  return runtime.sinks.instantiate({
    kind: 'request',
    instanceName,
    contribution,
    config: raw.config ?? {},
    plugin: ctx.plugin,
    paths: ctx.paths,
    log: ctx.log,
  })
}

/**
 * @param {KernelRuntime} runtime
 * @param {string} instanceName
 * @param {BlobSinkConfigInstance} raw
 * @param {HypAwareV2Config} config
 * @param {{ stateRoot: string, runId: string, tmpRoot?: string }} opts
 * @returns {Promise<ExtendedSinkHandle>}
 */
async function materializeBlob(runtime, instanceName, raw, config, opts) {
  const writerName = /** @type {PluginName} */ (raw.writer)
  const destName = /** @type {PluginName} */ (raw.destination)

  const writerCtx = runtime.activationContexts.get(writerName)
  if (!writerCtx) {
    throw materializeError(
      'sink_plugin_not_active',
      `sink '${instanceName}': writer plugin '${writerName}' is not active`
    )
  }

  const destCtx = runtime.activationContexts.get(destName)
  if (!destCtx) {
    throw materializeError(
      'sink_plugin_not_active',
      `sink '${instanceName}': destination plugin '${destName}' is not active`
    )
  }

  const tableFormat = /** @type {TableFormatProvider | undefined} */ (
    runtime.capabilities.fromProvider(writerName, CAP_TABLE_FORMAT)
  )

  if (tableFormat) {
    return materializeTableFormat(
      runtime, instanceName, raw, config, opts, writerName, destName,
      writerCtx, destCtx, tableFormat
    )
  }

  const encoder = /** @type {SinkEncoder | undefined} */ (
    runtime.capabilities.fromProvider(writerName, CAP_ENCODER)
  )
  if (!encoder) {
    throw materializeError(
      'sink_capability_missing',
      `sink '${instanceName}': writer '${writerName}' provides neither ${CAP_ENCODER} nor ${CAP_TABLE_FORMAT}`
    )
  }

  const contributions = runtime.sinks.listContributions()
    .filter((c) => c.plugin === destName)
  if (contributions.length === 0) {
    throw materializeError(
      'sink_contribution_missing',
      `sink '${instanceName}': destination '${destName}' registered no sink contributions`
    )
  }

  const { contribution } = contributions[0]
  return runtime.sinks.instantiate({
    kind: 'blob',
    instanceName,
    destination: contribution,
    writerPlugin: writerName,
    encoder,
    config: raw.config ?? {},
    plugin: destCtx.plugin,
    paths: destCtx.paths,
    log: destCtx.log,
  })
}

/**
 * @param {KernelRuntime} runtime
 * @param {string} instanceName
 * @param {BlobSinkConfigInstance} raw
 * @param {HypAwareV2Config} config
 * @param {{ stateRoot: string, runId: string, tmpRoot?: string }} opts
 * @param {PluginName} writerName
 * @param {PluginName} destName
 * @param {import('../../../collectivus-plugin-kernel-types.d.ts').PluginActivationContext} writerCtx
 * @param {import('../../../collectivus-plugin-kernel-types.d.ts').PluginActivationContext} destCtx
 * @param {TableFormatProvider} tableFormat
 * @returns {Promise<ExtendedSinkHandle>}
 */
async function materializeTableFormat(
  runtime, instanceName, raw, config, opts,
  writerName, destName, writerCtx, destCtx, tableFormat
) {
  const blobStore = /** @type {BlobStore | undefined} */ (
    runtime.capabilities.fromProvider(destName, CAP_BLOB_STORE)
  )
  if (!blobStore) {
    throw materializeError(
      'sink_capability_missing',
      `sink '${instanceName}': destination '${destName}' does not provide ${CAP_BLOB_STORE}`
    )
  }

  const encoderPin = typeof raw.config?.encoder === 'string'
    ? /** @type {PluginName} */ (raw.config.encoder)
    : /** @type {PluginName} */ ('@hypaware/format-parquet')

  const encoder = /** @type {SinkEncoder | undefined} */ (
    runtime.capabilities.fromProvider(encoderPin, CAP_ENCODER)
  )
  if (!encoder) {
    throw materializeError(
      'sink_capability_missing',
      `sink '${instanceName}': inner encoder '${encoderPin}' does not provide ${CAP_ENCODER} (is it active?)`
    )
  }

  return runtime.sinks.instantiate({
    kind: 'table-format',
    instanceName,
    tableFormat,
    writerPlugin: writerName,
    destinationPlugin: destName,
    blobStore,
    encoder,
    config: raw.config ?? {},
    plugin: writerCtx.plugin,
    paths: writerCtx.paths,
    log: writerCtx.log,
    query: runtime.query,
    storage: runtime.storage,
  })
}

/**
 * @param {string} errorKind
 * @param {string} message
 * @returns {Error & { errorKind: string }}
 */
function materializeError(errorKind, message) {
  const err = /** @type {Error & { errorKind: string }} */ (new Error(message))
  err.errorKind = errorKind
  return err
}
