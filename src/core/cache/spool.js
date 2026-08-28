// @ts-check

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

import { atomicWriteJson } from '../util/fs_atomic.js'
import { createIngestSeqAllocator } from './ingest-seq.js'
import { readProgress, removeProgress, streamFlushFile, writeProgress } from './streaming-reader.js'

/**
 * @import { FileHandle } from 'node:fs/promises'
 * @import { ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CacheSpool, FlushResult } from '../../../src/core/cache/types.js'
 */

export const SPOOL_DIR = '_hypaware_spool'
export const DEFAULT_SPOOL_BYTES_THRESHOLD = 512 * 1024 * 1024
export const QUERY_FLUSH_DEBOUNCE_MS = 2 * 60 * 1000

const ACTIVE_FILE = 'active.jsonl'
const FLUSH_PREFIX = 'flush-'
const FLUSH_SUFFIX = '.jsonl'
const LAST_FLUSH_FILE = 'last-flush.json'

/**
 * @param {{
 *   cacheRoot: string,
 *   appendChunk(tablePath: string, columns: readonly ColumnSpec[], rows: Record<string, unknown>[]): Promise<{ bytesWritten: number, droppedCount?: number }>,
 *   batchRowLimit?: number,
 *   batchByteLimit?: number,
 * }} args
 * @returns {CacheSpool}
 */
