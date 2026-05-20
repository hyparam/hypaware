import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROWS,
  DEFAULT_MAX_SECONDS,
  ShippingSink,
} from '../../src/gateway/shipping_sink.js'

/**
 * @import { ShippingSinkIdentitySource } from '../../src/gateway/types.d.ts'
 */

/**
 * Build a stub `fetch` that records calls and returns canned responses.
 * Mirrors the helper used by `identity.test.js` so the two suites share a
 * mental model: handlers are consumed in order, and the test asserts on
 * `calls.length` to verify the sink didn't make extras.
 *
 * @param {Array<(url: string, init: RequestInit) => Response | Promise<Response>>} handlers
 * @returns {{
 *   fetchFn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
 *   calls: Array<{ url: string, init: RequestInit }>,
 * }}
 */
function stubFetch(handlers) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = []
  let i = 0
  return {
    calls,
    fetchFn: (url, init) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      const args = init ?? {}
      calls.push({ url: u, init: args })
      if (i >= handlers.length) {
        return Promise.reject(new Error(`stubFetch: unexpected call #${i + 1} to ${u}`))
      }
      const handler = handlers[i++]
      return Promise.resolve(handler(u, args))
    },
  }
}

/**
 * Build a deterministic timer pair so a test can fire a pending timeout
 * synchronously without waiting on real wall clock. Returning a numeric
 * handle (not a Node Timeout object) is fine because the sink only calls
 * `unref()` when the handle is an object, a guard we inherit by design.
 *
 * @returns {{
 *   setTimeoutFn: (fn: () => void, ms: number) => unknown,
 *   clearTimeoutFn: (handle: unknown) => void,
 *   fire: () => void,
 *   pending: () => Array<{ handle: number, ms: number }>,
 * }}
 */
function makeFakeTimers() {
  /** @type {Map<number, { fn: () => void, ms: number }>} */
  const pending = new Map()
  let next = 1
  return {
    setTimeoutFn: (fn, ms) => {
      const handle = next++
      pending.set(handle, { fn, ms })
      return handle
    },
    clearTimeoutFn: (handle) => {
      // Mirrors the sink's permissive `unknown` parameter; fakes don't have
      // to track `clearTimeout` against the built-in's overload list.
      if (typeof handle === 'number') pending.delete(handle)
    },
    fire: () => {
      // Fire every currently-pending timer in insertion order. Most tests
      // have at most one outstanding timer; the loop covers the case where
      // a flush enqueued a new one before this call settled.
      for (const [handle, item] of [...pending.entries()]) {
        pending.delete(handle)
        item.fn()
      }
    },
    pending: () => [...pending.entries()].map(([handle, item]) => ({ handle, ms: item.ms })),
  }
}

/**
 * Tiny stand-in for `IdentityClient`. Records every `getCurrentJwt` and
 * `refresh` call so tests can assert refresh-on-401 happened exactly once.
 *
 * @param {{ jwt?: string, refresh?: () => Promise<void> }} [opts]
 * @returns {ShippingSinkIdentitySource & {
 *   jwts: string[],
 *   refreshes: number,
 *   setJwt: (s: string) => void,
 * }}
 */
function fakeIdentity(opts = {}) {
  let current = opts.jwt ?? 'jwt-1'
  /** @type {string[]} */
  const jwts = []
  let refreshes = 0
  const { refresh } = opts
  return {
    jwts,
    get refreshes() {
      return refreshes
    },
    setJwt: (s) => { current = s },
    getCurrentJwt: () => {
      jwts.push(current)
      return Promise.resolve(current)
    },
    refresh: async () => {
      refreshes += 1
      if (refresh) await refresh()
    },
  }
}

/**
 * @param {number} status
 * @param {unknown} [body]
 * @returns {Response}
 */
function jsonResponse(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  })
}

