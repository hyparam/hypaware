import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomInt } from 'node:crypto'

export const MAX_EVENT_BYTES = 512 * 1024
export const SLOT_COUNT = 256
const slotName = i => String(i).padStart(3, '0')
export const journalPath = stateDir => path.join(stateDir, 'langgraph', 'outbox')

// Bound traversal before stringify, including references to caller-owned data.
export function encodeEvent(value) {
  const stack = [value]
  let budget = MAX_EVENT_BYTES
  let nodes = 0
  while (stack.length) {
    const item = stack.pop()
    if (++nodes > 16384) throw new Error('event_limit')
    if (typeof item === 'string') budget -= Buffer.byteLength(item)
    else if (item && typeof item === 'object') {
      if (Array.isArray(item) && item.length > 4096) throw new Error('event_limit')
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue
        budget -= Buffer.byteLength(key) + 4
        if (stack.length >= 16384 || budget < 0) throw new Error('event_limit')
        stack.push(item[key])
      }
    }
    if (budget < 0) throw new Error('event_limit')
  }
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > MAX_EVENT_BYTES) throw new Error('event_limit')
  return body
}

// @ref LLP 0517#journal: fixed exclusive slots bound aggregate disk across processes
export async function publish(directory, event) {
  const body = encodeEvent(event)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const start = randomInt(SLOT_COUNT)
  for (let n = 0; n < SLOT_COUNT; n++) {
    const slot = path.join(directory, slotName((start + n) % SLOT_COUNT))
    try { await fs.mkdir(slot, { mode: 0o700 }) } catch (error) {
      if (error.code === 'EEXIST') continue
      throw error
    }
    try {
      await fs.writeFile(path.join(slot, 'owner'), String(process.pid), { flag: 'wx', mode: 0o600 })
      await fs.writeFile(path.join(slot, 'event.tmp'), body, { flag: 'wx', mode: 0o600, flush: true })
      await fs.rename(path.join(slot, 'event.tmp'), path.join(slot, 'event.json'))
    } catch (error) {
      await fs.rm(slot, { recursive: true, force: true })
      throw error
    }
    return
  }
  throw new Error('queue_full')
}

export async function pendingSlots(directory) {
  const slots = []
  let dir
  try { dir = await fs.opendir(directory) } catch (error) {
    if (error.code === 'ENOENT') return slots
    throw error
  }
  let count = 0
  for await (const entry of dir) {
    if (++count > 512) throw new Error('journal_invalid')
    if (/^\d{3}$/.test(entry.name) && Number(entry.name) < SLOT_COUNT && entry.isDirectory()) slots.push(entry.name)
  }
  return slots.sort()
}

export async function readSlot(directory, name) {
  const slot = path.join(directory, name)
  const file = path.join(slot, 'event.json')
  let handle
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) throw new Error('event_invalid')
    // Bounded read even if another process changes the file after stat.
    const buffer = Buffer.alloc(MAX_EVENT_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_EVENT_BYTES) throw new Error('event_invalid')
    const event = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    if (event?.version !== 1 || !event.projection || !Array.isArray(event.projection.messages)
      || event.projection.messages.length > 4096 || typeof event.projection.session_id !== 'string'
      || typeof event.projection.cwd !== 'string' || !path.isAbsolute(event.projection.cwd)) throw new Error('event_invalid')
    return event.projection
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const stat = await fs.stat(slot).catch(() => undefined)
    if (stat && Date.now() - stat.mtimeMs > 86400000) {
      // Never reclaim a suspended writer's slot. Unknown owners stay pending.
      let owner = ''
      let ownerFile
      try {
        ownerFile = await fs.open(path.join(slot, 'owner'), constants.O_RDONLY | constants.O_NOFOLLOW)
        if ((await ownerFile.stat()).isFile()) {
          const bytes = Buffer.alloc(12)
          const read = await ownerFile.read(bytes, 0, bytes.length, 0)
          owner = bytes.subarray(0, read.bytesRead).toString('utf8')
        }
      } catch { /* Unknown owner: retain the slot. */ }
      finally { await ownerFile?.close() }
      if (/^[1-9]\d{0,9}$/.test(owner)) {
        try { process.kill(Number(owner), 0) } catch (error) {
          if (error.code === 'ESRCH') await removeSlot(directory, name)
        }
      }
    }
    return undefined
  } finally { await handle?.close() }
}

export async function removeSlot(directory, name) {
  await fs.rm(path.join(directory, name), { recursive: true, force: true })
}
