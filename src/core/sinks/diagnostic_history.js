// @ts-check
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { compareStrings } from '../util/compare_strings.js'

/** @import { SinkDiagnosticRecord } from '../../../src/core/sinks/types.js' */

const HISTORY_LIMIT = 100
const METADATA_BYTES = 4096
const BATCH_SUFFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-(\d+)\.json$/

/** @param {string} name @param {string} instance */
function batchName(name, instance) {
  if (!name.startsWith(`${instance}-`)) return null
  const match = BATCH_SUFFIX.exec(name.slice(instance.length + 1))
  if (!match) return null
  const at = Date.parse(match[1])
  if (!Number.isFinite(at)) return null
  return { name, at, sequence: BigInt(match[2]) }
}

// @ref LLP 0471#diagnostic-history [implements]: stream only recognized ordinary files, preserving unknown names and symlinks
/** @param {string} dir @param {string} instance */
export async function* diagnosticEntries(dir, instance) {
  const stat = await fs.lstat(dir)
  if (!stat.isDirectory()) return
  const entries = await fs.opendir(dir)
  for await (const entry of entries) {
    if (!entry.isFile() || !batchName(entry.name, instance)) continue
    yield entry.name
  }
}

/** Read complete top-level scalar properties only, stopping before inventories. @param {string} prefix */
function recordedTime(prefix) {
  let i = 0
  function space() { while (/\s/.test(prefix[i] ?? '') && i < prefix.length) i++ }
  function string() {
    if (prefix[i] !== '"') throw new Error('incomplete metadata')
    const start = i++
    for (; i < prefix.length; i++) {
      if (prefix[i] === '\\') { i++; continue }
      if (prefix[i] === '"') return JSON.parse(prefix.slice(start, ++i))
    }
    throw new Error('incomplete metadata')
  }
  try {
    space()
    if (prefix[i++] !== '{') return NaN
    while (i < prefix.length) {
      space()
      const key = string()
      space()
      if (prefix[i++] !== ':') return NaN
      space()
      if (key === 'partitions' || prefix[i] === '{' || prefix[i] === '[') return NaN
      let value
      if (prefix[i] === '"') value = string()
      else {
        const start = i
        while (i < prefix.length && prefix[i] !== ',' && prefix[i] !== '}') i++
        if (i === prefix.length) return NaN
        value = JSON.parse(prefix.slice(start, i))
      }
      if (key === 'recordedAt') return typeof value === 'string' ? Date.parse(value) : NaN
      space()
      if (prefix[i++] !== ',') return NaN
    }
  } catch { /* legacy, malformed or incomplete prefix: use the filename */ }
  return NaN
}

// @ref LLP 0471#daemon-work [implements]: recordedAt precedes partitions; read a finite prefix with legacy filename fallback
/** @param {string} dir @param {string} name @param {string} instance @returns {Promise<SinkDiagnosticRecord | null>} */
export async function readDiagnosticRecord(dir, name, instance) {
  const record = batchName(name, instance)
  if (!record) return null
  let file
  try {
    file = await fs.open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!(await file.stat()).isFile()) return null
    const buffer = Buffer.alloc(METADATA_BYTES)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const at = recordedTime(buffer.toString('utf8', 0, bytesRead))
    if (Number.isFinite(at)) record.at = at
    return record
  } catch (error) {
    // Never follow a raced symlink or treat a vanished entry as evidence.
    const code = /** @type {{ code?: string }} */ (error)?.code
    if (code === 'ELOOP' || code === 'ENOENT') return null
    return record
  } finally { await file?.close() }
}

/** @param {SinkDiagnosticRecord} a @param {SinkDiagnosticRecord} b */
function newestFirst(a, b) {
  if (a.at !== b.at) return b.at - a.at
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? -1 : 1
  return compareStrings(a.name, b.name)
}

/** @param {SinkDiagnosticRecord[]} records @param {SinkDiagnosticRecord} record @param {string | undefined} protectedName */
function keepNewest(records, record, protectedName) {
  records.push(record)
  records.sort(newestFirst)
  if (records.length <= HISTORY_LIMIT) return undefined
  const index = records[HISTORY_LIMIT].name === protectedName ? HISTORY_LIMIT - 1 : HISTORY_LIMIT
  return records.splice(index, 1)[0]
}

/** @param {string} dir @param {string} name */
async function removeOrdinary(dir, name) {
  const target = path.join(dir, name)
  try {
    if ((await fs.lstat(target)).isFile()) await fs.unlink(target)
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') throw error
  }
}

// @ref LLP 0471#diagnostic-history [implements]: one bounded history per handle; failed reconciliation waits for existing maintenance, not every failure
/** @param {string} dir @param {string} instance @param {(code: string) => void} onFailure */
export function createDiagnosticHistory(dir, instance, onFailure) {
  /** @type {SinkDiagnosticRecord[] | null} */
  let records = null
  let retryNeeded = false
  /** @type {Promise<void> | null} */
  let inFlight = null

  /** @param {string | undefined} protectedName */
  async function reconcile(protectedName) {
    /** @type {SinkDiagnosticRecord[]} */
    const selected = []
    try {
      for await (const name of diagnosticEntries(dir, instance)) {
        const record = await readDiagnosticRecord(dir, name, instance)
        if (record) keepNewest(selected, record, protectedName)
      }
    } catch (error) {
      if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') throw error
    }
    const keep = new Set(selected.map(record => record.name))
    let removed = 0
    try {
      for await (const name of diagnosticEntries(dir, instance)) {
        if (name === protectedName || keep.has(name)) continue
        await removeOrdinary(dir, name)
        if (++removed % 32 === 0) await yieldTurn()
      }
    } catch (error) {
      if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') throw error
    }
    records = selected
    retryNeeded = false
  }

  /** @param {() => Promise<void>} operation */
  async function cleanup(operation) {
    await operation().catch(error => {
      retryNeeded = true
      records = null
      const code = /** @type {{code?: unknown}} */ (error)?.code
      try { onFailure(typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'cleanup_failed') } catch { /* diagnostic reporting cannot change export outcome */ }
    })
  }

  /** Publication and maintenance share one finite owner, so pruning cannot race the new atomic record.
   * @param {() => Promise<void>} operation */
  async function exclusive(operation) {
    while (inFlight) await inFlight.catch(() => {})
    inFlight = operation().finally(() => { inFlight = null })
    return inFlight
  }

  /** @param {string} name @param {() => Promise<void>} write */
  async function publish(name, write) {
    await exclusive(async () => {
      // A write failure propagates without pruning or invalidating the last good history.
      await write()
      if (retryNeeded) return
      await cleanup(async () => {
        if (records === null) return reconcile(name)
        const record = await readDiagnosticRecord(dir, name, instance)
        if (!record) return
        records = records.filter(previous => previous.name !== name)
        const removed = keepNewest(records, record, name)
        if (removed) await removeOrdinary(dir, removed.name)
      })
    })
  }

  async function maintain() {
    await exclusive(async () => {
      if (records !== null && !retryNeeded) return
      await cleanup(() => reconcile(undefined))
    })
  }

  return { publish, maintain }
}
