// @ts-check

import { Worker } from 'node:worker_threads'

import { CursorReadError } from './native.js'

/**
 * The main-thread handle on the Cursor native decode, on the worker-thread
 * shape `src/core/search/index_worker.js` already carries.
 *
 * `readCursorSession` is straight-line CPU and synchronous IO over a graph
 * bounded at 32 MiB and 4,096 blobs. Run inline it stops the daemon outright,
 * and a recovery pass runs it up to sixteen times, so the hook receiver, the
 * OTEL listener and the gateway all stall behind it; the hook process destroys
 * its request after 800 ms and prints an unavailable notice into the editor
 * for a callback whose row then lands anyway. Yielding between blobs is not
 * the alternative: it would hold Cursor's own read transaction open across
 * every pause.
 *
 * One worker serves one backfill run, or a run of recovery passes that never
 * leaves the queue empty, and is closed with it. Within a pass the reader
 * decodes one graph at a time, so a pool buys nothing, while a worker that
 * outlived a drained queue would hold a graph-sized heap for no one. Spawning
 * one per pass is the other extreme and costs more than it saves: hooks arrive
 * throughout an agent run, so passes are back to back and most of them only
 * re-answer `unchanged`.
 *
 * @import { CursorSession, CursorSnapshot } from '../../../../hypaware-core/plugins-workspace/cursor/src/types.js'
 *
 * @ref LLP 0399#resources [implements]: the native decode runs on a worker
 *   thread, so a bounded graph bounds CPU rather than daemon latency
 * @ref LLP 0264#lifecycle: the same worker handle shape the grep sidecar
 *   build already uses to keep maintenance off the daemon loop
 *
 * @param {{ log?: { info(msg: string, fields?: object): void } }} [args]
 */
export function createCursorDecoder({ log } = {}) {
  /** @type {Worker | null} */
  let worker = null
  /**
   * The live worker's in-flight reads. Reassigned per spawn so a dead
   * worker's late error or exit event can only reject its own reads.
   * @type {Map<number, { resolve: (snapshot: CursorSnapshot) => void, reject: (err: Error) => void }>}
   */
  let pending = new Map()
  let nextId = 1
  let closed = false
  /** Re-evaluate the live worker's ref state; rebound per spawn. */
  let syncRef = () => {}

  function ensureWorker() {
    if (worker) return worker
    const started = new Worker(new URL('./native_decoder_thread.js', import.meta.url))
    /** @type {typeof pending} */
    const owned = new Map()
    pending = owned

    /**
     * Fail this worker's in-flight reads. A worker that dies (OOM,
     * terminate, an unloadable module) must surface as a rejected read so
     * the pass records one incomplete session and moves on; a silently hung
     * promise would wedge the recovery chain for the daemon's lifetime.
     * @param {Error} err
     */
    function failAll(err) {
      const inflight = [...owned.values()]
      owned.clear()
      for (const entry of inflight) entry.reject(err)
    }

    /**
     * Hold the event loop open exactly while a read is in flight. An
     * always-unref'd worker deadlocks a process whose loop would otherwise
     * drain, such as a one-shot `hyp backfill cursor`, because the awaiting
     * caller's promise is resolved only by a message an empty loop never
     * waits for. An always-ref'd one would hold a stopping daemon open for
     * a whole pass.
     */
    function updateRef() {
      if (owned.size > 0) started.ref()
      else started.unref()
    }

    started.on('message', (/** @type {{ id: number, snapshot?: CursorSnapshot, error?: string }} */ message) => {
      const entry = owned.get(message.id)
      if (!entry) return
      owned.delete(message.id)
      updateRef()
      // A message with neither a snapshot nor an error is a protocol breach.
      // Resolving it would report a session recovered with no exchanges and
      // let the caller record its root as a completed fingerprint.
      if (message.snapshot) entry.resolve(message.snapshot)
      else entry.reject(new CursorReadError(message.error ?? 'native_read_failed'))
    })
    started.on('error', () => {
      if (worker === started) worker = null
      // Worker errors carry module paths and stack frames; the reader's
      // fixed-code contract is what the caller is allowed to log. But a
      // thread that cannot run at all fails every session forever, so it
      // gets its own code: `native_read_failed` on every row would read as
      // a store full of corrupt graphs and hide a dead decoder.
      failAll(new CursorReadError('native_decoder_unavailable'))
    })
    started.on('exit', () => {
      if (worker === started) worker = null
      failAll(new CursorReadError('native_read_failed'))
    })
    started.unref()
    syncRef = updateRef
    worker = started
    // The signal the acceptance gate reads to tell a decode thread that
    // appears for a run of passes from one that respawns on every pass.
    log?.info('cursor.decoder.started', { component: 'plugin.cursor', operation: 'recovery.read' })
    return started
  }

  return {
    /**
     * Decode one native graph off the event loop.
     * @param {CursorSession} session
     * @param {string} [previousRoot]
     * @returns {Promise<CursorSnapshot>}
     */
    read(session, previousRoot) {
      if (closed) return Promise.reject(new CursorReadError('native_read_failed'))
      const active = ensureWorker()
      const id = nextId
      nextId += 1
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        syncRef()
        active.postMessage({ id, session, previousRoot })
      })
    },
    /** Terminate the worker; in-flight reads reject through the exit hook. */
    async close() {
      closed = true
      const active = worker
      worker = null
      if (active) await active.terminate()
    },
  }
}