export function createCacheSpool(args) {
  /** @type {Map<string, { writeLock: Promise<unknown>, flushLock: Promise<unknown> }>} */
  const states = new Map()
  /** @type {Set<string>} */
  const knownTables = new Set()
  // One cache-global allocator shared across every table's flush, so a seq is
  // monotonic across the whole cache (and thus strictly increasing within each
  // destination partition, which can receive rows from more than one spool path).
  const seqAllocator = createIngestSeqAllocator({ cacheRoot: args.cacheRoot })

  /**
   * @param {string} tablePath
   */
  function stateFor(tablePath) {
    knownTables.add(tablePath)
    let state = states.get(tablePath)
    if (!state) {
      state = { writeLock: Promise.resolve(), flushLock: Promise.resolve() }
      states.set(tablePath, state)
    }
    return state
  }

  /**
   * @template T
   * @param {string} tablePath
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withWriteLock(tablePath, fn) {
    const state = stateFor(tablePath)
    const next = state.writeLock.catch(() => undefined).then(fn)
    state.writeLock = next.catch(() => undefined)
    return next
  }

  /**
   * @template T
   * @param {string} tablePath
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withFlushLock(tablePath, fn) {
    const state = stateFor(tablePath)
    const next = state.flushLock.catch(() => undefined).then(fn)
    state.flushLock = next.catch(() => undefined)
    return next
  }

  return {
    async append(tablePath, columns, rows) {
      if (rows.length === 0) {
        return { bytesWritten: 0, pendingBytes: pendingBytesSync(tablePath) }
      }
      const line = JSON.stringify({ version: 1, columns, rows }, spoolReplacer) + '\n'
      const bytesWritten = Buffer.byteLength(line, 'utf8')
      const result = await withWriteLock(tablePath, async () => {
        const dir = spoolDir(tablePath)
        await fs.mkdir(dir, { recursive: true })
        // Opened `a+` rather than `a`: writes still append, and the read
        // side is what lets a failed append verify the tail is its own
        // bytes before truncating them (see `discardTail`).
        const handle = await fs.open(path.join(dir, ACTIVE_FILE), 'a+')
        // An append either lands in the spool or it does not, and the
        // outcome says which. Callers read a rejection as "nothing landed"
        // and re-derive what to write from the spool - `dedupeStoredPartIds`
        // in the AI gateway's exchange writer rescans the committed
        // partitions plus the spool on every call - so the spool has to
        // tell the truth about what is in it. A rejection that left a torn
        // record behind is the expensive half: the remnant carries no
        // newline, so it swallows the NEXT record into one malformed line
        // the flush reader drops. A rejection over a durable record is the
        // other half, reporting landed rows as lost for a fault that cost
        // nothing. Both are handled here rather than by asking every caller
        // to reason about which syscall failed (issues #879, #924).
        try {
          const startSize = (await handle.stat()).size
          try {
            await handle.writeFile(line, 'utf8')
            await handle.sync()
          } catch (err) {
            // `writeFile` can fail with a prefix of the line already in the
            // file; that remnant has no trailing newline, so leaving it
            // would also swallow the NEXT record into one malformed line.
            const retained = await discardTail(handle, startSize, line)
            // The rollback can find the whole line already written and be
            // refused the truncate that would take it back: an fsync and an
            // ftruncate can fail on the same device. The record is complete
            // and newline-terminated, so the next flush commits it, and
            // rejecting here would tell the caller to replay rows that
            // landed, which is the double commit this path exists to
            // prevent. Same reasoning as the close failure below: an error
            // that cannot un-write the record does not decide the outcome.
            if (!retained) throw err
          }
        } finally {
          // Past the sync the record is durable, and closing the handle
          // cannot un-write it. A close failure is a descriptor problem
          // with nothing the caller can do about it, so it never decides
          // the outcome: on the failure path above the original error
          // stays the one that propagates.
          await handle.close().catch(() => undefined)
        }
        return { bytesWritten, pendingBytes: pendingBytesSync(tablePath) }
      })
      return result
    },

    async flushTable(tablePath, opts = {}) {
      return withFlushLock(tablePath, async () => {
        const reason = opts.reason ?? 'manual'
        await withWriteLock(tablePath, async () => {
          await rotateActiveFile(tablePath)
        })

        const files = listFlushFiles(tablePath)
        if (files.length === 0) {
          return { flushed: false, rowCount: 0, chunkCount: 0, bytesWritten: 0, pendingBytes: pendingBytesSync(tablePath), malformedCount: 0, droppedCount: 0, reason }
        }

        let rowCount = 0
        let chunkCount = 0
        let bytesWritten = 0
        let malformedCount = 0
        let droppedCount = 0
        for (const filePath of files) {
          const progress = await readProgress(filePath)
          const startOffset = progress?.byteOffset ?? 0
          const batchId = `flush-${Date.now()}-${process.pid}`
          let fileMalformed = 0

          for await (const batch of streamFlushFile({ filePath, batchId, startOffset, batchRowLimit: args.batchRowLimit, batchByteLimit: args.batchByteLimit, nextSeq: seqAllocator.next })) {
            const written = await args.appendChunk(tablePath, batch.chunk.columns, batch.chunk.rows)
            rowCount += batch.chunk.rows.length
            chunkCount += 1
            bytesWritten += written.bytesWritten
            droppedCount += written.droppedCount ?? 0
            fileMalformed += batch.malformedCount
            await writeProgress(filePath, batch.resumeOffset)
          }

          malformedCount += fileMalformed
          await removeProgress(filePath)
          await fs.rm(filePath, { force: true })
        }
        if (chunkCount > 0) {
          await writeLastFlush(tablePath, { rowCount, bytesWritten })
        }
        return { flushed: chunkCount > 0, rowCount, chunkCount, bytesWritten, pendingBytes: pendingBytesSync(tablePath), malformedCount, droppedCount, reason }
      })
    },

    async flushAll(opts = {}) {
      const tables = new Set([...knownTables, ...(await discoverSpoolTables(args.cacheRoot))])
      /** @type {FlushResult} */
      const total = {
        flushed: false,
        rowCount: 0,
        chunkCount: 0,
        bytesWritten: 0,
        pendingBytes: 0,
        malformedCount: 0,
        droppedCount: 0,
        reason: opts.reason ?? 'manual',
      }
      for (const tablePath of tables) {
        const result = await this.flushTable(tablePath, opts)
        total.flushed ||= result.flushed
        total.rowCount += result.rowCount
        total.chunkCount += result.chunkCount
        total.bytesWritten += result.bytesWritten
        total.pendingBytes += result.pendingBytes
        total.malformedCount += result.malformedCount
        total.droppedCount += result.droppedCount
      }
      return total
    },

    async pendingInfo(tablePath) {
      knownTables.add(tablePath)
      return {
        pending: hasPendingSync(tablePath),
        pendingBytes: pendingBytesSync(tablePath),
        lastFlushAtMs: await readLastFlushAt(tablePath),
      }
    },

    hasPendingSync(tablePath) {
      knownTables.add(tablePath)
      return hasPendingSync(tablePath)
    },

    readSpooledRows(tablePath) {
      return readSpooledRows(tablePath)
    },
  }
}

