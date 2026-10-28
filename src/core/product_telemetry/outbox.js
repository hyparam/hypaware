// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomInt, randomUUID } from 'node:crypto'
import { atomicWriteJsonSync } from '../util/fs_atomic.js'
import { MAX_BATCH_BYTES, MAX_RECORDS, validateBatch } from './contract.js'

export const QUEUE_BYTES = 5 * 1024 * 1024
export const QUEUE_AGE_MS = 7 * 86400_000
// Fixed reservations make the aggregate byte cap independent of writer races.
export const QUEUE_SLOTS = QUEUE_BYTES / MAX_BATCH_BYTES

/** @param {string} file @param {number} max */
function readSmallText(file, max) {
  try {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    )
    try {
      if (fs.fstatSync(fd).size > max) return null
      return fs.readFileSync(fd, 'utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** @param {string} file @param {number} [max] @returns {any} */
export function readSmallJson(file, max = MAX_BATCH_BYTES) {
  try {
    const text = readSmallText(file, max)
    return text === null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

/** @param {Record<string, any>} record */
const isMetric = (record) => record?.kind === 'metric'
/** The contract's one-interval-per-series key. @param {Record<string, any>} record */
const seriesKey = (record) =>
  JSON.stringify([record.name, Object.entries(record.attributes).sort()])

/**
 * Only the sender takes a lock. CLI writers reserve a fixed slot with wx,
 * never wait for another process and never enumerate customer storage.
 * @ref LLP 0393#outbox [implements]: exact bytes plus original policy binding in fixed aggregate reservations
 * @param {string} root @param {{now?:()=>number}} [options]
 */
export function createOutbox(root, { now = Date.now } = {}) {
  const queue = path.join(root, 'queue-v1')
  const loss = path.join(root, 'dropped')
  const stateFile = path.join(root, 'delivery.json')
  const lock = path.join(root, 'sender.lock')
  const slotPath = (/** @type {number} */ slot) =>
    path.join(queue, `${slot}.json`)
  function mkdir() {
    fs.mkdirSync(queue, { recursive: true, mode: 0o700 })
  }
  function noteDrop() {
    // One coalesced marker even during a writer storm. It is a lower bound,
    // not an invented exact count when several writers lose records at once.
    try {
      mkdir()
      fs.writeFileSync(loss, '1', { flag: 'wx', mode: 0o600 })
    } catch {}
  }
  /** @param {any} batch @param {string} binding */
  function append(batch, binding) {
    try {
      if (
        !batch ||
        validateBatch(batch, now()) !== null ||
        !/^[0-9a-f]{64}$/.test(binding)
      )
        return false
      const wire = JSON.stringify(batch)
      const stored = JSON.stringify({ binding, wire })
      if (Buffer.byteLength(stored) > MAX_BATCH_BYTES) {
        noteDrop()
        return false
      }
      mkdir()
      const first = randomInt(QUEUE_SLOTS)
      for (let offset = 0; offset < QUEUE_SLOTS; offset++) {
        let fd
        try {
          fd = fs.openSync(
            slotPath((first + offset) % QUEUE_SLOTS),
            'wx',
            0o600
          )
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST')
            continue
          throw error
        }
        try {
          fs.writeFileSync(fd, stored)
        } finally {
          fs.closeSync(fd)
        }
        return true
      }
    } catch {
      /* Disk full, inaccessible state or contention is telemetry loss. */
    }
    noteDrop()
    return false
  }
  // Maintenance and status retain one decoded slot at a time. Only explicit
  // preview enumeration needs to materialize the whole queue.
  function* scan() {
    // No queue directory means no slots, so the sweep would be 160 failing
    // opens per call. A queue created after the check is empty at creation, and
    // `maintain` still lstats every slot, so its grace period covers the race.
    if (!fs.existsSync(queue)) return
    for (let slot = 0; slot < QUEUE_SLOTS; slot++) {
      const text = readSmallText(slotPath(slot), MAX_BATCH_BYTES)
      if (text === null) continue
      try {
        const entry = JSON.parse(text)
        if (
          !entry ||
          typeof entry.wire !== 'string' ||
          typeof entry.binding !== 'string'
        )
          continue
        const batch = JSON.parse(entry.wire)
        let at = Infinity
        for (const record of batch.records)
          at = Math.min(at, Date.parse(record.timestamp))
        if (Number.isFinite(at))
          yield {
            slot,
            binding: entry.binding,
            wire: entry.wire,
            at,
            bytes: Buffer.byteLength(text),
            id: batch.batch_id,
            records: batch.records.length,
            role: batch.resource?.['service.role'],
            // Batches from different CLI processes of one version, built for
            // one wire version, pack together.
            group: JSON.stringify([
              batch.schema_version,
              { ...batch.resource, 'process.id': null }
            ]),
            sealed: entry.sealed === true,
            sources: Array.isArray(entry.sources) ? entry.sources : []
          }
      } catch {}
    }
  }
  function entries() {
    return [...scan()].sort((a, b) => a.at - b.at || a.slot - b.slot)
  }
  /** @param {{slot:number,id:string}} entry */
  function remove(entry) {
    const current = readSmallJson(slotPath(entry.slot))
    // An ack can remove only the exact immutable copy it sent.
    if (current && JSON.parse(current.wire).batch_id === entry.id)
      fs.unlinkSync(slotPath(entry.slot))
  }
  /** @param {string|null} binding */
  function maintain(binding) {
    let dropped = 0
    // Metadata only: the wire is dropped so a pass holds one payload at a time.
    /** @type {Omit<ReturnType<typeof entries>[number], 'wire'>[]} */
    const live = []
    const validSlots = new Set()
    const packed = new Set()
    for (const { wire, ...entry } of scan()) {
      validSlots.add(entry.slot)
      if (entry.binding !== binding || entry.at < now() - QUEUE_AGE_MS) {
        remove(entry)
        dropped++
      } else {
        live.push(entry)
        for (const id of entry.sources) packed.add(id)
      }
    }
    // A pack that crashed before unlinking its sources left copies of records
    // it already holds. They go now, never into a second upload.
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].sealed || !packed.has(live[i].id)) continue
      remove(live[i])
      live.splice(i, 1)
    }
    live.sort((a, b) => a.at - b.at || a.slot - b.slot)
    // An interrupted synchronous append leaves an invalid slot. Only reclaim
    // after a grace period; a live short append must never be read as corrupt.
    for (let slot = 0; slot < QUEUE_SLOTS; slot++) {
      try {
        const file = slotPath(slot)
        if (
          !validSlots.has(slot) &&
          fs.lstatSync(file).mtimeMs < now() - 60_000
        ) {
          fs.unlinkSync(file)
          dropped++
        }
      } catch {}
    }
    if (dropped) noteDrop()
    return { dropped, live }
  }
  /** @param {{slot:number,id:string}} entry */
  function load(entry) {
    const current = readSmallJson(slotPath(entry.slot))
    try {
      const batch = JSON.parse(current.wire)
      return batch.batch_id === entry.id
        ? { batch, wire: /** @type {string} */ (current.wire) }
        : null
    } catch {
      return null
    }
  }
  /**
   * The next upload for `binding`, or null when nothing is due. A sealed slot
   * is frozen: it may have been sent, so it goes again byte for byte. Unsealed
   * CLI batches were never sent, so they pack into one sealed upload. While
   * `hold` is set they wait unless they already fill a batch.
   * @ref LLP 0562#pack [implements]: pack unsent CLI batches, seal before the first send
   * @param {string|null} binding @param {boolean} [hold]
   */
  function next(binding, hold = false) {
    const { live } = maintain(binding)
    const waiting = new Set()
    for (const head of live) {
      if (head.sealed || head.role !== 'cli') return withWire(head)
      if (waiting.has(head.group)) continue
      const members = live.filter(
        (e) => !e.sealed && e.role === 'cli' && e.group === head.group
      )
      let records = 0
      for (const member of members) records += member.records
      // Slot sizes repeat the resource, so records, not bytes, say a pack is
      // full. Half the slots held back is pressure enough to send early.
      if (hold && records <= MAX_RECORDS && members.length < QUEUE_SLOTS / 2) {
        waiting.add(head.group)
        continue
      }
      return seal(/** @type {string} */ (binding), head, members)
    }
    return null
  }
  /** @template {{slot:number,id:string}} T @param {T} entry */
  function withWire(entry) {
    const loaded = load(entry)
    return loaded ? { ...entry, wire: loaded.wire } : null
  }
  /**
   * Greedy and bounded: one member payload is read at a time, and members that
   * would break the record, byte or one-interval-per-series limit stay queued.
   * @param {string} binding
   * @param {{slot:number,id:string,at:number}} head
   * @param {{slot:number,id:string,at:number,records:number}[]} members
   */
  function seal(binding, head, members) {
    const loaded = load(head)
    if (!loaded) return null
    const first = loaded.batch
    const series = new Set(first.records.filter(isMetric).map(seriesKey))
    const records = [...first.records]
    /** @type {{slot:number,id:string}[]} */
    const sources = []
    // Escaped size of the stored wrapper, kept exact for ASCII records.
    let bytes = Buffer.byteLength(
      JSON.stringify({ binding, wire: loaded.wire, sealed: true, sources: [] })
    )
    for (const member of members) {
      if (member.id === head.id) continue
      if (records.length + member.records > MAX_RECORDS) continue
      const batch = load(member)?.batch
      if (!batch) continue
      const keys = batch.records.filter(isMetric).map(seriesKey)
      if (keys.some((key) => series.has(key))) continue
      let added = Buffer.byteLength(JSON.stringify(member.id)) + 1
      for (const record of batch.records)
        added += Buffer.byteLength(JSON.stringify(JSON.stringify(record))) - 1
      if (bytes + added > MAX_BATCH_BYTES) continue
      bytes += added
      for (const key of keys) series.add(key)
      records.push(...batch.records)
      sources.push(member)
    }
    let wire = loaded.wire
    if (sources.length) {
      const merged = { ...first, batch_id: randomUUID(), records }
      if (validateBatch(merged, now()) === null) wire = JSON.stringify(merged)
      else sources.length = 0
    }
    let stored = JSON.stringify({
      binding,
      wire,
      sealed: true,
      sources: sources.map((s) => s.id)
    })
    if (Buffer.byteLength(stored) > MAX_BATCH_BYTES) {
      wire = loaded.wire
      sources.length = 0
      stored = JSON.stringify({ binding, wire, sealed: true, sources: [] })
    }
    // Replace the head atomically, then drop the sources. A crash in between
    // leaves sources that `maintain` recognizes and removes.
    const temp = path.join(queue, 'seal.tmp')
    fs.writeFileSync(temp, stored, { mode: 0o600 })
    fs.renameSync(temp, slotPath(head.slot))
    for (const source of sources) remove(source)
    return {
      slot: head.slot,
      binding,
      wire,
      id: JSON.parse(wire).batch_id,
      role: 'cli',
      at: head.at
    }
  }
  function claim() {
    try {
      mkdir()
      // Symlink creation is an atomic owner publication, unlike mkdir followed
      // by a pid write. A live owner is never evicted by a wall-clock timeout.
      const owner = `${process.pid}-${randomUUID()}`
      try {
        fs.symlinkSync(owner, lock)
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST')
          return null
        const old = fs.readlinkSync(lock)
        const pid = Number(old.split('-')[0])
        if (!Number.isSafeInteger(pid) || pid < 1) return null
        try {
          process.kill(pid, 0)
          return null
        } catch (e) {
          if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ESRCH')
            return null
        }
        if (fs.readlinkSync(lock) !== old) return null
        fs.unlinkSync(lock)
        try {
          fs.symlinkSync(owner, lock)
        } catch {
          return null
        }
      }
      return () => {
        try {
          if (fs.readlinkSync(lock) === owner) fs.unlinkSync(lock)
        } catch {}
      }
    } catch {
      return null
    }
  }
  function status() {
    let bytes = 0
    let batches = 0
    let oldest = Infinity
    for (const entry of scan()) {
      bytes += entry.bytes
      batches++
      oldest = Math.min(oldest, entry.at)
    }
    return {
      queue_bytes: bytes,
      queue_batches: batches,
      oldest_age_seconds: batches
        ? Math.max(0, (now() - oldest) / 1000)
        : 0,
      dropped_lower_bound: fs.existsSync(loss) ? 1 : 0,
      delivery: readSmallJson(stateFile, 4096)
    }
  }
  /** @param {Record<string, any>} value */
  function saveDelivery(value) {
    atomicWriteJsonSync(stateFile, value, { mode: 0o600, dirMode: 0o700 })
  }
  return {
    append,
    entries,
    remove,
    prune: (/** @type {string|null} */ binding) => maintain(binding).dropped,
    next,
    claim,
    status,
    noteDrop,
    saveDelivery,
    readDelivery: () => readSmallJson(stateFile, 4096)
  }
}
