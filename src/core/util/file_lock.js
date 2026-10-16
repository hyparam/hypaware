// @ts-check

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** @import { Stats } from 'node:fs' */

const LOCK_STALE_MS = 60 * 1000

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Break a lock whose holder is past {@link LOCK_STALE_MS}, so a crashed holder can
 * never wedge the store for longer than one stale interval (LLP 0065 D1). The
 * break is a plain `fs.rm`: it does not grant the lock, it only clears a dead
 * file, so the contender that broke it must still win the `O_EXCL` create like
 * everyone else. That is what makes a four-line break safe where the old
 * rename-aside-and-restore steal was not - exclusivity is decided by the create,
 * never by the break.
 *
 * @param {string} lockPath
 * @returns {Promise<void>}
 */
async function breakLockIfStale(lockPath) {
  /** @type {Stats} */
  let st
  try {
    st = await fs.stat(lockPath)
  } catch {
    return // vanished between the failed open and now: the loop retries the create
  }
  // A holder within its budget is alive (or recently so): wait it out. Only an
  // age past the bounded-hold ceiling marks it dead and breakable.
  if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.rm(lockPath, { force: true })
}

/**
 * Cross-process mutex for bounded read/refresh/write operations. Callers must
 * keep work below 60 seconds, re-read inside the lock and compare before
 * committing after network work: age-based crash recovery permits a double
 * holder if a process is suspended. Reuses the remote credential protocol.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
// @ref LLP 0065#d1 [implements]: grant by O_EXCL, break by age, release by nonce
export async function withFileLock(lockPath, fn) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const nonce = crypto.randomUUID()
  const deadline = Date.now() + LOCK_STALE_MS * 2
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(nonce)
      } catch (err) {
        // A create that could not record its nonce must not leave an empty lock
        // that wedges contenders until the stale age; drop our own fresh file.
        await fs.rm(lockPath, { force: true })
        throw err
      } finally {
        await handle.close()
      }
      break
    } catch (err) {
      if (!err || /** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err
      await breakLockIfStale(lockPath)
      if (Date.now() > deadline) {
        throw new Error('timed out acquiring the file lock')
      }
      await delay(25)
    }
  }
  try {
    return await fn()
  } finally {
    // Remove only our own lock: if a hold ever overran the stale age and a
    // contender broke and re-acquired it, the file now belongs to a successor.
    try {
      const owner = await fs.readFile(lockPath, 'utf8')
      if (owner === nonce) await fs.rm(lockPath, { force: true })
    } catch { /* already gone */ }
  }
}
