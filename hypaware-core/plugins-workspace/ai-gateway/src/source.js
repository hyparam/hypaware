// @ts-check

import {
  Attr,
  getKernelInstruments,
  getMeter,
  getLogger,
} from '../../../../src/core/observability/index.js'

import { compileConfig } from './config.js'
import { AI_GATEWAY_SCHEMA_COLUMNS, aiGatewayTablePath, DATASET_NAME } from './dataset.js'
import { createAiGatewayMessageProjector } from './message_projector.js'
import { startProxy } from './proxy.js'
import { createRecorder } from './recorder.js'

const PLUGIN_NAME = '@hypaware/ai-gateway'

/**
 * @import { PluginActivationContext, SourceStatus, StartedSource } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { FinishedRow, GatewayState, StartedProxy, UpstreamConfig } from './types.d.ts'
 * @import { Exchange } from './recorder.js'
 */

/**
 * Build the source `start` callback the plugin registers against the
 * kernel `SourceRegistry`. Closed over `state` so the running listener
 * and the `AiGatewayCapability.localEndpoint()` facade always agree on
 * the bound `host:port`.
 *
 * @param {GatewayState} state
 */
export function createStartSource(state) {
  /**
   * @param {PluginActivationContext} ctx
   * @returns {Promise<StartedSource>}
   */
  return async function startAiGatewaySource(ctx) {
    /** @type {{ rowsWritten: number, exchangeBytes: number, lastError: string | undefined }} */
    const liveState = { rowsWritten: 0, exchangeBytes: 0, lastError: undefined }

    let proxy = await launchListener(ctx, state, liveState)

    return {
      async status() {
        /** @type {SourceStatus} */
        const status = {
          state: 'ready',
          rowsWritten: liveState.rowsWritten,
          details: {
            host: proxy.host,
            port: proxy.port,
            upstreams: readConfiguredUpstreamNames(ctx),
            registered_presets: Array.from(state.presets.keys()),
            projectors: state.projectors.map((p) => p.name),
          },
        }
        if (liveState.lastError) status.lastError = liveState.lastError
        return status
      },

      async reload(nextCtx) {
        // Tear down the old listener and bring up a fresh one with the
        // new config. Connections in flight finish through the
        // recorder's drain (called inside stop()) so their rows are not
        // lost across the reload.
        await proxy.stop()
        state.listen = undefined
        proxy = await launchListener(nextCtx, state, liveState)
      },

      async stop() {
        await proxy.stop()
        state.listen = undefined
      },
    }
  }
}

/**
 * Bind the HTTP listener and wire it to the recorder and the
 * exchange-projector dispatcher. Sets `state.listen` so
 * `AiGatewayCapability.localEndpoint()` returns the bound URL; clears
 * it on stop/reload.
 *
 * @param {PluginActivationContext} ctx
 * @param {GatewayState} state
 * @param {{ rowsWritten: number, exchangeBytes: number, lastError: string | undefined }} liveState
 * @returns {Promise<StartedProxy>}
 */