/**
 * Convenience: build a sink with stub fetch + fake timers + fake identity.
 *
 * @param {{
 *   handlers?: Array<(url: string, init: RequestInit) => Response | Promise<Response>>,
 *   identity?: ShippingSinkIdentitySource & { jwts: string[], refreshes: number, setJwt: (s: string) => void },
 *   centralUrl?: string,
 *   signal?: 'logs' | 'traces' | 'metrics' | 'proxy',
 *   batch?: { maxRows?: number, maxBytes?: number, maxSeconds?: number },
 * }} [overrides]
 * @returns {{
 *   sink: ShippingSink,
 *   fetch: ReturnType<typeof stubFetch>,
 *   timers: ReturnType<typeof makeFakeTimers>,
 *   identity: ShippingSinkIdentitySource & { jwts: string[], refreshes: number, setJwt: (s: string) => void },
 * }}
 */
function buildSink(overrides = {}) {
  const fetch = stubFetch(overrides.handlers ?? [])
  const timers = makeFakeTimers()
  const identity = overrides.identity ?? fakeIdentity()
  const sink = new ShippingSink({
    centralUrl: overrides.centralUrl ?? 'https://central.example/',
    identityClient: identity,
    signal: overrides.signal,
    batch: overrides.batch,
    fetchFn: fetch.fetchFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  })
  return { sink, fetch, timers, identity }
}

/**
 * Generate `n` rows shaped like proxy exchanges so the body size is
 * predictable. Each row serialises to ~80 bytes, enough variation between
 * tests to hit row-count and byte thresholds independently.
 *
 * @param {number} n
 * @returns {Array<Record<string, unknown>>}
 */
function makeRows(n) {
  /** @type {Array<Record<string, unknown>>} */
  const rows = []
  for (let i = 0; i < n; i++) {
    rows.push({ kind: 'exchange', seq: i, method: 'POST', status: 200 })
  }
  return rows
}

describe('ShippingSink construction', () => {
  it('throws when centralUrl is missing or empty', () => {
    // @ts-expect-error: exercising the runtime guard
    expect(() => new ShippingSink({ identityClient: fakeIdentity() })).toThrow(/centralUrl/)
    expect(() => new ShippingSink({ centralUrl: '', identityClient: fakeIdentity() })).toThrow(/centralUrl/)
  })

  it('throws when identityClient is missing', () => {
    // @ts-expect-error: exercising the runtime guard
    expect(() => new ShippingSink({ centralUrl: 'https://x/' })).toThrow(/identityClient/)
  })

  it('applies default batch thresholds', () => {
    const { sink } = buildSink()
    expect(sink.maxRows).toBe(DEFAULT_MAX_ROWS)
    expect(sink.maxBytes).toBe(DEFAULT_MAX_BYTES)
    expect(sink.maxSeconds).toBe(DEFAULT_MAX_SECONDS)
    expect(sink.signal).toBe('proxy')
  })

  it('honours custom batch thresholds and signal', () => {
    const { sink } = buildSink({
      signal: 'logs',
      batch: { maxRows: 5, maxBytes: 200, maxSeconds: 1 },
    })
    expect(sink.maxRows).toBe(5)
    expect(sink.maxBytes).toBe(200)
    expect(sink.maxSeconds).toBe(1)
    expect(sink.signal).toBe('logs')
  })
})

describe('ShippingSink batching: row count threshold', () => {
  it('flushes exactly once when 1000 rows are written, sending all rows with the JWT', async () => {
    const { sink, fetch, identity } = buildSink({
      handlers: [() => jsonResponse(202, { accepted: 1000 })],
      identity: fakeIdentity({ jwt: 'jwt-row-test' }),
    })
    for (const row of makeRows(DEFAULT_MAX_ROWS)) {
      await sink.writeRow(row)
    }
    await sink.whenIdle()

    expect(fetch.calls.length).toBe(1)
    const call = fetch.calls[0]
    expect(call.url).toBe('https://central.example/v1/ingest/proxy')
    expect(call.init.method).toBe('POST')
    expect(call.init.headers).toMatchObject({
      authorization: 'Bearer jwt-row-test',
      'content-type': 'application/x-ndjson',
    })
    const body = String(call.init.body)
    const lines = body.split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(DEFAULT_MAX_ROWS)
    expect(JSON.parse(lines[0]).seq).toBe(0)
    expect(JSON.parse(lines[lines.length - 1]).seq).toBe(DEFAULT_MAX_ROWS - 1)
    expect(identity.jwts.length).toBe(1)
    expect(identity.refreshes).toBe(0)
  })

  it('does not flush at 999 rows (one below the threshold)', async () => {
    const { sink, fetch, timers } = buildSink({
      handlers: [() => jsonResponse(202)],
    })
    for (const row of makeRows(DEFAULT_MAX_ROWS - 1)) {
      await sink.writeRow(row)
    }
    expect(fetch.calls.length).toBe(0)
    // The time-based timer is still armed, waiting for the deadline.
    expect(timers.pending().length).toBe(1)
  })
})