/**
 * Read every row currently pending in a table's spool: the rows that
 * `append` wrote but `flushTable` has not yet committed to Iceberg.
 * Walks `active.jsonl` and every rotated `flush-*.jsonl`, parsing each
 * line's `{ version, columns, rows }` envelope and yielding the raw
 * `rows`. This is a read-only inspection surface; it never rotates,
 * removes, or advances flush progress, so it is safe to call alongside
 * live capture. Any error (missing dir, unreadable file, malformed
 * line) degrades to skipping that file/line rather than throwing: the
 * spool is provisional (LLP 0013) and a partial read is always better
 * than aborting the caller.
 *
 * @param {string} tablePath
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
async function* readSpooledRows(tablePath) {
  const dir = spoolDir(tablePath)
  /** @type {string[]} */
  let names = []
  try {
    names = fsSync
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSpoolDataFile(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return
  }
  for (const name of names) {
    // Stream the spool file line-by-line instead of `fs.readFile(name,'utf8') +
    // split('\n')`. A provisional spool file (LLP 0013) can reach
    // DEFAULT_SPOOL_BYTES_THRESHOLD (512 MB) of content-heavy envelopes before it
    // flushes; reading it whole held ~2x that (the file as one V8 string plus the
    // split-line array) resident before yielding a single row, OOMing a
    // large-backfill dedupe scan on an async utf8 decode (issue #280). The bounded
    // 64 KB read mirrors streamFlushFile's line loop.
    let stream
    try {
      stream = fsSync.createReadStream(path.join(dir, name), { encoding: 'utf8', highWaterMark: 64 * 1024 })
    } catch {
      continue
    }
    let tail = ''
    try {
      for await (const chunk of stream) {
        tail += chunk
        let newlineIdx
        while ((newlineIdx = tail.indexOf('\n')) !== -1) {
          const line = tail.slice(0, newlineIdx)
          tail = tail.slice(newlineIdx + 1)
          yield* rowsFromSpoolLine(line)
        }
      }
      // The spool writer always terminates lines with `\n`, so a non-empty tail
      // is a truncated/half-written final line. The whole-file reader parsed it
      // best-effort (its `split('\n')` kept a trailing no-newline segment), so
      // keep that parity: a malformed remnant simply fails JSON.parse and drops.
      yield* rowsFromSpoolLine(tail)
    } catch {
      // A mid-read error (file vanished/unreadable) degrades to skipping the
      // rest of this file, matching the whole-file reader's per-file try/catch:
      // a partial read of a provisional spool beats aborting the caller.
      continue
    }
  }
}

/**
 * Parse one spool NDJSON line and yield its valid rows. Mirrors
 * `streamFlushFile`'s envelope-validity contract exactly: a parseable envelope
 * missing `columns` is malformed, and the flush reader drops it (its rows never
 * reach a committed partition). Backfill dedupe must skip the same rows,
 * otherwise it would dedupe against (and so refuse to materialize) rows flush
 * will never commit. An empty line or a JSON parse failure yields nothing.
 *
 * @param {string} line
 * @returns {Generator<Record<string, unknown>>}
 */
function* rowsFromSpoolLine(line) {
  if (line.length === 0) return
  /** @type {{ version?: number, columns?: unknown, rows?: unknown } | null} */
  let envelope = null
  try {
    envelope = JSON.parse(line)
  } catch {
    return
  }
  if (
    !envelope ||
    envelope.version !== 1 ||
    !Array.isArray(envelope.columns) ||
    !Array.isArray(envelope.rows)
  ) return
  for (const row of envelope.rows) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      yield /** @type {Record<string, unknown>} */ (row)
    }
  }
}

/**
 * Roll a failed append off the tail of the active spool file, so a
 * rejected `append` really does mean "the record is not in the spool".
 *
 * The tail is compared byte for byte against the line this append tried
 * to write, and only an exact prefix match is truncated. `append` holds
 * the per-table write lock, so nothing in THIS process can have appended
 * behind us, but nothing locks `active.jsonl` across processes: two `hyp`
 * runs can share one table's spool. A size ceiling alone would not catch
 * that, because a small concurrent record fits inside the bytes this
 * append could have produced; comparing the content does, and discarding
 * another writer's durable rows to tidy up ours would be the worse trade.
 *
 * The content check narrows the cross-process hazard, it does not close
 * it: reading the tail and truncating it are two syscalls, so a foreign
 * record appended in between still sits inside the range this truncate
 * drops, and a torn prefix that lands BEFORE a foreign line takes that
 * line down with it whatever the rollback does. Closing those needs an
 * advisory lock over `active.jsonl`, which the spool does not have.
 *
 * Best effort past that: the device that just refused a write or an fsync
 * may refuse the truncate too. When it does a torn remnant gets a closing
 * newline instead, which is the difference between this failed append
 * costing its own rows and costing the next record as well.
 *
 * @param {FileHandle} handle
 * @param {number} startSize
 * @param {string} line
 * @returns {Promise<boolean>} true when the rollback left the whole record
 *   in the spool intact, so a later flush will commit it and the append
 *   must not be reported as failed
 */
async function discardTail(handle, startSize, line) {
  try {
    const { size } = await handle.stat()
    const written = size - startSize
    const expected = Buffer.from(line, 'utf8')
    if (written <= 0 || written > expected.length) return false
    const tail = Buffer.alloc(written)
    const { bytesRead } = await handle.read(tail, 0, written, startSize)
    if (bytesRead !== written || !tail.equals(expected.subarray(0, written))) return false
    try {
      await handle.truncate(startSize)
    } catch {
      // A whole line is already terminated and already committable: there
      // is nothing to repair, and nothing for the caller to replay.
      if (written === expected.length) return true
      // Terminate the remnant so the flush reader drops that line alone
      // instead of concatenating it with whatever is appended next.
      await handle.writeFile('\n', 'utf8')
      return false
    }
    await handle.sync()
    return false
  } catch {
    /* the write path is already failing; the tail stays as it is */
    return false
  }
}