async function launchListener(ctx, state, liveState) {
  const config = compileConfig(ctx.config)
  const recorder = createRecorder({ redactHeaders: config.redactHeaders })
  const projector = createAiGatewayMessageProjector({
    gatewayId: config.gatewayId,
    projectors: state.projectors,
    // Thread storage so the projector can lazily seed its seen-set from
    // committed part_ids per conversation (without it a restart/reload
    // rebuilds an empty set and replays re-emit duplicate-part_id rows).
    storage: ctx.storage,
    log: ctx.log,
  })
  const sourcesLog = getLogger('sources')
  const meter = getMeter('plugin.ai-gateway')
  const exchangeBytesCounter = meter.createCounter('aigw.exchange_bytes', {
    description: 'Bytes flowed through the AI gateway per exchange, by upstream',
  })
  const kernelInstruments = getKernelInstruments()

  const tablePath = aiGatewayTablePath(ctx.storage)

  /** @param {Exchange} exchange */
  async function onExchangeFinished(exchange) {
    /** @type {FinishedRow} */
    const row = exchange.finalize()
    const totalBytes = (row.request_bytes ?? 0) + (row.response_bytes ?? 0)
    try {
      const messageRows = await projector.projectExchange(row)
      if (messageRows.length > 0) {
        await ctx.storage.appendRows(tablePath, [...AI_GATEWAY_SCHEMA_COLUMNS], messageRows)
        liveState.rowsWritten += messageRows.length
        kernelInstruments.rowsWritten.add(messageRows.length, {
          [Attr.DATASET]: DATASET_NAME,
          [Attr.PLUGIN]: PLUGIN_NAME,
        })
      }
      liveState.exchangeBytes += totalBytes
      exchangeBytesCounter.add(totalBytes, {
        [Attr.PLUGIN]: PLUGIN_NAME,
        hyp_upstream: row.upstream,
      })
      const devRunId = extractDevRunId(row.metadata)
      ctx.log.info('aigw.exchange', {
        upstream: row.upstream,
        path: row.path ?? '',
        status_code: row.status_code ?? 0,
        request_bytes: row.request_bytes ?? 0,
        response_bytes: row.response_bytes ?? 0,
        is_sse: row.is_sse ?? false,
        rows_written: messageRows.length,
        ...(devRunId ? { [Attr.DEV_RUN_ID]: devRunId } : {}),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      liveState.lastError = message
      sourcesLog.error('aigw.exchange_write_failed', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        upstream: row.upstream,
        error: message,
      })
    }
  }

  const proxy = await startProxy({
    listen: config.listen,
    upstreams: mergeUpstreams(config.upstreams, state),
    startExchange: (init) => recorder.startExchange(init),
    onExchangeFinished,
  })

  state.listen = { host: proxy.host, port: proxy.port }

  // Hook stop so in-flight exchanges drain before the listener fully closes.
  const originalStop = proxy.stop
  proxy.stop = async () => {
    await recorder.drain(5000)
    await originalStop.call(proxy)
  }

  return proxy
}

/**
 * Compile the routing table the proxy uses. TOML-config upstreams
 * are operator-owned and win over adapter presets with the same
 * `name`; presets fill only missing names. The resulting list is
 * sorted by the proxy at compile time.
 *
 * Presets without a `match()` and without a `path_prefix` are filtered
 * out (they can never route a request and would only inflate the
 * compiled table).
 *
 * @param {UpstreamConfig[]} configUpstreams
 * @param {GatewayState} state
 * @returns {UpstreamConfig[]}
 */
function mergeUpstreams(configUpstreams, state) {
  /** @type {Map<string, UpstreamConfig>} */
  const merged = new Map()
  for (const upstream of configUpstreams) {
    merged.set(upstream.name, upstream)
  }
  for (const preset of state.presets.values()) {
    const hasMatch = typeof preset.match === 'function'
    const hasPathPrefix = typeof preset.path_prefix === 'string' && preset.path_prefix.length > 0
    if (!hasMatch && !hasPathPrefix) continue
    /** @type {UpstreamConfig} */
    const entry = { name: preset.name, base_url: preset.base_url }
    if (preset.provider) entry.provider = preset.provider
    if (hasPathPrefix) entry.path_prefix = preset.path_prefix
    if (typeof preset.priority === 'number') entry.priority = preset.priority
    if (hasMatch) entry.match = preset.match
    if (!merged.has(preset.name)) merged.set(preset.name, entry)
  }
  return Array.from(merged.values())
}

/**
 * Read the names of configured upstreams from the activation config.
 * Defensive: if config has been mutated to a degenerate shape, returns
 * an empty list so status() never throws.
 *
 * @param {PluginActivationContext} ctx
 * @returns {string[]}
 */
function readConfiguredUpstreamNames(ctx) {
  const raw = /** @type {Record<string, unknown>} */ (ctx.config ?? {}).upstreams
  if (!Array.isArray(raw)) return []
  /** @type {string[]} */
  const out = []
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const name = /** @type {Record<string, unknown>} */ (entry).name
      if (typeof name === 'string' && name.length > 0) out.push(name)
    }
  }
  return out
}

/**
 * Recover the dev_run_id from a finalized row's JSON metadata. The
 * row stores `metadata` pre-stringified so the storage layer can drop
 * it into a JSON column unchanged; the log emitter needs it as a
 * top-level attribute.
 *
 * @param {string | null} metadataJson
 * @returns {string | undefined}
 */
function extractDevRunId(metadataJson) {
  if (typeof metadataJson !== 'string' || metadataJson.length === 0) return undefined
  try {
    const parsed = JSON.parse(metadataJson)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = /** @type {Record<string, unknown>} */ (parsed).dev_run_id
      if (typeof id === 'string' && id.length > 0) return id
    }
  } catch {
    /* metadata is plugin-controlled; a parse error means there's nothing useful to surface */
  }
  return undefined
}
