// @ts-check

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { loadTranscript, transcriptEntryFromRow } from './transcripts.js'

/**
 * Incremental transcript loader for the live capture path.
 *
 * `loadTranscript` re-reads and re-parses every byte of a session's
 * transcript (plus its subagent files) on EVERY finished exchange, so
 * per-exchange cost grows with session size: a long session keeps a
 * core busy and concurrent finalizations each hold a full parsed copy.
 * Transcripts are append-only JSONL, so this loader remembers, per
 * file, the byte offset after the last complete line it consumed plus
 * the entries parsed so far, and each load stats the file and parses
 * only the appended bytes. Work per exchange is then proportional to
 * new lines, not session length, and concurrent finalizations share
 * one parsed copy instead of holding one each.
 *
 * Trust model: the offset is only reused while the file still looks
 * append-only: same inode, size not below the consumed offset, and no
 * mtime change without growth. Anything else (rotation, truncation,
 * in-place rewrite) discards the state and re-reads from byte zero, so
 * the worst case is exactly the old behavior. Only complete
 * (newline-terminated) lines are ever *consumed*: a partially-written
 * tail must never advance the offset, or the completing bytes would be
 * skipped. A trailing line that is already complete JSON but not yet
 * newline-terminated is still *returned*, from a re-derived
 * {@link TranscriptFileState.tail} that the offset never covers: the
 * readline-based reader yields such a line, and silently dropping the
 * newest line of a session that has stopped growing is exactly the
 * kind of quiet under-projection this path must not introduce. The
 * tail is re-parsed (never cached) on every load, so the line is
 * emitted once from the tail and once, later, from `entries`, never
 * twice in one load.
 *
 * Any read that fails partway poisons the freshness witnesses instead
 * of keeping the short parse, so the next load re-reads from byte
 * zero: a transient error must not truncate a file's cached view for
 * the lifetime of the daemon.
 *
 * Memory: parsed entries are retained per file and evicted
 * least-recently-used once total consumed bytes exceed the budget,
 * except files touched within {@link EVICT_IDLE_MS} (the active
 * session must not thrash out of its own cache).
 */

/**
 * @import { TranscriptEntry, TranscriptFileState } from './types.js'
 */

/**
 * Retained-bytes budget, measured in consumed file bytes (a proxy for
 * entry memory, which runs a small multiple of it). Generous enough to
 * hold a handful of active sessions; far below the heap sizes the
 * uncached loader's concurrent full copies reached.
 */
const DEFAULT_MAX_RETAINED_BYTES = 256 * 1024 * 1024

/** Files used this recently are evicted only under the hard cap. */
const EVICT_IDLE_MS = 60_000

/**
 * A from-scratch parse of at least this many bytes takes the cold-parse
 * gate: with the cache, each session pays a full parse once, but the
 * proxy fires finalizations without awaiting, so several sessions' first
 * loads can land together, and each holds a session-sized entry array.
 * That unbounded pile-up is the OOM in Diego's crash dumps; staggering
 * the big parses bounds it without slowing the (cheap) cached path.
 */
const COLD_PARSE_GATE_BYTES = 4 * 1024 * 1024

/** Cold parses allowed to run concurrently. */
const COLD_PARSE_CONCURRENCY = 2

/**
 * @param {{ maxRetainedBytes?: number, now?: () => number }} [opts]  injectable for tests
 */