/**
 * @param {string} name
 */
function isSpoolDataFile(name) {
  return name === ACTIVE_FILE || (name.startsWith(FLUSH_PREFIX) && name.endsWith(FLUSH_SUFFIX))
}

/**
 * @param {string} tablePath
 */
function spoolDir(tablePath) {
  return path.join(tablePath, SPOOL_DIR)
}

/**
 * @param {string} tablePath
 */
async function rotateActiveFile(tablePath) {
  const dir = spoolDir(tablePath)
  const active = path.join(dir, ACTIVE_FILE)
  let stat
  try {
    stat = await fs.stat(active)
  } catch {
    return
  }
  if (!stat.isFile() || stat.size === 0) return
  const dest = path.join(dir, `${FLUSH_PREFIX}${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}${FLUSH_SUFFIX}`)
  await fs.rename(active, dest)
}

/**
 * @param {string} tablePath
 * @returns {string[]}
 */
function listFlushFiles(tablePath) {
  const dir = spoolDir(tablePath)
  try {
    return fsSync
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(FLUSH_PREFIX) && entry.name.endsWith(FLUSH_SUFFIX))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}


/**
 * @param {string} tablePath
 */
function hasPendingSync(tablePath) {
  return pendingBytesSync(tablePath) > 0
}

/**
 * @param {string} tablePath
 */
function pendingBytesSync(tablePath) {
  const dir = spoolDir(tablePath)
  let total = 0
  try {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (entry.name !== ACTIVE_FILE && !(entry.name.startsWith(FLUSH_PREFIX) && entry.name.endsWith(FLUSH_SUFFIX))) continue
      try {
        total += fsSync.statSync(path.join(dir, entry.name)).size
      } catch {
        /* file may have been rotated concurrently */
      }
    }
  } catch {
    return 0
  }
  return total
}

/**
 * @param {string} tablePath
 * @param {{ rowCount: number, bytesWritten: number }} details
 */
async function writeLastFlush(tablePath, details) {
  const payload = {
    flushedAt: new Date().toISOString(),
    rowCount: details.rowCount,
    bytesWritten: details.bytesWritten,
  }
  await atomicWriteJson(path.join(spoolDir(tablePath), LAST_FLUSH_FILE), payload)
}

/**
 * @param {string} tablePath
 * @returns {Promise<number | null>}
 */
async function readLastFlushAt(tablePath) {
  try {
    const raw = await fs.readFile(path.join(spoolDir(tablePath), LAST_FLUSH_FILE), 'utf8')
    const parsed = /** @type {{ flushedAt?: unknown }} */ (JSON.parse(raw))
    if (typeof parsed.flushedAt !== 'string') return null
    const ms = Date.parse(parsed.flushedAt)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

/**
 * Every table under the cache that carries a spool directory, found by
 * walking the tree rather than by asking the registry, so a label table
 * nothing has declared yet is still flushed.
 *
 * `datasets` narrows the walk to those dataset directories. The walk
 * recurses into each generation's `data/` directory, which on a mature
 * cache holds thousands of entries, so the unscoped form costs a readdir of
 * every dataset's files. That is the right price for a background sweep
 * (`flushAll`, storage bootstrap) which has to reach every table anyway,
 * and the wrong one for a per-query caller: `hyp query grep` settles one
 * dataset's spool and would otherwise readdir the traces, logs and metrics
 * trees on every search to find it.
 *
 * An EMPTY `datasets` means every dataset, not none, matching the scoping
 * word of `discoverCachePartitions` (`scope.datasets && length > 0`). The
 * two are routinely passed the same computed list, and one reading it as
 * "all" while the other read it as "nothing" would make a caller whose list
 * came out empty walk every partition and flush no spool: the failure would
 * surface as a query answering from a stale cache, not as an error.
 *
 * @param {string} cacheRoot
 * @param {{ datasets?: string[] }} [opts]
 * @returns {Promise<string[]>}
 */
export async function discoverSpoolTables(cacheRoot, opts = {}) {
  /** @type {string[]} */
  const tables = []
  const root = path.join(cacheRoot, 'datasets')
  const scoped = opts.datasets && opts.datasets.length > 0 ? opts.datasets : null
  const roots = scoped ? scoped.map((name) => path.join(root, name)) : [root]
  for (const dir of roots) await walk(dir)
  return tables

  /** @param {string} dir */
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name === SPOOL_DIR) {
        tables.push(path.dirname(full))
        continue
      }
      await walk(full)
    }
  }
}

/**
 * @param {string} _key
 * @param {unknown} value
 */
function spoolReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString()
  return value
}