describe('ShippingSink batching: byte threshold', () => {
  it('flushes when total bytes (incl. newlines) reach maxBytes, before the row count threshold', async () => {
    // 200 rows × ~50 bytes ≈ 10 KB > 4 KB threshold → byte flush wins.
    const { sink, fetch } = buildSink({
      handlers: [() => jsonResponse(202)],
      batch: { maxRows: 10000, maxBytes: 4 * 1024, maxSeconds: 60 },
    })
    let written = 0
    for (const row of makeRows(200)) {
      await sink.writeRow(row)
      written += 1
      if (fetch.calls.length === 1) break
    }
    expect(fetch.calls.length).toBe(1)
    expect(written).toBeLessThan(200) // bytes flushed before reaching row cap
    const body = String(fetch.calls[0].init.body)
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThanOrEqual(4 * 1024)
  })

  it('flushes before 1000 rows when accumulating 1 MB of data', async () => {
    // Pad each row so a few hundred rows total ≥ 1 MB (the production default).
    const padding = 'x'.repeat(8 * 1024) // ~8 KB per row
    const { sink, fetch } = buildSink({
      handlers: [() => jsonResponse(202)],
      // Use the production default of 1 MB so we exercise the actual threshold.
    })
    let written = 0
    for (let i = 0; i < DEFAULT_MAX_ROWS; i++) {
      await sink.writeRow({ seq: i, padding })
      written += 1
      if (fetch.calls.length === 1) break
    }
    expect(fetch.calls.length).toBe(1)
    // 1 MB / 8 KB ≈ 128 rows, must flush well before the row cap.
    expect(written).toBeLessThan(DEFAULT_MAX_ROWS)
    expect(Buffer.byteLength(String(fetch.calls[0].init.body), 'utf8'))
      .toBeGreaterThanOrEqual(DEFAULT_MAX_BYTES)
  })
})

describe('ShippingSink batching: time threshold', () => {
  it('flushes when the timer fires (size threshold not hit)', async () => {
    const { sink, fetch, timers } = buildSink({
      handlers: [() => jsonResponse(202)],
    })
    for (const row of makeRows(100)) {
      await sink.writeRow(row)
    }
    expect(fetch.calls.length).toBe(0)
    expect(timers.pending()).toEqual([{ handle: 1, ms: DEFAULT_MAX_SECONDS * 1000 }])

    timers.fire()
    await sink.whenIdle()

    expect(fetch.calls.length).toBe(1)
    const lines = String(fetch.calls[0].init.body).split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(100)
  })

  it('starts a fresh timer on the first row of the next batch (size flush rotates the clock)', async () => {
    // maxRows: 3 → quickly hit a size flush, then verify the next row arms a
    // brand-new timer rather than reusing the cleared one.
    const { sink, fetch, timers } = buildSink({
      handlers: [
        () => jsonResponse(202),
        () => jsonResponse(202),
      ],
      batch: { maxRows: 3, maxBytes: 100_000, maxSeconds: 5 },
    })
    for (const row of makeRows(3)) {
      await sink.writeRow(row)
    }
    await sink.whenIdle()
    expect(fetch.calls.length).toBe(1)
    expect(timers.pending().length).toBe(0) // size flush cleared the first timer

    await sink.writeRow({ seq: 3 })
    expect(timers.pending().length).toBe(1) // new row → new timer
    timers.fire()
    await sink.whenIdle()
    expect(fetch.calls.length).toBe(2)
  })
})

