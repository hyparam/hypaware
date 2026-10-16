// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

// 65 bytes per SHA-256 receipt, at most 65,536 chunks (roughly 256 GiB).
// Reaching the cap disables further caching, never delivery. Completion
// deletes the journal. Neither row payloads nor credentials are persisted.
const MAX_RECEIPTS = 65_536
const RECORD_BYTES = 65

/**
 * Acknowledgements are content receipts, not sequence checkpoints. Every
 * restart still scans through the current privacy/purge filters; only an
 * exact acknowledged chunk can skip its POST, even when the scan reorders.
 * @ref LLP 0497#receipts [implements]: bounded receipts preserve upload progress without checkpointing an unordered scan
 * @param {string | undefined} root
 * @param {string[]} scope destination, gateway, partition, replay mode
 */
export async function openReceipts(root, scope) {
  const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
  const file = root ? path.join(root, `${key}.receipts`) : undefined
  const known = new Set()
  if (file) {
    try {
      const handle = await fs.open(file, 'r')
      try {
        const bytes = Buffer.alloc(Math.min((await handle.stat()).size, MAX_RECEIPTS * RECORD_BYTES))
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        for (const line of bytes.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, -1)) {
          if (/^[a-f0-9]{64}$/.test(line)) known.add(line)
        }
      } finally { await handle.close() }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
  }
  return {
    /** @param {string} batchId */
    key(batchId) { return createHash('sha256').update(batchId).digest('hex') },
    /** @param {string} id */
    has(id) { return known.has(id) },
    /** @param {string} id */
    async record(id) {
      if (!file || known.has(id) || known.size >= MAX_RECEIPTS) return
      await fs.mkdir(path.dirname(file), { recursive: true })
      const handle = await fs.open(file, 'a', 0o600)
      try {
        const size = (await handle.stat()).size
        if (size >= MAX_RECEIPTS * RECORD_BYTES) return
        // A newline isolates a torn tail from the next valid receipt. Invalid
        // fragments are ignored on read, which can resend but cannot skip.
        await handle.write(`${size % RECORD_BYTES ? '\n' : ''}${id}\n`)
        await handle.sync()
        known.add(id)
      } finally { await handle.close() }
    },
    async clear() { if (file) await fs.rm(file, { force: true }) },
  }
}
