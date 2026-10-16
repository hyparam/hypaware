// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { errCode } from './json_util.js'

/** Guard owner names this process holds right now. @type {Set<string>} */
const heldMutationOwners = new Set()

/**
 * `error_kind` of the refusal {@link claimPartitionMutation} raises when the
 * guard is held or unverifiable. Tagged rather than left to message matching
 * because it is the one failure a caller may absorb and retry later: nothing
 * was mutated under a guard it never took.
 */
export const PARTITION_MUTATION_BUSY_ERROR_KIND = 'cache_partition_mutation_busy'

/**
 * Whether a thrown value is the mutation guard's contention refusal.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isPartitionMutationBusy(error) {
  return /** @type {{ error_kind?: unknown } | null | undefined} */ (error)?.error_kind === PARTITION_MUTATION_BUSY_ERROR_KIND
}

/**
 * A directory grants ownership; its single PID/nonce filename publishes the
 * owner. Never steal from a live process, however long its rewrite takes.
 * Recovery unlinks that exact dead owner's entry before rmdir: a competing
 * reclaimer that lost the unlink must not remove a successor's directory.
 * Empty or malformed locks fail closed (including a crash during admission).
 * An owner carrying this process's own PID that it does not hold is a
 * previous incarnation's: in a container the daemon is always PID 1.
 * @ref LLP 0417#cache-mutation-guard [implements]: CLI purge and daemon publication share a non-expiring guard
 * @param {string} partitionDir
 * @returns {() => void}
 */
export function claimPartitionMutation(partitionDir) {
  // Keep the guard outside a partition that retention may remove.
  const directory = path.join(path.dirname(partitionDir), `.${path.basename(partitionDir)}.mutation-lock`)
  const owner = `${process.pid}-${randomUUID()}`
  const busy = () => Object.assign(
    new Error('cache partition mutation busy or lock unverifiable; retry after the writer finishes'),
    { error_kind: PARTITION_MUTATION_BUSY_ERROR_KIND }
  )
  fs.mkdirSync(path.dirname(partitionDir), { recursive: true })
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 })
      break
    } catch (error) {
      if (errCode(error) !== 'EEXIST') throw error
      if (attempt) throw busy()
      /** @type {string[]} */
      let entries
      try {
        entries = fs.readdirSync(directory)
      } catch (readError) {
        // The holder let go between our mkdir and this read: contention,
        // not corruption, so report it the way every caller already retries.
        if (errCode(readError) === 'ENOENT') throw busy()
        throw readError
      }
      if (entries.length !== 1 || !/^[1-9]\d*-[a-f0-9-]{36}$/.test(entries[0])) throw busy()
      const pid = Number(entries[0].split('-')[0])
      if (!Number.isSafeInteger(pid)) throw busy()
      // @ref LLP 0417#cache-mutation-guard [implements]: a guard naming our own PID that we do not hold is dead, so PID reuse never wedges a restarted container
      let dead = pid === process.pid && !heldMutationOwners.has(entries[0])
      if (!dead) {
        try { process.kill(pid, 0) } catch (error) {
          if (errCode(error) !== 'ESRCH') throw busy()
          dead = true
        }
      }
      if (!dead) throw busy()
      // No force: losing this exact unlink must abort recovery.
      fs.unlinkSync(path.join(directory, entries[0]))
      fs.rmdirSync(directory)
      continue
    }
  }
  const file = path.join(directory, owner)
  // Failed owner publication leaves the directory closed for inspection.
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
  heldMutationOwners.add(owner)
  return () => {
    heldMutationOwners.delete(owner)
    fs.unlinkSync(file)
    fs.rmdirSync(directory)
  }
}