describe('ShippingSink: JWT refresh on 401', () => {
  it('refreshes once and retries when the first POST returns 401', async () => {
    const identity = fakeIdentity({ jwt: 'jwt-stale' })
    const { sink, fetch } = buildSink({
      handlers: [
        () => {
          identity.setJwt('jwt-fresh')
          return new Response(null, { status: 401 })
        },
        (_, init) => {
          // Verify the retry uses the refreshed JWT
          const headers = /** @type {Record<string, string>} */ (init.headers)
          expect(headers.authorization).toBe('Bearer jwt-fresh')
          return jsonResponse(202)
        },
      ],
      identity,
      batch: { maxRows: 2, maxBytes: 100_000, maxSeconds: 60 },
    })
    await sink.writeRow({ seq: 0 })
    await sink.writeRow({ seq: 1 })
    await sink.whenIdle()

    expect(fetch.calls.length).toBe(2)
    expect(identity.refreshes).toBe(1)
    expect(identity.jwts).toEqual(['jwt-stale', 'jwt-fresh'])
  })

  it('does not retry a second time when the refresh-then-retry also returns 401', async () => {
    const { sink, fetch, identity } = buildSink({
      handlers: [
        () => new Response(null, { status: 401 }),
        () => new Response(null, { status: 401, statusText: 'Unauthorized' }),
      ],
      batch: { maxRows: 1, maxBytes: 100_000, maxSeconds: 60 },
    })
    await sink.writeRow({ seq: 0 })

    // The ship promise is held by the chain; close() drains it. We expect
    // close to NOT throw; close swallows ship errors via whenIdle's
    // Promise.allSettled.
    await sink.close()

    expect(fetch.calls.length).toBe(2)
    expect(identity.refreshes).toBe(1)
  })
})

describe('ShippingSink: response status handling', () => {
  it('treats 202 (Accepted) as success', async () => {
    const { sink, fetch } = buildSink({
      handlers: [() => jsonResponse(202, { accepted: 1 })],
      batch: { maxRows: 1, maxBytes: 100_000, maxSeconds: 60 },
    })
    await sink.writeRow({ seq: 0 })
    await sink.whenIdle()
    expect(fetch.calls.length).toBe(1)
  })

  it('treats 200 as success (no body)', async () => {
    const { sink, fetch } = buildSink({
      handlers: [() => new Response(null, { status: 200 })],
      batch: { maxRows: 1, maxBytes: 100_000, maxSeconds: 60 },
    })
    await sink.writeRow({ seq: 0 })
    await sink.whenIdle()
    expect(fetch.calls.length).toBe(1)
  })
})

describe('ShippingSink: close and lifecycle', () => {
  it('flushes any pending batch on close', async () => {
    const { sink, fetch, timers } = buildSink({
      handlers: [() => jsonResponse(202)],
    })
    await sink.writeRow({ seq: 0 })
    await sink.writeRow({ seq: 1 })
    expect(fetch.calls.length).toBe(0)

    await sink.close()

    expect(fetch.calls.length).toBe(1)
    const lines = String(fetch.calls[0].init.body).split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(2)
    // close should clear the time-based timer
    expect(timers.pending().length).toBe(0)
  })

  it('is idempotent: second close is a no-op', async () => {
    const { sink, fetch } = buildSink({
      handlers: [() => jsonResponse(202)],
    })
    await sink.writeRow({ seq: 0 })
    await sink.close()
    await sink.close()
    expect(fetch.calls.length).toBe(1)
  })

  it('rejects writeRow after close', async () => {
    const { sink } = buildSink()
    await sink.close()
    await expect(sink.writeRow({ seq: 0 })).rejects.toThrow(/after close/)
  })

  it('makes no fetch call when closing without rows', async () => {
    const { sink, fetch } = buildSink({ handlers: [] })
    await sink.close()
    expect(fetch.calls.length).toBe(0)
  })
})

