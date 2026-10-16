// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { tryReadCursorSync, withPartitionMutationLock } from './partition.js'

/** @import { CachePurgeCleanupJob } from '../../../src/core/cache/types.js' */
export const CACHE_PURGE_GRACE_MS = 24 * 60 * 60 * 1000
const generationName = /^(?:table(?:-[a-zA-Z0-9-]+)?|epoch=\d+)$/

/** @param {string} cacheRoot @param {string} partitionDir */
export function cacheCleanupId(cacheRoot, partitionDir) {
  return createHash('sha256').update(relativePartition(cacheRoot, partitionDir)).digest('hex')
}

/** @param {string} cacheRoot @param {string} partitionDir */
function relativePartition(cacheRoot, partitionDir) {
  const relative = path.relative(path.resolve(cacheRoot), path.resolve(partitionDir))
  if (!relative.startsWith(`datasets${path.sep}`) || relative.split(path.sep).includes('..')) throw new Error('cache cleanup partition outside cache')
  return relative
}

/** @param {string} cacheRoot @param {string} id */
function journalPath(cacheRoot, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid cache cleanup id')
  return path.join(cacheRoot, '.purge-cleanup', `${id}.json`)
}

/** @param {string} cacheRoot @param {string} id @returns {Promise<CachePurgeCleanupJob | null>} */
export async function readCacheCleanup(cacheRoot, id) {
  const file = journalPath(cacheRoot, id)
  try {
    if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('cache cleanup journal too large')
    const job = JSON.parse(await fs.readFile(file, 'utf8'))
    if (job.version !== 1 || typeof job.partition !== 'string' ||
      cacheCleanupId(cacheRoot, path.join(cacheRoot, job.partition)) !== id ||
      !Number.isSafeInteger(job.requestedAt) || job.requestedAt < 0 ||
      !Array.isArray(job.generations) || job.generations.length > 10000 ||
      !job.generations.every(name => typeof name === 'string' && generationName.test(name))) throw new Error('invalid cache cleanup journal')
    return job
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Caller owns the partition mutation lock. Admit before the first delete
 * commit, including all older generations so their historical copies retire.
 * @ref LLP 0417#cache-reclamation [implements]: durable admission precedes logical deletion
 * @param {string} cacheRoot @param {string} partitionDir
 */
export async function queueCacheCleanup(cacheRoot, partitionDir) {
  const id = cacheCleanupId(cacheRoot, partitionDir)
  // A journal that fails to parse or fails its shape check (a crash mid-write,
  // a hand edit) must not make every later purge of this partition throw at
  // admission. The write below rebuilds it from the partition's own
  // generations, which supersedes what could not be read, at the cost of
  // restarting the grace. A journal that could not be read at all is not that
  // case: it may still be readable on the next attempt with its grace clock
  // and its generation list intact, so an I/O failure stays fail-closed rather
  // than silently discarding outstanding cleanup work.
  const existing = await readCacheCleanup(cacheRoot, id).catch(error => {
    if (typeof (/** @type {NodeJS.ErrnoException} */ (error)?.code) === 'string') throw error
    return null
  })
  const generations = new Set()
  for (const entry of await fs.readdir(partitionDir, { withFileTypes: true })) {
    if (!generationName.test(entry.name)) continue
    if (entry.isSymbolicLink()) throw new Error('cache cleanup refuses symlink generation')
    if (entry.isDirectory()) generations.add(entry.name)
  }
  if (generations.size > 10000) throw new Error('cache cleanup generation limit exceeded')
  if (!generations.size) throw new Error('cache cleanup requires a managed generation')
  // Keep the existing journal's requestedAt when one exists: retirement grace
  // is additionally gated per generation by its own retirement time in
  // maintenance.js, so an older requestedAt here never shortens a newly
  // admitted generation's grace. Restarting it on every admission would keep
  // forcing fresh generations while never reclaiming the old ones.
  const job = { version: 1, partition: relativePartition(cacheRoot, partitionDir), generations: [...generations], requestedAt: existing?.requestedAt ?? Date.now() }
  if (Buffer.byteLength(JSON.stringify(job)) > 1024 * 1024) throw new Error('cache cleanup journal too large')
  await atomicWriteJson(journalPath(cacheRoot, id), job, { fsync: true, mode: 0o600, dirMode: 0o700 })
  // The `.purge-cleanup` directory entry itself must be durable before delete
  // commits, mirroring what createSessionPurgeStore().add does in
  // session-purges.js for its own directory.
  const handle = await fs.open(cacheRoot, 'r')
  try { await handle.sync() } finally { await handle.close() }
  return id
}

/** @param {string} partition @param {string[]} generations */
async function remainingGenerations(partition, generations) {
  let remaining = 0
  for (const name of generations) {
    try {
      await fs.lstat(path.join(partition, name))
      remaining++
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
  }
  return remaining
}

/**
 * Drop a journal whose admitted generations are all reclaimed. The re-read
 * runs under the caller's partition mutation lock, so a purge that admitted
 * concurrently keeps its admission; anything unreadable or still present
 * retains the journal for a later tick.
 * @param {string} cacheRoot @param {string} id
 */
export async function finishCacheCleanup(cacheRoot, id) {
  const job = await readCacheCleanup(cacheRoot, id).catch(() => null)
  if (!job) return
  if (await remainingGenerations(path.join(cacheRoot, job.partition), job.generations)) return
  await fs.rm(journalPath(cacheRoot, id), { force: true })
}

/** @param {string} directory */
async function directoryPresent(directory) {
  try {
    await fs.lstat(directory)
    return true
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Drop the journal of a partition directory the caller is removing whole.
 * Caller owns the partition mutation lock and has already removed every
 * generation the journal names, which is what makes the drop safe rather
 * than the directory's absence: a concurrent spool append recreates a bare
 * partition directory under its own write lock, not this one, and brings no
 * generation back with it.
 *
 * The retirement sweep reaches a journal only by walking its partition, so a
 * journal whose partition retention evicted is otherwise never visited again.
 * It does not merely leak: a partition recreated at the same path hashes to
 * the same cleanup id, and a fresh source-table generation is named `table`,
 * a name the old journal already lists, so the successor is forced through a
 * full-generation rewrite for a purge with no rows left to reach. Once the
 * partition is back, nothing in a journal tells it apart from one the
 * successor admitted itself, so the eviction is where the two are told apart.
 * @ref LLP 0417#cache-reclamation [implements]: a journal names outstanding work, and an evicted partition has none
 * @param {string} cacheRoot @param {string} partitionDir
 */
export async function discardCacheCleanup(cacheRoot, partitionDir) {
  await fs.rm(journalPath(cacheRoot, cacheCleanupId(cacheRoot, partitionDir)), { force: true })
}

/**
 * Sweep journals whose partition directory is absent: the recovery half of
 * {@link discardCacheCleanup}, covering journals left behind by releases that
 * evicted without dropping them and by an eviction that failed or crashed
 * between the directory removal and the unlink.
 * @param {string} cacheRoot
 */
export async function sweepEvictedCacheCleanups(cacheRoot) {
  /** @type {string[]} */
  let names
  // Fail soft the way `walkForRetired` does: reclamation is best effort, and
  // an unreadable journal store must not take the rest of the tick's
  // compaction and retirement work with it.
  try {
    names = await fs.readdir(path.join(cacheRoot, '.purge-cleanup'))
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!/^[a-f0-9]{64}$/.test(id)) continue
    // Bytes that cannot be read, or that fail the shape check, keep the
    // journal: its partition path is exactly what is not trustworthy here,
    // and rebuilding a corrupt journal is the next purge's job.
    const job = await readCacheCleanup(cacheRoot, id).catch(() => null)
    if (!job) continue
    const partitionDir = path.join(cacheRoot, job.partition)
    try {
      if (await directoryPresent(partitionDir)) continue
      await withPartitionMutationLock(partitionDir, async () => {
        // Re-checked under the lock every admission holds (`purge.js` wraps
        // `queueCacheCleanup` in it), so a journal admitted for a partition
        // that came back between the two checks is never the one unlinked.
        // Not the lock that creates the directory - a spool append makes a
        // bare one without it - but the one that writes what is unlinked.
        if (await directoryPresent(partitionDir)) return
        await fs.rm(journalPath(cacheRoot, id), { force: true })
      })
    } catch { /* A busy partition, an unreadable path or a failed unlink retries next tick. */ }
  }
}

/**
 * Status verifies directory absence rather than inferring it from a cursor
 * swap. No content or filesystem paths leave this public status surface.
 * @param {string} cacheRoot @param {string} id
 */
export async function cachePurgeCleanupStatus(cacheRoot, id) {
  const job = await readCacheCleanup(cacheRoot, id)
  if (!job) return { job_id: id, scope: 'cache_generations', status: 'unverified' }
  const partition = path.join(cacheRoot, job.partition)
  const cursor = tryReadCursorSync(partition)
  const current = cursor?.tableDir ?? (cursor?.layout === 'source-table' ? 'table' : `epoch=${cursor?.epoch}`)
  const remaining = await remainingGenerations(partition, job.generations)
  return { job_id: id, scope: 'cache_generations', status: remaining ? 'pending' : 'completed',
    stage: remaining ? (job.generations.includes(current) ? 'rewrite' : 'reclaim') : 'done', generations_remaining: remaining }
}

/**
 * Only an unpublished generation may lack metadata. A retirement marker or
 * version hint is evidence of publication, so missing metadata then fails closed.
 * Caller checks this is not the live generation and owns the partition lock.
 * @ref LLP 0417#cache-reclamation [implements]: interrupted output must not strand purge or retirement
 * @param {string} directory
 */
export async function isUncommittedCacheGeneration(directory) {
  for (const file of ['.retired', 'metadata/version-hint.text']) {
    try {
      await fs.lstat(path.join(directory, file))
      return false
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
  }
  try {
    const names = await fs.readdir(path.join(directory, 'metadata'))
    return !names.some(name => name.endsWith('.metadata.json'))
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return true
    throw error
  }
}
