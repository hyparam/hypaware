/**
 * Wait until `predicate` returns truthy (sync or async) or the deadline
 * elapses. Polled with a 5ms loop — gascity tests need to step through
 * stream events that resolve on the microtask queue, so a short interval is
 * fine and the deadline keeps a stuck test from hanging vitest.
 *
 * @param {() => unknown | Promise<unknown>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, message?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function waitFor(predicate, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 2000
  const intervalMs = opts.intervalMs ?? 5
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await predicate()
    if (result) return
    await sleep(intervalMs)
  }
  throw new Error(opts.message ?? `waitFor: predicate did not become truthy within ${timeoutMs}ms`)
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build an SSE Response whose body emits the given chunks then closes. Used
 * by the gascity stream tests so they don't depend on a live HTTP server.
 *
 * @param {string[]} chunks
 * @returns {Response}
 */
export function sseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * Build an SSE Response whose body stays open until the request signal is
 * aborted, dispatching `initialChunks` up front. Useful for sessions a test
 * wants to leave alive across the supervisor lifecycle.
 *
 * @param {string[]} initialChunks
 * @param {AbortSignal} signal
 * @returns {Response}
 */
export function holdingSseResponse(initialChunks, signal) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of initialChunks) controller.enqueue(encoder.encode(chunk))
      function onAbort() {
        try { controller.close() } catch { /* already closed */ }
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * Memoizing stream collector for stderr / stdout.
 *
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
export function memoStream() {
  let buf = ''
  return { write: (s) => { buf += s }, value: () => buf }
}

/**
 * Sleep stub that never resolves naturally — it only releases when its
 * `signal` argument fires. streamSse's reconnect loop will then loop once
 * more, see `signal.aborted`, and exit. Use this in tests that drive the
 * subscriber/worker via `start()` + an explicit `stop()`.
 *
 * @returns {(ms: number, signal: AbortSignal) => Promise<void>}
 */
export function blockingSleep() {
  return function stub(_ms, signal) {
    return new Promise(function(_resolve, reject) {
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', function() {
        reject(new Error('aborted'))
      }, { once: true })
    })
  }
}
