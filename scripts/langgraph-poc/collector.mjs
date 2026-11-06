// Installed only in the smoke's temporary home. This is not a bundled adapter.
import { createOtlpJsonServer, listenAndResolve } from '../../src/core/otlp/server.js'
import { flattenOtlpTraces } from '../../hypaware-core/plugins-workspace/otel/src/otlp/traces.js'
import { otelDatasetRegistration, otelTablePath, TRACES_COLUMNS } from '../../hypaware-core/plugins-workspace/otel/src/datasets.js'
import { ensureAiGatewayStorageContracts } from '../../hypaware-core/plugins-workspace/ai-gateway/src/storage_contracts.js'
import { createProjectedExchangeWriter } from '../../hypaware-core/plugins-workspace/ai-gateway/src/exchange_writer.js'

/** @param {any} storage @param {any} [log] */
export function createReceiver(storage, log = { info() {}, error() {} }) {
  let busy = false
  return async req => {
    // Refuse concurrent batches rather than retaining an unbounded promise queue.
    // The exporter retains refused files and can retry them later.
    if (busy) throw new Error('prototype receiver busy')
    busy = true
    try {
      // 32 maximum-size spans plus the OTLP envelope must fit without an
      // unreplayable batch at the producer's otherwise valid size boundary.
      if (req.signal !== 'traces' || req.payloadBytes > 32 * 64 * 1024 + 4096) throw new Error('prototype batch limit')
      const rows = /** @type {any[]} */ (flattenOtlpTraces(req.data))
      if (rows.length > 32 || rows.some(row => row.scope_name !== 'hypaware-prototype' ||
          !row.traceId || !row.spanId || !row.attributes?.dev_run_id)) throw new Error('invalid prototype spans')
      const key = row => `${row.traceId}:${row.spanId}`
      const wanted = new Set(rows.map(key))
      const seen = new Set()
      const columns = ['traceId', 'spanId']
      const traceIds = [...new Set(rows.map(row => row.traceId))]
      // Keep only this batch's identities, never a lifetime set of all spans.
      for (const part of await storage.discoverCachePartitions({ datasets: ['traces'] })) {
        for await (const row of storage.readRowsWhere(part.path, columns, { traceId: traceIds })) {
          if (wanted.has(key(row))) seen.add(key(row))
        }
      }
      for await (const row of storage.readSpooledRows('traces', columns)) {
        if (wanted.has(key(row))) seen.add(key(row))
      }
      // @ref LLP 0252#projection-unchanged: the dataset owner expands parts and deduplicates persisted message IDs
      const writer = createProjectedExchangeWriter({ storage })
      let messagesWritten = 0
      for (const row of rows) {
        const encoded = row.attributes['hypaware.projection']
        if (!encoded) continue
        const projection = JSON.parse(encoded)
        const result = await writer.record(projection)
        messagesWritten += result.rowsWritten
      }
      const fresh = rows.filter(row => {
        const id = key(row)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      // Messages go first. A failed second write can replay safely because BOTH
      // writes deduplicate against durable rows. Never mark a batch done early.
      if (fresh.length) await storage.appendRows(otelTablePath(storage, 'traces'), [...TRACES_COLUMNS], fresh)
      log.info('langgraph.receive', { component: 'langgraph_poc', operation: 'receive', status: 'ok',
        dev_run_id: rows[0]?.attributes.dev_run_id, smoke_name: 'langgraph_parity_poc',
        smoke_step: rows[0]?.attributes.smoke_step,
        spans_written: fresh.length, spans_skipped: rows.length - fresh.length, messages_written: messagesWritten })
    } catch (error) {
      log.error('langgraph.receive_failed', { component: 'langgraph_poc', operation: 'receive',
        status: 'error', error_kind: error.name })
      throw error
    } finally {
      busy = false
    }
  }
}

export async function activate(ctx) {
  ensureAiGatewayStorageContracts(ctx)
  ctx.query.registerDataset(otelDatasetRegistration('traces'))
  ctx.sources.register({ name: 'langgraph_poc', plugin: ctx.plugin.name,
    async start() {
      const server = createOtlpJsonServer({ name: 'langgraph-poc', signals: ['traces'],
        handler: { handle: createReceiver(ctx.storage, ctx.log) } })
      const bound = await listenAndResolve(server, '127.0.0.1', Number(ctx.env.HYP_LANGGRAPH_POC_PORT ?? 0), 'langgraph-poc')
      return {
        async status() { return { state: 'ready', details: { listen_port: bound.port } } },
        async stop() {
          await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve(undefined))
            server.closeAllConnections()
          })
        },
      }
    },
  })
}