describe('ShippingSink: URL composition', () => {
  it('composes URLs correctly when centralUrl ends in a slash', async () => {
    const { sink, fetch } = buildSink({
      handlers: [() => jsonResponse(202)],
      centralUrl: 'https://central.example/',
      batch: { maxRows: 1, maxBytes: 100_000, maxSeconds: 60 },
    })
    await sink.writeRow({ seq: 0 })
    await sink.whenIdle()
    expect(fetch.calls[0].url).toBe('https://central.example/v1/ingest/proxy')
  })

  it('composes URLs correctly when centralUrl has no trailing slash', async () => {
    const { sink, fetch } = buildSink({
      handlers: [() => jsonResponse(202)],
      centralUrl: 'https://central.example',
      batch: { maxRows: 1, maxBytes: 100_000, maxSeconds: 60 },
    })
    await sink.writeRow({ seq: 0 })
    await sink.whenIdle()
    expect(fetch.calls[0].url).toBe('https://central.example/v1/ingest/proxy')
  })

  it('routes to /v1/ingest/<signal> for non-default signals', async () => {
    const { sink, fetch } = buildSink({
      handlers: [() => jsonResponse(202)],
      signal: 'logs',
      batch: { maxRows: 1, maxBytes: 100_000, maxSeconds: 60 },
    })
    await sink.writeRow({ seq: 0 })
    await sink.whenIdle()
    expect(fetch.calls[0].url).toBe('https://central.example/v1/ingest/logs')
  })
})

describe('ShippingSink: JSON serialisation guard', () => {
  it('throws when writeRow is given a value that JSON.stringify drops', async () => {
    const { sink } = buildSink()
    await expect(sink.writeRow(undefined)).rejects.toThrow(/JSON-serializable/)
  })
})

describe('ShippingSink: batch ordering', () => {
  it('serialises ships per-signal so the server sees batches in submission order', async () => {
    /** @type {string[]} */
    const arrived = []
    const { sink } = buildSink({
      handlers: [
        async (_, init) => {
          // Simulate a slow first request; the second batch must wait.
          await new Promise((r) => setImmediate(r))
          arrived.push(`batch-1:${parseFirstSeq(init.body)}`)
          return jsonResponse(202)
        },
        (_, init) => {
          arrived.push(`batch-2:${parseFirstSeq(init.body)}`)
          return Promise.resolve(jsonResponse(202))
        },
      ],
      batch: { maxRows: 2, maxBytes: 100_000, maxSeconds: 60 },
    })
    // Four rows → two size-flushes back-to-back.
    await sink.writeRow({ seq: 0 })
    await sink.writeRow({ seq: 1 })
    await sink.writeRow({ seq: 2 })
    await sink.writeRow({ seq: 3 })
    await sink.whenIdle()

    expect(arrived).toEqual(['batch-1:0', 'batch-2:2'])
  })
})

describe('ShippingSink: error detail extraction', () => {
  it('surfaces a JSON `error` field when the server returns 5xx', async () => {
    const { sink } = buildSink({
      handlers: [
        () => jsonResponse(500, { error: 'spool unavailable' }),
      ],
    })
    // Drive shipBatch directly so the assertion can `await` the rejection
    // without going through the chain (which swallows for backpressure).
    await expect(sink.shipBatch('proxy', ['{"seq":0}']))
      .rejects.toThrow(/500.*spool unavailable/)
  })

  it('falls back to status text when the server returns no body', async () => {
    const { sink } = buildSink({
      handlers: [
        () => new Response(null, { status: 503, statusText: 'Service Unavailable' }),
      ],
    })
    await expect(sink.shipBatch('proxy', ['{"seq":0}']))
      .rejects.toThrow(/503.*Service Unavailable/)
  })
})

afterEach(() => {
  // Sanity: every test cleaned up its own resources via `close()` or
  // `whenIdle()`; nothing process-wide to tear down.
})

beforeEach(() => {
  // No-op: the ShippingSink owns no module-level state.
})

/**
 * Pull the `seq` of the first NDJSON row out of a request body. Used by
 * the ordering test to identify which logical batch reached the server
 * without depending on whole-body snapshots.
 *
 * @param {BodyInit | null | undefined} body
 * @returns {number}
 */
function parseFirstSeq(body) {
  const text = String(body)
  const first = text.split('\n')[0]
  return JSON.parse(first).seq
}
