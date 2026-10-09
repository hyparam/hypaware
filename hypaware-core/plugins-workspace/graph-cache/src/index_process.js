// @ts-check

import { fork } from 'node:child_process'
import { IndexBuildError } from './index_builder.js'

/**
 * @import { DirectoryVerificationInput, DiscoveryInput, NeighborsInput, IndexProcess } from '../../../../hypaware-core/plugins-workspace/graph-cache/src/types.js'
 */

const MAX_PENDING = 16
const QUERY_TIMEOUT_MS = 5000

/**
 * One process owns one generation. No graph objects cross IPC: returning a
 * serialized index to the daemon reproduces its allocator retention and stalls
 * its event loop. Exiting the owner reclaims both the index and build garbage.
 *
 * @ref LLP 0490#memory [implements]: reclaim a generation's allocations by retiring its process, with bounded query IPC
 * @param {{ dir: string, manifest: any, duty?: number, maxBytes?: number, signal: AbortSignal, verifyOnly?: boolean, budget?: DirectoryVerificationInput['budget'] }} opts
 * @returns {Promise<IndexProcess>}
 */
export function startIndexProcess(opts) {
  opts.signal.throwIfAborted()
  const child = fork(new URL('./index_worker.js', import.meta.url), [], {
    // The builder needs files, not the daemon's credentials, preload hooks,
    // recording environment or inspector. Only this isolated heap is collected.
    env: {}, execArgv: ['--expose-gc', '--optimize-for-size'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let alive = true
  let sequence = 0
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map()
  /** @type {(error: Error) => void} */
  let rejectBuild = () => {}
  const exited = new Promise((resolve) => child.once('close', resolve))

  /** @param {Error} error */
  function fail(error) {
    alive = false
    rejectBuild(error)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
    opts.signal.removeEventListener('abort', abort)
    child.kill('SIGKILL')
  }
  const abort = () => fail(new Error('graph index stopped'))
  opts.signal.addEventListener('abort', abort, { once: true })
  child.on('error', fail)
  child.once('exit', (code, signal) => fail(new Error(`graph index process exited (${signal ?? code})`)))

  /** @param {'discover' | 'neighbors'} operation @param {DiscoveryInput | NeighborsInput} input */
  function request(operation, input) {
    if (!alive) return Promise.reject(new Error('graph index unavailable'))
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error('graph index busy'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('graph index query timed out')), QUERY_TIMEOUT_MS)
      timer.unref()
      pending.set(id, { resolve, reject, timer })
      child.send({ id, operation, input }, (error) => { if (error) fail(error) })
    })
  }

  return new Promise((resolve, reject) => {
    rejectBuild = reject
    child.on('message', (/** @type {any} */ message) => {
      if (!alive) return
      if (message.type === 'ready') {
        resolve({
          pid: child.pid ?? 0, bytes: message.bytes, buildRss: message.rss, verification: message.verification,
          get alive() { return alive },
          discover: (input) => /** @type {Promise<string>} */ (request('discover', input)),
          neighbors: (input) => /** @type {Promise<string>} */ (request('neighbors', input)),
          async close() {
            fail(new Error('graph index retired'))
            await exited
          },
        })
      } else if (message.type === 'build_error') {
        const typed = ['replica_too_large', 'invalid_line', 'schema_violation'].includes(message.code)
        fail(typed ? new IndexBuildError(message.code, message.error) : new Error(message.error))
      } else if (message.type === 'result') {
        const entry = pending.get(message.id)
        if (!entry) return
        pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(message.error))
        else entry.resolve(message.result)
      }
    })
    child.send({ type: 'build', dir: opts.dir, manifest: opts.manifest, duty: opts.duty, maxBytes: opts.maxBytes, verifyOnly: opts.verifyOnly, budget: opts.budget }, (error) => { if (error) fail(error) })
  }).catch(async (error) => {
    fail(error)
    await exited
    throw error
  })
}

/** @param {DirectoryVerificationInput} opts */
export async function verifySnapshotInProcess(opts) {
  const owner = await startIndexProcess({
    dir: opts.dir, manifest: opts.manifest, maxBytes: opts.maxLineBytes,
    signal: opts.signal ?? new AbortController().signal, verifyOnly: true, budget: opts.budget,
  })
  try {
    if (!owner.verification) throw new Error('graph verifier returned no result')
    return owner.verification
  } finally {
    await owner.close()
  }
}
