import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/**
 * @import { PartitionFile, UploadSignal } from './upload.d.ts'
 */

const DATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/**
 * Read a JSONL file line-by-line and yield each row as a parsed object.
 * Empty lines are skipped. Malformed JSON lines are skipped with a warning
 * to stderr; we'd rather upload most of the day than fail the whole job.
 *
 * @param {string} filePath
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export async function* readJsonlRows(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let lineno = 0
  for await (const line of rl) {
    lineno++
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        yield /** @type {Record<string, unknown>} */ (parsed)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[collectivus] skipping malformed JSONL line ${filePath}:${lineno}: ${message}`)
    }
  }
}

/**
 * Read a JSONL file line-by-line and yield each row tagged with a
 * `_partition` field whose keys mirror the configured partition
 * dimensions. The tag lets downstream parquet conversion attach
 * gateway / service / signal context that lived in the directory path
 * but never made it into the row body itself — D.2 promotes the
 * `gateway_id` partition to a first-class parquet column off this tag.
 *
 * @param {string} filePath
 * @param {Readonly<Record<string, string>>} partition
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export async function* readPartitionRows(filePath, partition) {
  const tag = { ...partition }
  for await (const row of readJsonlRows(filePath)) {
    yield { ...row, _partition: tag }
  }
}

/**
 * Read a proxy JSONL file and yield one bundle per exchange. Each bundle is
 * `{ exchange, streamEvents }`, where `streamEvents` is the in-file list of
 * matching `stream_event` rows sorted by `t_ms` ascending. Bundles are
 * emitted in `exchange.ts_start` ascending order so downstream walkers can
 * trust chronological ordering without re-sorting.
 *
 * The file is read once and fully buffered before bundles are emitted — proxy
 * JSONL is append-only and a single day's file fits in memory at recorder
 * scales. Streaming bundles would force a two-pass design that pays the same
 * cost twice over with no upside.
 *
 * Rows whose `kind` is neither `exchange` nor `stream_event` are skipped.
 * Orphan stream events (no matching exchange) are dropped: a stream event
 * with no anchor exchange has no chronology to sit in.
 *
 * @param {string} filePath
 * @returns {Promise<Array<{ exchange: Record<string, unknown>, streamEvents: Record<string, unknown>[] }>>}
 */
export async function iterExchangesWithStreamEvents(filePath) {
  /** @type {Map<string, Record<string, unknown>>} */
  const exchangeById = new Map()
  /** @type {Map<string, Record<string, unknown>[]>} */
  const eventsById = new Map()
  for await (const row of readJsonlRows(filePath)) {
    const kind = row.kind
    const exchangeId = row.exchange_id
    if (typeof exchangeId !== 'string' || exchangeId.length === 0) continue
    if (kind === 'exchange') {
      exchangeById.set(exchangeId, row)
    } else if (kind === 'stream_event') {
      let list = eventsById.get(exchangeId)
      if (!list) {
        list = []
        eventsById.set(exchangeId, list)
      }
      list.push(row)
    }
  }
  /** @type {Array<{ exchange: Record<string, unknown>, streamEvents: Record<string, unknown>[] }>} */
  const bundles = []
  for (const [id, exchange] of exchangeById) {
    const events = eventsById.get(id) ?? []
    events.sort(compareStreamEvents)
    bundles.push({ exchange, streamEvents: events })
  }
  bundles.sort(compareExchangeBundles)
  return bundles
}

/**
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {number}
 */
function compareStreamEvents(a, b) {
  const aMs = typeof a.t_ms === 'number' ? a.t_ms : Number.POSITIVE_INFINITY
  const bMs = typeof b.t_ms === 'number' ? b.t_ms : Number.POSITIVE_INFINITY
  return aMs - bMs
}

/**
 * @param {{ exchange: Record<string, unknown> }} a
 * @param {{ exchange: Record<string, unknown> }} b
 * @returns {number}
 */
function compareExchangeBundles(a, b) {
  const aStart = stringOrEmpty(a.exchange.ts_start)
  const bStart = stringOrEmpty(b.exchange.ts_start)
  if (aStart === bStart) return 0
  return aStart < bStart ? -1 : 1
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringOrEmpty(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Walk a partitioned directory tree under `outputDir` and yield every
 * `<YYYY-MM-DD>.jsonl` leaf paired with its partition values. Each
 * directory level corresponds to one entry in `partitionDimensions`
 * (e.g. `['gateway_id', 'signal']` -> `<outputDir>/<gateway_id>/<signal>/<date>.jsonl`).
 *
 * Empty intermediate directories are skipped silently so a tenant or
 * signal that has never written anything doesn't surface as a noisy
 * empty job. `signal` MUST be one of the configured partition
 * dimensions so that callers (uploader) can keep filtering by signal.
 *
 * Caller decides date filtering (today / catch-up window) — this walker
 * is pure path discovery.
 *
 * @param {string} outputDir
 * @param {ReadonlyArray<string>} partitionDimensions
 * @returns {Generator<PartitionFile>}
 */
export function* walkPartitionFiles(outputDir, partitionDimensions) {
  if (partitionDimensions.length === 0) {
    throw new Error('walkPartitionFiles: partitionDimensions must not be empty')
  }
  const signalIndex = partitionDimensions.indexOf('signal')
  if (signalIndex === -1) {
    throw new Error(`walkPartitionFiles: 'signal' must be one of partitionDimensions; got ${JSON.stringify(partitionDimensions)}`)
  }
  if (!fs.existsSync(outputDir)) return

  yield* walkLevel(outputDir, partitionDimensions, 0, {})
}

/**
 * Recursive walker. Each invocation handles one directory level; when
 * the level index reaches `dimensions.length`, the directory's date
 * files are yielded.
 *
 * @param {string} dir
 * @param {ReadonlyArray<string>} dimensions
 * @param {number} levelIndex
 * @param {Record<string, string>} accumulated
 * @returns {Generator<PartitionFile>}
 */
function* walkLevel(dir, dimensions, levelIndex, accumulated) {
  if (levelIndex === dimensions.length) {
    yield* readDateFiles(dir, accumulated)
    return
  }
  const dimension = dimensions[levelIndex]
  /** @type {fs.Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const value = entry.name
    yield* walkLevel(
      path.join(dir, value),
      dimensions,
      levelIndex + 1,
      { ...accumulated, [dimension]: value }
    )
  }
}

/**
 * Yield every `<YYYY-MM-DD>.jsonl` regular file in `dir` with the
 * accumulated partition values copied onto each result.
 *
 * @param {string} dir
 * @param {Record<string, string>} accumulated
 * @returns {Generator<PartitionFile>}
 */
function* readDateFiles(dir, accumulated) {
  /** @type {fs.Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = DATE_FILE_PATTERN.exec(entry.name)
    if (!match) continue
    const partition = { ...accumulated }
    yield {
      filePath: path.join(dir, entry.name),
      partition,
      signal: /** @type {UploadSignal} */ (partition.signal),
      date: match[1],
    }
  }
}
