// @ts-check

import path from 'node:path'

import { discoverCachePartitions } from '../../../../../src/core/cache/partition.js'
import { unionSources, emptySource } from 'hypaware/core/query'
import { BODY_EVENT_NAMES } from './bodies.js'
import { CONTENT_EVENT_NAMES } from './projection.js'

/**
 * @import { ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService } from '../../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../../src/core/cache/types.js'
 * @import { ClaudeTelemetryEvent } from '../types.js'
 * @import { AsyncDataSource } from 'squirreling'
 */

const PLUGIN_NAME = '@hypaware/claude'

/**
 * The behavioral-events dataset: the first dataset `@hypaware/claude`
 * owns.
 *
 * @ref LLP 0255#own-dataset [implements]: behavioral events get their own
 *   dataset, not a widening of `ai_gateway_messages` and not a route through
 *   `@hypaware/otel`'s generic tables
 */
export const TELEMETRY_EVENTS_DATASET = 'claude_telemetry_events'

/** Spool partition label under the kernel cache, mirroring `@hypaware/otel`. */
export const PARTITION_LABEL = 'all'

/**
 * The ingest signal the central forward sink POSTs this dataset's rows
 * under (`/v1/ingest/claude_telemetry`). Declared so forwarding never
 * falls back to the dataset name, which is not a signal the server maps.
 *
 * @ref LLP 0255#owned-by-claude [implements]: registration sets the source
 *   signal so the rows forward centrally by the same rules message rows follow
 */
export const TELEMETRY_EVENTS_SOURCE_SIGNAL = 'claude_telemetry'

/**
 * One row per event. The typed columns are the fields queries filter and
 * group by; everything else the event carried rides in `attributes`.
 *
 * @ref LLP 0255#row-shape [implements]: hot fields typed (event name, session
 *   id, tool name, decision, decision source, cost), attributes JSON for the
 *   rest
 * @ref LLP 0070#derive [implements]: `cwd` is not ergonomics, it is the key
 *   the export seam derives its withholding verdict from. A dataset that
 *   forwards under a source signal and carries no `cwd` is one the
 *   `local-only` filter can never fire on, so the column is a privacy
 *   requirement here, not a query convenience.
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const CLAUDE_TELEMETRY_EVENT_COLUMNS = Object.freeze([
  { name: 'event_name',      type: 'STRING',    nullable: false },
  { name: 'event_timestamp', type: 'TIMESTAMP', nullable: true  },
  { name: 'session_id',      type: 'STRING',    nullable: true  },
  { name: 'tool_name',       type: 'STRING',    nullable: true  },
  { name: 'decision',        type: 'STRING',    nullable: true  },
  { name: 'source',          type: 'STRING',    nullable: true  },
  { name: 'cost_usd',        type: 'DOUBLE',    nullable: true  },
  { name: 'cwd',             type: 'STRING',    nullable: true  },
  { name: 'attributes',      type: 'JSON',      nullable: true  },
])

/**
 * On-disk spool table path under the kernel-managed cache. The listener
 * writes through `ctx.storage.appendRows`; the storage service owns
 * durable spool and Iceberg flush details.
 *
 * @param {QueryStorageService} storage
 */
export function claudeTelemetryTablePath(storage) {
  return storage.cacheTablePath(TELEMETRY_EVENTS_DATASET, [PARTITION_LABEL])
}

/**
 * Turn decoded events into `claude_telemetry_events` rows, one per
 * event.
 *
 * The conversation half of the stream never lands here: content events
 * are projected into `ai_gateway_messages` (their home), and the body
 * pointer events are transport for that same projection, carrying
 * nothing but a spool path. Everything else is behavior, including
 * names this listener has never seen: an upstream event we do not model
 * still lands with its attributes, rather than being discarded.
 *
 * `cwdFor` resolves a session id to the directory the SessionStart hook
 * recorded for it, the same lookup the ingest policy gate decided on. It is
 * required rather than optional: a caller that omits it writes rows with a
 * null `cwd`, which both the export and query seams read as `full`, which is
 * precisely the leak issue #878 was. Putting it in the signature puts that
 * mistake in front of the type checker instead of leaving it silent. It may
 * still answer `undefined` for a session it holds no record for; those events
 * are withheld at ingest as undetermined, so the listener never reaches here
 * with one.
 *
 * @ref LLP 0257#failure-modes [implements]: an unrecognized event name is
 *   recorded with its attributes, not discarded
 * @param {ClaudeTelemetryEvent[]} events
 * @param {{ cwdFor: (sessionId: string) => string | undefined }} opts
 * @returns {Record<string, unknown>[]}
 */
