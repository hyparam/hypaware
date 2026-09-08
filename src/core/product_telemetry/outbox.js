// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomInt, randomUUID } from 'node:crypto'
import { atomicWriteJsonSync } from '../util/fs_atomic.js'
import { MAX_BATCH_BYTES, validateBatch } from './contract.js'

export const QUEUE_BYTES = 5 * 1024 * 1024
export const QUEUE_AGE_MS = 7 * 86400_000
// Fixed reservations make the aggregate byte cap independent of writer races.
export const QUEUE_SLOTS = QUEUE_BYTES / MAX_BATCH_BYTES

/** @param {string} file @param {number} [max] @returns {any} */
export function readSmallJson(file, max = MAX_BATCH_BYTES) {
  try {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    )
    try {
      if (fs.fstatSync(fd).size > max) return null
      return JSON.parse(fs.readFileSync(fd, 'utf8'))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

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
  function entries() {
    /** @type {Array<{slot:number,binding:string,wire:string,at:number,bytes:number,id:string}>} */
    const found = []
    for (let slot = 0; slot < QUEUE_SLOTS; slot++) {
      const entry = readSmallJson(slotPath(slot))
      if (
        !entry ||
        typeof entry.wire !== 'string' ||
        typeof entry.binding !== 'string'
      )
        continue
      try {
        const batch = JSON.parse(entry.wire)
        const at = Math.min(
          ...batch.records.map((/** @type {any} */ r) =>
            Date.parse(r.timestamp)
          )
        )
        if (Number.isFinite(at))
          found.push({
            slot,
            binding: entry.binding,
            wire: entry.wire,
            at,
            bytes: Buffer.byteLength(JSON.stringify(entry)),
            id: batch.batch_id
          })
      } catch {}
    }
    return found.sort((a, b) => a.at - b.at || a.slot - b.slot)
  }
  /** @param {{slot:number,id:string}} entry */
  function remove(entry) {
    const current = readSmallJson(slotPath(entry.slot))
    // An ack can remove only the exact immutable copy it sent.
    if (current && JSON.parse(current.wire).batch_id === entry.id)
      fs.unlinkSync(slotPath(entry.slot))
  }
  /** @param {string|null} binding */
  function prune(binding) {
    let dropped = 0
    const list = entries()
    const validSlots = new Set(list.map((entry) => entry.slot))
    for (const entry of list) {
      if (entry.binding !== binding || entry.at < now() - QUEUE_AGE_MS) {
        remove(entry)
        dropped++
      }
    }
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
    return dropped
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
    const list = entries()
    return {
      queue_bytes: list.reduce((n, e) => n + e.bytes, 0),
      queue_batches: list.length,
      oldest_age_seconds: list.length
        ? Math.max(0, (now() - list[0].at) / 1000)
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
    prune,
    claim,
    status,
    noteDrop,
    saveDelivery,
    readDelivery: () => readSmallJson(stateFile, 4096)
  }
}
