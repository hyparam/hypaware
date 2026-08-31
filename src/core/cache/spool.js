// @ts-check

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

import { Attr, getLogger } from '../observability/index.js'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { isConfirmedSymlink } from './paths.js'
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
// How long a failed flush holds the automatic query gate closed. Ten minutes,
// not LLP 0319's six hours: the re-settle scan already had the hourly tick as
// a cadence and needed a slower one, while the query gate has no cadence at
// all, so this window is the cadence. Kept under the maintenance interval so a
// repair that lands there is picked up by the next query in the same hour.
// @ref LLP 0322#stamp-the-failure [implements]: the window a standing failure stamp holds the auto gate closed
export const QUERY_FLUSH_FAILURE_COOLDOWN_MS = 10 * 60 * 1000

const ACTIVE_FILE = 'active.jsonl'
const FLUSH_PREFIX = 'flush-'
const FLUSH_SUFFIX = '.jsonl'
const LAST_FLUSH_FILE = 'last-flush.json'
const FLUSH_FAILURE_FILE = 'last-flush-failure.json'
// The writer's bound and the reader's. The stamp is a file on disk, so a build
// that reads one it did not write cannot rely on the writer having clamped it.
const FLUSH_FAILURE_MESSAGE_MAX = 512

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

  /**
   * Move one set of already-rotated flush files into the cache, accumulating
   * into `totals`. Throws on the first append the cache rejects, leaving the
   * remaining files where they are for a later attempt.
   *
   * @param {string} tablePath
   * @param {string[]} files
   * @param {{ rowCount: number, chunkCount: number, bytesWritten: number, malformedCount: number, droppedCount: number }} totals
   */
  async function drainFlushFiles(tablePath, files, totals) {
    for (const filePath of files) {
      const progress = await readProgress(filePath)
      const startOffset = progress?.byteOffset ?? 0
      const batchId = `flush-${Date.now()}-${process.pid}`
      let fileMalformed = 0

      for await (const batch of streamFlushFile({ filePath, batchId, startOffset, batchRowLimit: args.batchRowLimit, batchByteLimit: args.batchByteLimit, nextSeq: seqAllocator.next })) {
        const written = await args.appendChunk(tablePath, batch.chunk.columns, batch.chunk.rows)
        totals.rowCount += batch.chunk.rows.length
        totals.chunkCount += 1
        totals.bytesWritten += written.bytesWritten
        totals.droppedCount += written.droppedCount ?? 0
        fileMalformed += batch.malformedCount
        await writeProgress(filePath, batch.resumeOffset)
      }

      totals.malformedCount += fileMalformed
      await removeProgress(filePath)
      await fs.rm(filePath, { force: true })
    }
  }

  /**
   * The flush body. Lifted out of `flushTable` so the failure stamp write
   * and the stamp clear wrap every exit from it, the early return included.
   *
   * @param {string} tablePath
   * @param {{ reason?: string, force?: boolean }} opts
   * @returns {Promise<FlushResult>}
   */
  async function runFlush(tablePath, opts) {
    const reason = opts.reason ?? 'manual'
    const totals = { rowCount: 0, chunkCount: 0, bytesWritten: 0, malformedCount: 0, droppedCount: 0 }

    // A rotation while a failure stands only adds a file to a set nothing is
    // draining: the waiting files cannot be read past the append that
    // rejected them, so the retry has the same work either way. Skipping it
    // keeps the stranded set fixed instead of growing it once per attempt,
    // and lets new rows coalesce in the active file.
    //
    // This has to cover forced calls too, or it does not bound anything: the
    // sink adapters flush with `force: true` once per partition per export
    // tick and the driver's default schedule is every minute, so exempting
    // `force` would move the growth off query traffic and onto a cron that
    // strands ~1440 files a day per partition.
    // One refusal line per flush pass, which is the rate LLP 0329
    // #consequences priced ("one line per refusing flush or sweep pass"). This
    // pass lists the spool up to three times and every list re-asks the guard,
    // so without a shared budget one refusing flush says the same thing twice,
    // once a minute per partition on the sink driver's default schedule, into
    // a daemon log the service manager appends to and never truncates. A box
    // rather than a positional flag so the first list that refuses is the one
    // that speaks, wherever in the pass that turns out to be: a symlink
    // planted after the opening list still gets said out loud once.
    // @ref LLP 0329#consequences [constrained-by]: a refusing pass costs one stderr line, and it costs it again next pass
    const saidRefusal = { yet: false }

    // @ref LLP 0322#coalesce-the-retry [implements]: a retry under a standing stamp reuses the files already rotated
    const stranded = listFlushFiles(tablePath, saidRefusal)
    const coalescing = stranded.length > 0 && (await readFlushFailedAt(tablePath)) !== null
    if (!coalescing) {
      await withWriteLock(tablePath, async () => {
        await rotateActiveFile(tablePath)
      })
    }

    await drainFlushFiles(tablePath, coalescing ? stranded : listFlushFiles(tablePath, saidRefusal), totals)

    // Reaching here from a coalesced pass means the cache accepted the very
    // rows it was rejecting, so the condition that suppressed the rotation is
    // over and the skipped rows are drained in the same call. Without this a
    // completed flush would return `flushed: true` having knowingly left
    // `active.jsonl` behind, which breaks both halves of the contract: a
    // forced caller ("everything captured so far is committed once this
    // resolves" - `--refresh always`, `hyp query refresh`, the post-backfill
    // commit, the sink export paths) would silently export without those
    // rows, and `writeLastFlush` below would re-arm the query debounce over
    // rows it had just decided to skip, hiding them for another window.
    // @ref LLP 0322#coalesce-the-retry [implements]: a coalesced flush that completes rotates and drains before it returns
    // @ref LLP 0321#decision [constrained-by]: forced refresh stays strict, so a flush that resolves has moved everything
    if (coalescing) {
      await withWriteLock(tablePath, async () => {
        await rotateActiveFile(tablePath)
      })
      await drainFlushFiles(tablePath, listFlushFiles(tablePath, saidRefusal), totals)
    }

    if (totals.chunkCount > 0) {
      await writeLastFlush(tablePath, { rowCount: totals.rowCount, bytesWritten: totals.bytesWritten })
    }
    return { flushed: totals.chunkCount > 0, rowCount: totals.rowCount, chunkCount: totals.chunkCount, bytesWritten: totals.bytesWritten, pendingBytes: pendingBytesSync(tablePath), malformedCount: totals.malformedCount, droppedCount: totals.droppedCount, reason }
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
        try {
          const result = await runFlush(tablePath, opts)
          // Any completed attempt retires the stamp, including one that found
          // nothing to move: the stamp asserts that the last attempt failed,
          // and this one did not.
          // @ref LLP 0322#clearing [implements]: a flush that completed is the evidence that clears the stamp
          await clearFlushFailure(tablePath)
          return result
        } catch (err) {
          // Written before the rethrow so the error the caller sees is
          // unchanged, and so the very next query can pace itself off a
          // failure this process is about to forget.
          // @ref LLP 0322#stamp-the-failure [implements]: the failed flush leaves the pacing record the query gate reads
          await writeFlushFailure(tablePath, err)
          throw err
        }
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
      // Every table gets its attempt before the first error surfaces: a
      // failing table must not strand the flush (and the stamp refresh,
      // via `flushTable` above) of every table behind it in iteration
      // order. Callers keep the throw-on-failure contract they had; only
      // the abort order changes.
      // @ref LLP 0333#every-table-before-failure [implements]: attempt every table, then rethrow the first error
      let failed = false
      /** @type {unknown} */
      let firstError
      for (const tablePath of tables) {
        /** @type {FlushResult} */
        let result
        try {
          result = await this.flushTable(tablePath, opts)
        } catch (err) {
          if (!failed) {
            failed = true
            firstError = err
          }
          continue
        }
        total.flushed ||= result.flushed
        total.rowCount += result.rowCount
        total.chunkCount += result.chunkCount
        total.bytesWritten += result.bytesWritten
        total.pendingBytes += result.pendingBytes
        total.malformedCount += result.malformedCount
        total.droppedCount += result.droppedCount
      }
      if (failed) throw firstError
      return total
    },

    async pendingInfo(tablePath) {
      knownTables.add(tablePath)
      const failure = await readFlushFailure(tablePath)
      return {
        pending: hasPendingSync(tablePath),
        pendingBytes: pendingBytesSync(tablePath),
        lastFlushAtMs: await readLastFlushAt(tablePath),
        // Both halves of the stamp, not only its time. A caller that reports
        // the cooldown can then say what the flush failed with, which is the
        // one fact the cooldown itself withholds. Still pacing state and not a
        // verdict: neither field is read as a claim about what the spool or
        // the cache holds, and `pending`/`pendingBytes` above are untouched.
        // @ref LLP 0322#what-the-stamp-is-not [implements]: the stamp reaches a reader as a reason, never as a freshness or durability claim
        flushFailedAtMs: failure?.failedAtMs ?? null,
        flushFailureMessage: failure?.errorMessage ?? null,
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
 * Say that the flush refused a spool directory, and say it out loud.
 *
 * The symptom is otherwise a partition that silently stops committing: rows
 * still append, the flush still returns, and nothing reports that the files
 * it would have drained are somewhere the cache does not own. `ls -l` at the
 * logged path answers in one line.
 *
 * @ref LLP 0329#stderr-mirror [implements]: the refusal leaves every counter at zero, so it opts into the mirror that exists without a provider.
 * @param {string} tablePath
 * @param {string} dir
 */
function reportPlantedSpoolDir(tablePath, dir) {
  try {
    getLogger('cache', { mirrorStderr: true }).warn('the spool directory is a symlink; draining nothing for this table', {
      [Attr.OPERATION]: 'cache.spool_flush',
      [Attr.ERROR_KIND]: 'spool_dir_is_symlink',
      table_path: tablePath,
      spool_dir: dir,
    })
  } catch { /* a flush must not fail on a logger provider that is not installed */ }
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
 * The rotated files a flush will read, drain into the cache, and then
 * unlink.
 *
 * `_hypaware_spool` is a fixed name inside the partition, so it is the same
 * door LLP 0326#one-level-down closed in the maintenance sweeps, reached
 * without a cursor: `readdir` follows a symlinked directory, the entries it
 * lists are real files, and `drainFlushFiles` removes each one by path once
 * it has read it. Measured on this branch before this guard: a planted
 * `<partition>/_hypaware_spool -> <outside>` with a `flush-*.jsonl` name in
 * `<outside>` had that file read into the cache and then unlinked, while a
 * differently named neighbour survived. Nothing in the tree mints a symlink
 * here, so a confirmed one means this is not the spool to drain.
 *
 * This one function rather than `spoolDir`: it is the list every read and
 * every unlink comes from, and returning nothing can only make a flush do
 * less. Refusing inside `spoolDir` would instead fail `append`, which is
 * the contract that decides whether a caller replays rows.
 *
 * The guard is asked on every call, because every call is a list a drain
 * would act on, and re-asking is one `lstat`. Saying so is the half with a
 * standing cost, so the report is spent from the calling pass's budget
 * instead: the first list that refuses says it, and the rest of that pass
 * stays quiet.
 *
 * @ref LLP 0326#one-level-down [implements]: a pass that unlinks by path checks the path it will walk.
 * @ref LLP 0329#consequences [constrained-by]: the refusal is priced per refusing pass, not per list the pass makes.
 * @param {string} tablePath
 * @param {{ yet: boolean }} saidRefusal  the calling pass's one-line budget,
 *   flipped by the first list that refuses
 * @returns {string[]}
 */
function listFlushFiles(tablePath, saidRefusal) {
  const dir = spoolDir(tablePath)
  if (isConfirmedSymlink(dir)) {
    if (!saidRefusal.yet) {
      saidRefusal.yet = true
      reportPlantedSpoolDir(tablePath, dir)
    }
    return []
  }
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
 * Record that this table's last flush attempt threw. Deliberately a separate
 * file from `last-flush.json` rather than a poisoned `flushedAt`: the
 * freshness line the user reads quotes that timestamp as the age of the last
 * write to the cache, and a failed attempt is not one.
 *
 * @ref LLP 0322#what-the-stamp-is-not [implements]: pacing state kept apart from the freshness report it must not falsify
 * @param {string} tablePath
 * @param {unknown} err
 */
async function writeFlushFailure(tablePath, err) {
  const message = err instanceof Error ? err.message : String(err)
  try {
    await fs.mkdir(spoolDir(tablePath), { recursive: true })
    await atomicWriteJson(path.join(spoolDir(tablePath), FLUSH_FAILURE_FILE), {
      failedAt: new Date().toISOString(),
      errorMessage: message.slice(0, FLUSH_FAILURE_MESSAGE_MAX),
    })
  } catch {
    // The stamp is a pacing hint. Failing to write it costs an unpaced
    // retry, never the error the caller is about to receive.
  }
}

/**
 * @param {string} tablePath
 */
async function clearFlushFailure(tablePath) {
  try {
    await fs.rm(path.join(spoolDir(tablePath), FLUSH_FAILURE_FILE), { force: true })
  } catch {
    /* a stamp that outlives its removal only costs one delayed retry */
  }
}

/**
 * Absent, unparseable, or dated in the future by a clock that moved all read
 * as "no recent failure", so the flush is attempted. Suppressing work on
 * state this build cannot interpret is the direction that silently withholds
 * rows; attempting it is only ever a cost.
 *
 * Returns the message the stamp carries alongside its time, so a reader that
 * reports the cooldown can also say what the flush failed with. The message
 * is advisory: a stamp whose `failedAt` reads but whose `errorMessage` does
 * not still cools the gate down, with a null message, because the pacing
 * decision has never depended on it. Re-clamped to the writer's 512 here as
 * well, since the bound has to hold for a file this process did not write.
 *
 * @ref LLP 0322#stamps-that-cannot-be-read [implements]: an uninterpretable stamp is no stamp
 * @param {string} tablePath
 * @returns {Promise<{ failedAtMs: number, errorMessage: string | null } | null>}
 */
export async function readFlushFailure(tablePath) {
  try {
    const raw = await fs.readFile(path.join(spoolDir(tablePath), FLUSH_FAILURE_FILE), 'utf8')
    const parsed = /** @type {{ failedAt?: unknown, errorMessage?: unknown }} */ (JSON.parse(raw))
    if (typeof parsed.failedAt !== 'string') return null
    const ms = Date.parse(parsed.failedAt)
    if (!Number.isFinite(ms)) return null
    if (ms > Date.now()) return null
    const message = typeof parsed.errorMessage === 'string' && parsed.errorMessage.length > 0
      ? parsed.errorMessage.slice(0, FLUSH_FAILURE_MESSAGE_MAX)
      : null
    return { failedAtMs: ms, errorMessage: message }
  } catch {
    return null
  }
}

/**
 * @param {string} tablePath
 * @returns {Promise<number | null>}
 */
async function readFlushFailedAt(tablePath) {
  return (await readFlushFailure(tablePath))?.failedAtMs ?? null
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
