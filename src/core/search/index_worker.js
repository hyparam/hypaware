// @ts-check

import { Worker } from 'node:worker_threads'

/**
 * The main-thread handle on the grep sidecar build worker, ported from the
 * server's `index-worker.js` shape by decision.
 *
 * `createIndex` is seconds of straight-line CPU per sidecar and the daemon
 * is single-threaded, so running it inline stops ingest, queries, and the
 * health probe for as long as it runs. Yielding between files does not
 * help: one file is already longer than any request budget. So the build
 * moves to a worker thread and the main loop keeps only the scheduling,
 * the file reads, and the publish.
 *
 * One worker serves one sidecar-build pass and is closed with it: within a
 * pass the loop builds one file at a time, so a pool would buy nothing,
 * while a worker that outlived the pass would hold an index-sized heap
 * between maintenance ticks for no one.
 *
 * @ref LLP 0264#lifecycle [implements]: the build runs in a worker thread so maintenance never blocks the daemon loop
 */

/**
 * @param {{
 *   log?: { info(msg: string, fields?: object): void, warn(msg: string, fields?: object): void },
 *   threadUrl?: URL,
 * }} [args] threadUrl swaps the worker module so tests can drive
 *   uncommanded death and protocol breaches; production callers omit it
 */
export function createIndexWorker({ log, threadUrl } = {}) {
  /** @type {Worker | null} */
  let worker = null
  /**
   * The live worker's in-flight builds. Reassigned per spawn: each
   * worker's handlers capture their own map, so a crashed worker's late
   * error or exit event can only reject its own builds, never a
   * replacement worker's.
   * @type {Map<number, { resolve: (bytes: Uint8Array) => void, reject: (err: Error) => void }>}
   */
  let pending = new Map()
  let nextId = 1
  let closed = false
  /** Re-evaluate the live worker's ref state; rebound per spawn. */
  let syncRef = () => {}

  function ensureWorker() {
    if (worker) return worker
    const started = new Worker(threadUrl ?? new URL('./index_worker_thread.js', import.meta.url))
    /** @type {typeof pending} */
    const owned = new Map()
    pending = owned

    /**
     * Fail this worker's in-flight builds. A worker that dies (OOM,
     * terminate, an unparseable module) must surface as a rejected build
     * so the caller records the failure and moves on; a silently hung
     * promise would wedge the maintenance pass forever.
     *
     * @param {Error} err
     */
    function failAll(err) {
      const inflight = [...owned.values()]
      owned.clear()
      for (const entry of inflight) entry.reject(err)
    }

    /**
     * Hold the event loop open exactly while a build is in flight. An
     * always-unref'd worker deadlocks any process whose loop would
     * otherwise drain (the awaiting caller's promise is resolved only by
     * a worker message that an empty loop never waits for), while an
     * always-ref'd one would hold a shutting-down daemon for the seconds
     * a build takes. Ref-while-pending gives both callers what they mean:
     * an awaited build completes, an idle worker never keeps the process
     * up.
     */
    function updateRef() {
      if (owned.size > 0) started.ref()
      else started.unref()
    }

    started.on('message', (/** @type {{ id: number, index?: ArrayBuffer, error?: string }} */ message) => {
      const entry = owned.get(message.id)
      if (!entry) return
      owned.delete(message.id)
      updateRef()
      // A message with no index bytes and no error is a protocol breach,
      // and resolving it would publish an empty sidecar that lists as
      // done. The length test is the whole guard: `new ArrayBuffer(0)` is
      // truthy, so a presence-only check would let zero bytes through as a
      // successful build.
      if (message.index && message.index.byteLength > 0) entry.resolve(new Uint8Array(message.index))
      else entry.reject(new Error(message.error ?? 'index worker answered with no index bytes and no error'))
    })
    started.on('error', (err) => {
      if (worker === started) worker = null
      failAll(err instanceof Error ? err : new Error(String(err)))
    })
    started.on('exit', (code) => {
      if (worker === started) worker = null
      failAll(new Error(`grep index worker exited before answering (code ${code})`))
    })
    started.unref()
    syncRef = updateRef
    worker = started
    log?.info('grep_index.worker_started', {})
    return started
  }

  return {
    /**
     * Build one sidecar's bytes off the event loop. A whole, exclusively
     * owned source buffer is transferred (detached here on return);
     * anything else, such as a view into Node's Buffer pool, is copied
     * first. Either way callers must not touch `sourceBytes` afterwards.
     *
     * @param {Uint8Array} sourceBytes
     * @returns {Promise<Uint8Array>}
     */
    build(sourceBytes) {
      if (closed) return Promise.reject(new Error('grep index worker is closed'))
      const active = ensureWorker()
      const id = nextId
      nextId += 1
      const source = transferable(sourceBytes)
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        syncRef()
        active.postMessage({ id, source }, [source])
      })
    },
    /** Terminate the worker; in-flight builds reject through the exit hook. */
    async close() {
      closed = true
      const active = worker
      worker = null
      if (active) await active.terminate()
    },
  }
}

/**
 * An ArrayBuffer that is safe to hand to `postMessage`'s transfer list.
 * Node's Buffer allocator hands out views into a shared pool for small
 * reads, and transferring a pooled buffer would detach every unrelated
 * Buffer sharing it, so anything that is not a whole, exclusively owned
 * buffer is copied first.
 *
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer}
 */
function transferable(bytes) {
  const buffer = bytes.buffer
  if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    return buffer
  }
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}
