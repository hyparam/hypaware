// @ts-check

/** @typedef {import('../../../../collectivus-plugin-kernel-types').Sink} Sink */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').ExportBatch} ExportBatch */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').ExportOptions} ExportOptions */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').ExportResult} ExportResult */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryPartition} QueryPartition */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryRegistry} QueryRegistry */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryStorageService} QueryStorageService */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginLogger} PluginLogger */
/** @typedef {import('./types.d.ts').CentralSinkConfig} CentralSinkConfig */
/** @typedef {import('./types.d.ts').IngestSignal} IngestSignal */
/** @typedef {import('./identity_client.js').IdentityClient} IdentityClient */

const KNOWN_SIGNALS = new Set(['logs', 'traces', 'metrics', 'proxy'])

/**
 * Build the `forward` Sink. The sink's `exportBatch` groups the driver's
 * partitions by signal (via each dataset's `sourceSignal`, defaulting to
 * the dataset name), serializes each group as NDJSON, and POSTs to
 * `/v1/ingest/{signal}`. Auth comes from the supplied IdentityClient.
 *
 * The kernel's sink driver owns retry-via-outbox; this sink reports
 * `failed` / `retryPartitions` on transport failure and the driver
 * spools the batch for the next tick.
 *
 * @param {{
 *   config: CentralSinkConfig,
 *   identityClient: IdentityClient,
 *   query: QueryRegistry,
 *   storage: QueryStorageService,
 *   log: PluginLogger,
 *   fetchFn?: typeof fetch,
 * }} args
 * @returns {Sink}
 */
export function createForwardSink(args) {
  const { config, identityClient, query, storage, log } = args
  const fetchFn = args.fetchFn ?? fetch

  return {
    /**
     * @param {ExportBatch} batch
     * @param {ExportOptions} _opts
     * @returns {Promise<ExportResult>}
     */
    async exportBatch(batch, _opts) {
      if (!Array.isArray(batch?.partitions) || batch.partitions.length === 0) {
        return { status: 'exported', partitionsExported: 0, bytesWritten: 0 }
      }

      const grouped = await groupBySignal(batch.partitions, query, storage, log)

      let bytesWritten = 0
      let partitionsExported = 0
      /** @type {QueryPartition[]} */
      const retry = []
      /** @type {string | undefined} */
      let firstError

      for (const group of grouped) {
        const body = group.rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
        const bytes = Buffer.byteLength(body, 'utf8')
        try {
          await postNdjson({
            centralUrl: config.url,
            signal: group.signal,
            body,
            identityClient,
            fetchFn,
          })
          bytesWritten += bytes
          partitionsExported += group.partitions.length
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          firstError = firstError ?? message
          retry.push(...group.partitions)
          log.warn('central.forward.failed', {
            hyp_sink_signal: group.signal,
            partitions_count: group.partitions.length,
            message,
          })
        }
      }

      if (retry.length === 0) {
        return { status: 'exported', partitionsExported, bytesWritten }
      }
      if (partitionsExported === 0) {
        return {
          status: 'failed',
          partitionsExported: 0,
          bytesWritten,
          retryPartitions: retry,
          error: firstError,
        }
      }
      return {
        status: 'partial',
        partitionsExported,
        bytesWritten,
        retryPartitions: retry,
        error: firstError,
      }
    },

    async close() {
      // No background loops to stop in the V1 forward sink; identity
      // refresh and config pull live on their own timers when wired in.
    },
  }
}

/**
 * Group partitions by signal, materializing rows from each table.
 *
 * @param {QueryPartition[]} partitions
 * @param {QueryRegistry} query
 * @param {QueryStorageService} storage
 * @param {PluginLogger} log
 * @returns {Promise<Array<{ signal: IngestSignal | string, partitions: QueryPartition[], rows: Record<string, unknown>[] }>>}
 */
