// @ts-check

import { createHash } from 'node:crypto'
import path from 'node:path'

import { atomicWriteJson, readFileIfExists } from '../util/fs_atomic.js'

/**
 * @import { HeldDatasetStore, HeldDatasetsRead } from '../../../src/core/sinks/types.js'
 */

const RECORD_VERSION = 1
export const HELD_DATASETS_FILE = 'held-datasets.json'

/**
 * Where one sink instance's held-dataset snapshot lives, beside its
 * watermarks. One join for the writer and for `hyp status`, which reads it
 * with no live sink to ask.
 *
 * @param {string} instanceStateDir from `instanceWatermarkStateDir`
 */
export function heldDatasetsPath(instanceStateDir) {
  return path.join(instanceStateDir, HELD_DATASETS_FILE)
}

/**
 * The record names its destination by digest, so a sink pointed at another
 * server reads as holding nothing and the URL itself is never written.
 *
 * @param {string} destination the sink's configured URL
 */
function destinationKey(destination) {
  return createHash('sha256').update(String(destination)).digest('hex')
}

/**
 * The datasets one sink instance's destination currently refuses, and
 * nothing else: no attempts, partitions, credentials or row contents. The set
 * is bounded by the datasets eligible to forward, because load drops any
 * name the caller no longer forwards.
 *
 * @ref LLP 0537#snapshot [implements]: current holds only, scoped to the destination, rewritten whole and serialized
 * @param {{ stateDir: string, destination: string }} opts
 * @returns {HeldDatasetStore}
 */
export function createHeldDatasetStore({ stateDir, destination }) {
  if (!stateDir) throw new Error('createHeldDatasetStore: stateDir is required')
  const file = heldDatasetsPath(stateDir)
  const key = destinationKey(destination)
  /** @type {Set<string>} */
  const held = new Set()
  // `revision` counts changes to `held`; `written` is the newest revision a
  // write has landed. They differ after a failed write, and every later call
  // rewrites until they agree, so a lost write is retried, never forgotten.
  let revision = 0
  let written = 0
  /** @type {Promise<void>} */
  let chain = Promise.resolve()

  // Writes are serialized and each writes the whole set as it stands when it
  // runs, so overlapping ticks land in order and the last write is the newest
  // state: a cleared hold cannot be resurrected by an older write.
  function persist() {
    const run = chain.then(async () => {
      const covers = revision
      await atomicWriteJson(file, {
        v: RECORD_VERSION,
        destination: key,
        datasets: [...held].sort(),
        updatedAt: new Date().toISOString(),
      })
      written = Math.max(written, covers)
    })
    chain = run.catch(() => {})
    return run
  }

  return {
    async load(keep) {
      const before = await readHeldDatasetsFile(file, destination).catch((error) => {
        revision += 1
        throw error
      })
      const kept = 'datasets' in before ? before.datasets.filter((name) => keep.has(name)) : []
      for (const name of kept) held.add(name)
      const stale = 'unreadable' in before || before.stored !== kept.length
      if (stale) {
        revision += 1
        await persist()
      }
    },

    async hold(name) {
      if (held.has(name) && written === revision) return
      if (!held.has(name)) {
        held.add(name)
        revision += 1
      }
      await persist()
    },

    async clear(name) {
      if (!held.has(name) && written === revision) return
      if (held.delete(name)) revision += 1
      await persist()
    },
  }
}

/**
 * Read a held-dataset snapshot for the destination a sink is configured for
 * now. A missing file holds nothing. So does a record for a different
 * destination: a replaced server never inherits another's warning. A record
 * that cannot be read or does not parse is reported as unreadable, never as
 * empty, because an empty answer would certify every dataset forwarding.
 *
 * @param {string} instanceStateDir
 * @param {string} destination
 * @returns {Promise<HeldDatasetsRead>}
 */
export async function readHeldDatasets(instanceStateDir, destination) {
  try {
    const read = await readHeldDatasetsFile(heldDatasetsPath(instanceStateDir), destination)
    return 'datasets' in read ? { datasets: read.datasets } : read
  } catch (error) {
    return { unreadable: /** @type {NodeJS.ErrnoException} */ (error)?.code ?? 'read failed' }
  }
}

/**
 * @param {string} file
 * @param {string} destination
 * @returns {Promise<{ datasets: string[], stored: number } | { unreadable: string }>}
 */
async function readHeldDatasetsFile(file, destination) {
  const raw = await readFileIfExists(file)
  if (raw === null) return { datasets: [], stored: 0 }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { unreadable: 'corrupt' }
  }
  if (
    parsed?.v !== RECORD_VERSION ||
    typeof parsed.destination !== 'string' ||
    !Array.isArray(parsed.datasets) ||
    parsed.datasets.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    return { unreadable: 'invalid' }
  }
  const stored = parsed.datasets.length
  if (parsed.destination !== destinationKey(destination)) return { datasets: [], stored }
  return { datasets: [...new Set(/** @type {string[]} */ (parsed.datasets))], stored }
}
