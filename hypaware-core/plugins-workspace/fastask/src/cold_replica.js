// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { buildIndexFromSnapshot } from './index_builder.js'
import { readRecord, replicaPaths, replicasRoot } from './replica_store.js'

/**
 * @import { GraphIndex, ReplicaRecord, ReplicaState } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

/**
 * The cold path's view of the replica on disk, for when the daemon is not
 * running: the record the sync loop last wrote for this target and origin,
 * judged by the sync loop's own rule (a generation is held, its lease has not
 * expired, it was not withdrawn). Only reads; the daemon owns every write.
 *
 * @param {string} stateDir the plugin state directory
 * @param {{ target: string, origin: string }} want
 * @param {number} now
 * @returns {Promise<{ record: ReplicaRecord, servable: boolean, state: ReplicaState, reason: string | null, dir: string | null } | null>}
 */
export async function readLocalReplica(stateDir, want, now) {
  let names
  try {
    names = await fs.promises.readdir(replicasRoot(stateDir))
  } catch {
    return null
  }
  for (const name of names.sort()) {
    const record = await readRecord(replicaPaths(stateDir, name).record)
    if (!record || record.target !== want.target || record.origin !== want.origin) continue
    const expired = record.generation !== null && record.lease_expires_at !== null && now >= Date.parse(record.lease_expires_at)
    const state = expired ? 'expired' : record.state
    const servable = record.generation !== null && !expired && state !== 'withdrawn'
    return {
      record,
      servable,
      state,
      reason: expired ? 'lease_expired' : record.reason,
      dir: servable && record.generation ? replicaPaths(stateDir, record.key).generation(record.generation) : null,
    }
  }
  return null
}

/**
 * Build the index from an active generation in the command itself: the
 * daemon's builder without the duty-cycle sleep (the user is waiting), with
 * the same memory ceiling.
 *
 * @ref LLP 0480#cooperative [implements]: cold load from the command uses the same builder without the duty-cycle sleep
 * @param {string} dir a generation directory
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ index: GraphIndex, ms: number }>}
 */
export async function loadColdIndex(dir, signal) {
  const started = performance.now()
  const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8'))
  const index = await buildIndexFromSnapshot({
    manifest,
    nodes: fs.createReadStream(path.join(dir, 'nodes.ndjson.gz')),
    edges: fs.createReadStream(path.join(dir, 'edges.ndjson.gz')),
    duty: 1,
    ...(signal ? { signal } : {}),
  })
  return { index, ms: Math.round(performance.now() - started) }
}