export function createTranscriptLoader(opts) {
  const maxRetainedBytes = opts?.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES
  const now = opts?.now ?? Date.now
  /** @type {Map<string, TranscriptFileState>} */
  const files = new Map()
  const coldGate = createGate(COLD_PARSE_CONCURRENCY)

  /**
   * Drop-in for `loadTranscript`: same resolution (session file,
   * subagent walk, Desktop 3p fallback), incremental per-file reads.
   *
   * @param {Parameters<typeof loadTranscript>[0]} loadOpts
   */
  async function load(loadOpts) {
    const entries = await loadTranscript(loadOpts, readCachedFile)
    evict()
    return entries
  }

  /**
   * The injected per-file reader: append this file's cached entries,
   * advancing the cache over any newly appended bytes first.
   *
   * @param {string} filePath
   * @param {TranscriptEntry[]} out
   */
  async function readCachedFile(filePath, out) {
    let state = files.get(filePath)
    if (!state) {
      state = { ino: -1, size: 0, mtimeMs: 0, consumed: 0, entries: [], tail: [], lastUsedMs: 0, chain: Promise.resolve() }
      files.set(filePath, state)
    }
    // The proxy fires exchange finalizations without awaiting, so two
    // loads of one session overlap: serialize per file so appended
    // bytes are consumed exactly once.
    const turn = state.chain.then(() => advance(filePath, /** @type {TranscriptFileState} */ (state)))
    state.chain = turn.then(() => undefined, () => undefined)
    await turn
    state.lastUsedMs = now()
    for (const entry of state.entries) out.push(entry)
    for (const entry of state.tail) out.push(entry)
  }

  /**
   * Bring one file's state current: no-op when size+mtime are
   * unchanged, tail-parse when the file only grew, full reset when it
   * stopped looking append-only.
   *
   * @param {string} filePath
   * @param {TranscriptFileState} state
   */
  async function advance(filePath, state) {
    let stat
    try {
      stat = await fsp.stat(filePath)
    } catch {
      // Missing/unreadable: forget it, and drop what we had parsed, so
      // this load yields nothing for the file just like the uncached
      // reader does rather than serving a last stale copy.
      state.consumed = 0
      state.entries = []
      state.tail = []
      files.delete(filePath)
      return
    }
    const fresh = stat.ino === state.ino && stat.size === state.size && stat.mtimeMs === state.mtimeMs
    if (fresh) return
    const appendOnly = stat.ino === state.ino && stat.size > state.size
    if (!appendOnly && !(stat.ino === state.ino && stat.size === state.size)) {
      // Rotated, truncated, or first sight: start over from byte zero.
      state.ino = stat.ino
      state.consumed = 0
      state.entries = []
    } else if (!appendOnly) {
      // Same size, new mtime: an in-place rewrite we cannot diff.
      state.consumed = 0
      state.entries = []
    }
    state.tail = []
    const toParse = stat.size - state.consumed
    const parsed = toParse >= COLD_PARSE_GATE_BYTES
      ? await coldGate(() => parseAppended(filePath, state, stat.size))
      : await parseAppended(filePath, state, stat.size)
    if (!parsed.ok) {
      // A short read must not look like a complete one: leaving the
      // witnesses at the observed stat would make the next load call
      // the file `fresh` and never revisit the bytes we failed to read.
      // Poisoning them forces the reset branch (and a from-zero
      // re-read) next time, which is the pre-cache behavior.
      state.ino = -1
      state.size = -1
      state.mtimeMs = -1
      return
    }
    // A complete JSON value that has not been newline-terminated yet is
    // returned but never consumed: the next load re-derives it, or
    // consumes it for real once its newline lands.
    state.tail = parseTail(parsed.rest)
    state.size = stat.size
    state.mtimeMs = stat.mtimeMs
    state.ino = stat.ino
  }

  /**
   * Parse `[state.consumed, sizeSnapshot)` into entries, consuming only
   * complete lines. `\n` (0x0A) never occurs inside a UTF-8 sequence,
   * so byte-splitting before decoding is safe. Returns the unconsumed
   * trailing bytes, plus whether the region was read in full.
   *
   * @param {string} filePath
   * @param {TranscriptFileState} state
   * @param {number} sizeSnapshot
   * @returns {Promise<{ ok: boolean, rest: Buffer }>}
   */
  async function parseAppended(filePath, state, sizeSnapshot) {
    const empty = Buffer.alloc(0)
    if (sizeSnapshot <= state.consumed) return { ok: true, rest: empty }
    /** @type {fs.ReadStream} */
    let stream
    try {
      stream = fs.createReadStream(filePath, { start: state.consumed, end: sizeSnapshot - 1 })
    } catch {
      return { ok: false, rest: empty }
    }
    stream.on('error', () => {})
    /** @type {Buffer} */
    let carry = empty
    let seen = 0
    let ok = true
    try {
      for await (const chunk of stream) {
        const data = carry.length > 0 ? Buffer.concat([carry, /** @type {Buffer} */ (chunk)]) : /** @type {Buffer} */ (chunk)
        seen += chunk.length
        let start = 0
        let nl
        while ((nl = data.indexOf(10, start)) !== -1) {
          parseLine(data.subarray(start, nl), state.entries)
          start = nl + 1
        }
        carry = data.subarray(start)
      }
    } catch {
      // Truncated mid-read: keep what parsed, but report the short read
      // so the caller re-reads from zero next time.
      ok = false
    }
    state.consumed += seen - carry.length
    return { ok, rest: carry }
  }

  /**
   * Reclaim least-recently-used files once the retained budget is
   * exceeded: idle files first, then recent ones too (concurrent big
   * sessions must not accumulate without bound), always sparing the
   * single most-recent file so the active session cannot thrash itself
   * straight out of its own cache.
   */
  function evict() {
    let retained = 0
    for (const state of files.values()) retained += state.consumed
    if (retained <= maxRetainedBytes) return
    const idleBefore = now() - EVICT_IDLE_MS
    const byAge = [...files.entries()].sort(([, a], [, b]) => a.lastUsedMs - b.lastUsedMs)
    for (const pass of ['idle', 'hard']) {
      for (const [filePath, state] of byAge) {
        if (retained <= maxRetainedBytes) return
        if (!files.has(filePath)) continue
        if (pass === 'idle' && state.lastUsedMs >= idleBefore) continue
        if (files.size === 1) return
        retained -= state.consumed
        files.delete(filePath)
      }
    }
  }

  return { load }
}