export function claudeTelemetryEventRows(events, opts) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const event of events) {
    if (CONTENT_EVENT_NAMES.includes(event.name)) continue
    if (BODY_EVENT_NAMES.includes(event.name)) continue
    rows.push(rowFromEvent(event, opts.cwdFor))
  }
  return rows
}

/**
 * @param {ClaudeTelemetryEvent} event
 * @param {((sessionId: string) => string | undefined) | undefined} cwdFor
 * @returns {Record<string, unknown>}
 */
function rowFromEvent(event, cwdFor) {
  const sessionId = stringOf(event.attributes['session.id'])
  const toolName = stringOf(event.attributes.tool_name)
  const decision = stringOf(event.attributes.decision)
  const source = stringOf(event.attributes.source)
  const costUsd = numberOf(event.attributes.cost_usd)

  /** @type {Record<string, unknown>} */
  const promoted = {
    'session.id': sessionId,
    tool_name: toolName,
    decision,
    source,
    cost_usd: costUsd,
  }

  /** @type {Record<string, unknown>} */
  const attributes = {}
  for (const [key, value] of Object.entries(event.attributes)) {
    if (value === undefined) continue
    if (key === 'event.name' || key === 'event.timestamp') continue
    // A hot key whose value did not fit its typed column (a non-string
    // `decision`, say) stays in the JSON rather than vanishing: the
    // split is ergonomics, not a completeness filter.
    if (key in promoted && promoted[key] !== undefined) continue
    attributes[key] = value
  }

  // The cwd of the session this event names, from the hook record the ingest
  // verdict was resolved against. An event naming no session resolves to null:
  // there is no cwd to look up, and the export seam reads a null cwd as `full`
  // (the same polarity `ai_gateway_messages` has always had).
  // @ref LLP 0070#granularity [implements]: the withholding key is per row,
  //   keyed on the row's own cwd, so a session that moves between a synced and
  //   a local-only tree is filtered event by event rather than wholesale
  const cwd = sessionId !== undefined && cwdFor !== undefined ? stringOf(cwdFor(sessionId)) : undefined

  return {
    event_name: event.name,
    event_timestamp: event.timestamp ?? null,
    session_id: sessionId ?? null,
    tool_name: toolName ?? null,
    decision: decision ?? null,
    source: source ?? null,
    cost_usd: costUsd ?? null,
    cwd: cwd ?? null,
    attributes,
  }
}

/**
 * The `DatasetRegistration` `activate()` hands `ctx.query.registerDataset`.
 *
 * There is deliberately no pre-write dedupe on this dataset: the stream
 * has one producer that POSTs each batch once, the listener writes the
 * event rows only after the message-dataset write succeeded (so an
 * exporter retry after a failed request re-attempts a write that never
 * happened), and the one residual window - a retry after a success
 * response was lost in transit - produces byte-identical rows that
 * cache compaction's content-hash layer collapses.
 *
 * There is also no `attribution_column`: every row is a `claude` row by
 * construction, so the dataset-scoped withholding rule (which withholds
 * the whole dataset once its declared owner is opted out) covers it
 * exactly, with no per-row column needed.
 *
 * @returns {DatasetRegistration}
 */
