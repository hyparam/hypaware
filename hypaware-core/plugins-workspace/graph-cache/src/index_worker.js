// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { verifySnapshotDirectory } from './contract.js'
import { buildIndexFromSnapshot } from './index_builder.js'
import { discover, neighbors } from './discovery.js'

/** @import { GraphIndex } from '../../../../hypaware-core/plugins-workspace/graph-cache/src/types.js' */

// A dead daemon must never leave an owner holding teammates' graph data.
process.on('disconnect', () => process.exit(0))
/** @type {GraphIndex | null} */
let index = null
let building = false

process.on('message', async (/** @type {any} */ message) => {
  if (message.type === 'build' && !building) {
    building = true
    try {
      if (message.verifyOnly) {
        const verification = await verifySnapshotDirectory({
          dir: message.dir, manifest: message.manifest, maxLineBytes: message.maxBytes, budget: message.budget,
        })
        send({ type: 'ready', bytes: 0, rss: process.memoryUsage().rss, verification })
        return
      }
      index = await buildIndexFromSnapshot({
        manifest: message.manifest,
        nodes: fs.createReadStream(path.join(message.dir, 'nodes.ndjson.gz')),
        edges: fs.createReadStream(path.join(message.dir, 'edges.ndjson.gz')),
        duty: message.duty, maxBytes: message.maxBytes,
      })
      // A single collection after building releases temporary JS references.
      // It runs off the capture process and never on the query hot path.
      globalThis.gc?.()
      send({ type: 'ready', bytes: index.bytes, rss: process.memoryUsage().rss })
    } catch (error) {
      send({ type: 'build_error', code: error.code, error: String(error.message).slice(0, 1000) })
    }
    return
  }
  if (!index || (message.operation !== 'discover' && message.operation !== 'neighbors')) return
  try {
    const result = message.operation === 'discover' ? discover(index, message.input) : neighbors(index, message.input)
    // Existing traversal caps bound work; this also bounds IPC on unusually
    // large natural keys or provenance strings in an otherwise valid snapshot.
    const response = { type: 'result', id: message.id, result }
    if (replyBytes(response, 2 * 1024 * 1024) > 2 * 1024 * 1024) throw new Error('graph index result too large')
    // Encode once here. The daemon forwards JSON without allocating a second
    // copy of every path, lead and provenance object on its long-lived heap.
    send({ type: 'result', id: message.id, result: JSON.stringify(result) })
  } catch (error) {
    send({ type: 'result', id: message.id, error: String(error.message).slice(0, 1000) })
  }
})

/** @param {object} message */
function send(message) {
  if (!process.connected) return
  process.send?.(message, (error) => { if (error) process.exit(1) })
}

/**
 * Bound serialization before allocating the whole encoded reply. A string
 * longer than the remaining budget is refused before JSON escaping it.
 * @param {any} value
 * @param {number} remaining
 * @returns {number}
 */
function replyBytes(value, remaining) {
  if (remaining < 0) return Infinity
  if (typeof value === 'string') {
    if (value.length > remaining) return Infinity
    return Buffer.byteLength(JSON.stringify(value))
  }
  if (typeof value === 'number') return 32
  if (value === null || typeof value !== 'object') return 8
  let bytes = 2
  for (const [key, item] of Object.entries(value)) {
    if (!Array.isArray(value)) bytes += replyBytes(key, remaining - bytes) + 1
    bytes += replyBytes(item, remaining - bytes) + 1
    if (bytes > remaining) return Infinity
  }
  return bytes
}