/**
 * One process-wide transcript view shared by live projection and flush-time
 * settlement. Both paths observe the same append offsets and parsed entries,
 * avoiding a second retained copy of every active Claude transcript.
 */
export const sharedTranscriptLoader = createTranscriptLoader()

/**
 * Minimal counting gate: at most `limit` callers inside `fn` at once.
 *
 * @param {number} limit
 */
function createGate(limit) {
  let active = 0
  /** @type {(() => void)[]} */
  const waiters = []
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  return async function run(fn) {
    while (active >= limit) await new Promise((resolve) => waiters.push(() => resolve(undefined)))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiters.shift()?.()
    }
  }
}

/**
 * Entries for a trailing region that carries no newline. A line still
 * being written is not valid JSON (a JSONL line is one complete value,
 * so no proper prefix of it parses), which is what makes this safe to
 * attempt on every load: a half-written tail yields nothing, a finished
 * one yields its entry. The closing-bracket check just avoids paying
 * `JSON.parse` on the common half-written case.
 *
 * @param {Buffer} rest
 * @returns {TranscriptEntry[]}
 */
function parseTail(rest) {
  let end = rest.length
  while (end > 0 && isSpaceByte(rest[end - 1])) end--
  if (end === 0) return []
  const last = rest[end - 1]
  if (last !== 0x7d && last !== 0x5d) return []
  /** @type {TranscriptEntry[]} */
  const entries = []
  parseLine(rest.subarray(0, end), entries)
  return entries
}

/**
 * @param {number} byte
 */
function isSpaceByte(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

/**
 * Parse one line into `entries`, or skip it. Total by construction:
 * `transcriptEntryFromRow` hashes the content key through a recursive
 * canonicalizer, so a JSON-parseable but pathologically nested line
 * (an MCP `toolUseResult` is arbitrary third-party JSON) throws a
 * RangeError, and both call sites must survive it. The uncached
 * `readTranscriptFile` contains such a throw to its own file; here an
 * escape would be worse in both directions: from {@link parseTail} it
 * would reject `advance` and, since the witnesses are only stamped on
 * success, reject every later load too, so `loadTranscriptSafe` would
 * return nothing for the WHOLE session, forever, with only a warn to
 * show for it; from {@link parseAppended} it would be read as a short
 * read and wedge the file into a from-zero re-read on every exchange.
 * A bad line is neither of those: its bytes were read fine, so the
 * offset should pass over it exactly like a malformed one.
 *
 * @param {Buffer} line
 * @param {TranscriptEntry[]} entries
 */
function parseLine(line, entries) {
  if (line.length === 0) return
  try {
    const entry = transcriptEntryFromRow(JSON.parse(line.toString('utf8')))
    if (entry) entries.push(entry)
  } catch {
    // Unparseable, or unprojectable: skip the line, consume its bytes.
  }
}