export function claudeTelemetryDatasetRegistration() {
  return {
    name: TELEMETRY_EVENTS_DATASET,
    plugin: PLUGIN_NAME,
    schema: { columns: [...CLAUDE_TELEMETRY_EVENT_COLUMNS] },
    sourceSignal: TELEMETRY_EVENTS_SOURCE_SIGNAL,
    primaryTimestampColumn: 'event_timestamp',
    // No `localOnlyContentColumns`: that declaration is for derived
    // tables whose unprovenanced rows may AGGREGATE local-only content.
    // These rows are not derived and they are not unprovenanced: every
    // row a session names carries that session's `cwd`, so both the
    // export seam (LLP 0070) and the query seam (LLP 0105) filter it
    // per row, exactly as they filter `ai_gateway_messages`. Ingest
    // covers the class above `local-only`: an ignored session's events
    // are dropped before any row is written (LLP 0254 #policy-inline).
    // @ref LLP 0105#graph-provenance [constrained-by]: content-column
    //   suppression is the fallback for rows that cannot prove their
    //   provenance; these prove it with `cwd`, so per-row withholding
    //   applies instead and ordinary callers keep their attributes
    discoverPartitions: discoverParts,
    refreshPartition: async () => /** @type {DatasetRefreshResult} */ ({ status: 'skipped', rows: 0 }),
    createDataSource,
  }
}

/**
 * List the spool partition (so pending rows flush during query
 * settlement) plus every committed `source=` partition on disk, the
 * same way the OTLP receiver's datasets discover theirs.
 *
 * @param {DatasetDiscoveryContext} ctx
 * @returns {Promise<QueryPartition[]>}
 */
async function discoverParts(ctx) {
  const cacheDir = ctx.cacheDir ?? ''
  if (!cacheDir) return []

  /** @type {QueryPartition[]} */
  const partitions = []
  /** @type {Set<string>} */
  const seen = new Set()

  const spoolPath = path.join(cacheDir, 'datasets', TELEMETRY_EVENTS_DATASET, PARTITION_LABEL)
  partitions.push({
    dataset: TELEMETRY_EVENTS_DATASET,
    partition: { partition: PARTITION_LABEL },
    tablePath: spoolPath,
  })
  seen.add(spoolPath)

  const discovered = await discoverCachePartitions(cacheDir, { datasets: [TELEMETRY_EVENTS_DATASET] })
  for (const p of discovered) {
    if (seen.has(p.path)) continue
    seen.add(p.path)
    partitions.push({ dataset: TELEMETRY_EVENTS_DATASET, partition: p.partition, tablePath: p.path })
  }

  return partitions
}

/**
 * Union every discovered partition's source. Re-discovers from the live
 * cache root so rows flushed out of the spool during settlement (after
 * the initial `discoverParts`) are picked up.
 *
 * @param {QueryPartition[]} partitions
 * @param {DatasetDataSourceContext} ctx
 */
async function createDataSource(partitions, ctx) {
  const storage = /** @type {ExtendedQueryStorageService} */ (ctx.storage)

  const fresh = await discoverCachePartitions(storage.cacheRoot, { datasets: [TELEMETRY_EVENTS_DATASET] })

  /** @type {Set<string>} */
  const tablePaths = new Set()
  for (const p of partitions) {
    if (p.tablePath) tablePaths.add(p.tablePath)
  }
  for (const p of fresh) tablePaths.add(p.path)

  /** @type {AsyncDataSource[]} */
  const sources = []
  for (const tablePath of tablePaths) {
    const source = await storage.dataSourceForTable(tablePath)
    // Skip only sources KNOWN empty. icebird omits numRows when the current
    // snapshot carries position deletes (a live count would need a scan), so
    // treating undefined as 0 here would silently drop every partition touched
    // by a retention or purge delete and blind all queries to surviving rows.
    // @ref LLP 0104 [constrained-by]: position deletes leave an unknowable count that must not read as an empty partition
    if (source && source.numRows !== 0) sources.push(source)
  }

  if (sources.length === 0) return emptySource(CLAUDE_TELEMETRY_EVENT_COLUMNS.map((c) => c.name))
  if (sources.length === 1) return sources[0]
  return unionSources(sources)
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