async function groupBySignal(partitions, query, storage, log) {
  /** @type {Map<string, { partitions: QueryPartition[], rows: Record<string, unknown>[] }>} */
  const groups = new Map()

  for (const partition of partitions) {
    const dataset = query.getDataset(partition.dataset)
    const signal = dataset?.sourceSignal ?? partition.dataset
    if (!groups.has(signal)) {
      groups.set(signal, { partitions: [], rows: [] })
    }
    const bucket = /** @type {{ partitions: QueryPartition[], rows: Record<string, unknown>[] }} */ (groups.get(signal))
    bucket.partitions.push(partition)
    if (!partition.tablePath || !storage.tableExists(partition.tablePath)) {
      log.warn('central.forward.skip_missing_partition', {
        hyp_dataset: partition.dataset,
      })
      continue
    }
    await flushPartition(storage, partition.tablePath, 'sink_export')
    for await (const row of storage.readRows(partition.tablePath)) {
      bucket.rows.push(serializeRow(row))
    }
  }

  return Array.from(groups.entries()).map(([signal, bucket]) => ({
    signal,
    partitions: bucket.partitions,
    rows: bucket.rows,
  }))
}

/**
 * @param {QueryStorageService} storage
 * @param {string} tablePath
 * @param {string} reason
 */
async function flushPartition(storage, tablePath, reason) {
  const extended = /** @type {QueryStorageService & { flushTable?: (tablePath: string, opts?: { reason?: string, force?: boolean }) => Promise<unknown> }} */ (storage)
  if (typeof extended.flushTable === 'function') {
    await extended.flushTable(tablePath, { force: true, reason })
  }
}

/**
 * BigInt and other non-JSON-native values come back from the Iceberg
 * cache as BigInt / Date instances. Convert them to wire-safe types so
 * `JSON.stringify` doesn't throw. The server is expected to coerce on
 * its side per dataset schema.
 *
 * @param {Record<string, unknown>} row
 */
function serializeRow(row) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeValue(value)
  }
  return out
}

/** @param {unknown} value */
function serializeValue(value) {
  if (typeof value === 'bigint') {
    // Numbers <= 2^53-1 are safe; larger BigInts go to string to avoid
    // silent precision loss. The server reads the schema to decide.
    return value <= Number.MAX_SAFE_INTEGER && value >= -Number.MAX_SAFE_INTEGER
      ? Number(value)
      : value.toString()
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(serializeValue)
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const o = {}
    for (const [k, v] of Object.entries(value)) o[k] = serializeValue(v)
    return o
  }
  return value
}

/**
 * POST one NDJSON body to `/v1/ingest/{signal}`. Refreshes the JWT and
 * retries once on 401; throws on transport errors or non-2xx response.
 *
 * @param {{
 *   centralUrl: string,
 *   signal: string,
 *   body: string,
 *   identityClient: IdentityClient,
 *   fetchFn: typeof fetch,
 * }} args
 */
async function postNdjson(args) {
  const { centralUrl, signal, body, identityClient, fetchFn } = args
  if (!KNOWN_SIGNALS.has(signal)) {
    throw new Error(`central.forward: unknown signal '${signal}' (expected logs|traces|metrics|proxy)`)
  }
  const url = joinUrl(centralUrl, `/v1/ingest/${signal}`)

  let jwt = await identityClient.getCurrentJwt()
  let response = await fetchFn(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/x-ndjson',
    },
    body,
  })

  if (response.status === 401) {
    await identityClient.refresh()
    jwt = await identityClient.getCurrentJwt()
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/x-ndjson',
      },
      body,
    })
  }

  if (response.status === 202 || response.ok) return

  const detail = await readErrorDetail(response)
  throw new Error(`central.forward POST ${url} failed: ${detail}`)
}

/**
 * @param {string} base
 * @param {string} suffix
 */
function joinUrl(base, suffix) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/** @param {Response} response */
async function readErrorDetail(response) {
  let body
  try { body = await response.text() } catch { body = '' }
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const error = typeof /** @type {Record<string, unknown>} */ (parsed).error === 'string'
          ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (parsed).error)
          : undefined
        if (error) return `${response.status} ${error}`
      }
    } catch {
      // plain text — fall through
    }
    return `${response.status} ${body.trim().slice(0, 200)}`
  }
  return `${response.status} ${response.statusText || ''}`.trim()
}
