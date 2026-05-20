import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ControlPlane } from '../../src/server/control_plane.js'
import { createConfigRegistry, setConfig } from '../../src/server/config_registry.js'
import { Ingest } from '../../src/server/ingest.js'
import { signJwt } from '../../src/server/identity.js'
import { TokenBucket } from '../../src/server/rate_limit.js'

/**
 * @import { ServerConfig, IngestThrottleConfig } from '../../src/types.js'
 */

const SECRET = 'a'.repeat(32)

/**
 * @param {{ sinkDir: string, ingest?: IngestThrottleConfig }} opts
 * @returns {ServerConfig}
 */
function serverConfig(opts) {
  /** @type {ServerConfig} */
  const cfg = {
    control_plane_listen: '127.0.0.1:0',
    identity_issuer: { secret: SECRET },
    sink_dir: opts.sinkDir,
  }
  if (opts.ingest) cfg.ingest = opts.ingest
  return cfg
}

/**
 * @param {number} initialMs
 * @returns {{ now: () => number, advance: (ms: number) => void, set: (ms: number) => void }}
 */
function fakeClock(initialMs) {
  let t = initialMs
  return {
    now: () => t,
    advance: (/** @type {number} */ ms) => { t += ms },
    set: (/** @type {number} */ ms) => { t = ms },
  }
}

/**
 * @param {object[]} rows
 * @returns {string}
 */
function ndjson(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

/**
 * @returns {object}
 */
function gatewayConfig() {
  return {
    version: 1,
    role: 'gateway',
    central_server: { url: 'https://central.example.com', identity: {} },
  }
}

/**
 * Test harness that exposes a `holdWrites` switch so a test can keep
 * `pendingRows` pinned high without doing real I/O. Each call to a held
 * `appendBatch` adds a `release()` to `releases`; the harness drains them
 * automatically in `afterEach` so a test that throws mid-flight doesn't
 * leak a never-resolving HTTP request and stall `plane.stop()`.
 *
 * @returns {{ boot: (opts?: { ingest?: IngestThrottleConfig, holdWrites?: boolean, gatewayId?: string }) => Promise<{
 *   jwt: string,
 *   clock: ReturnType<typeof fakeClock>,
 *   baseUrl: string,
 *   ingest: Ingest,
 *   releaseAll: () => void,
 *   getDir: () => string,
 * }> }}
 */
function makeHarness() {
  /** @type {string} */
  let dir
  /** @type {ControlPlane | undefined} */
  let plane
  /** @type {(() => void)[]} */
  let releases = []

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-ingest-bp-'))
    releases = []
  })
  afterEach(async () => {
    // Always release any held writes so plane.stop() can drain its
    // in-flight HTTP requests instead of hanging on a never-resolving
    // appendBatch promise.
    for (const r of releases) r()
    releases = []
    if (plane) await plane.stop()
    plane = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /**
   * @param {{ ingest?: IngestThrottleConfig, holdWrites?: boolean, gatewayId?: string }} [opts]
   * @returns {Promise<{
   *   jwt: string,
   *   clock: ReturnType<typeof fakeClock>,
   *   baseUrl: string,
   *   ingest: Ingest,
   *   releaseAll: () => void,
   *   getDir: () => string,
   * }>}
   */
  async function boot(opts = {}) {
    const gatewayId = opts.gatewayId ?? 'gw-1'
    const clock = fakeClock(Date.UTC(2026, 4, 8, 12, 0, 0))
    const registry = createConfigRegistry({ configsDir: path.join(dir, 'configs') })
    setConfig(registry, gatewayId, gatewayConfig())
    plane = new ControlPlane(
      serverConfig({ sinkDir: dir, ingest: opts.ingest }),
      { now: clock.now, configRegistry: registry }
    )
    if (opts.holdWrites) {
      // Replace the per-file write step with a function that blocks until
      // we call `release()`. We still bump/decrement pendingRows ourselves
      // so the production handler observes the same backpressure signal it
      // would in a real "disk is slow" scenario.
      plane.ingest.appendBatch = (args) => {
        plane.ingest.pendingRows += args.lines.length
        return new Promise((resolve) => {
          releases.push(() => {
            plane.ingest.pendingRows -= args.lines.length
            resolve(undefined)
          })
        })
      }
    }
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const jwt = signJwt({ gatewayId, ttlSeconds: 3600, secret: SECRET, now: clock.now })
    return {
      jwt,
      clock,
      baseUrl,
      ingest: plane.ingest,
      releaseAll: () => {
        for (const r of releases) r()
        releases.length = 0
      },
      getDir: () => dir,
    }
  }

  return { boot }
}

describe('Ingest pending-row backpressure', () => {
  const h = makeHarness()

  it('emits 429 with Retry-After once pendingRows hits the high-water mark', async () => {
    const { jwt, baseUrl, ingest, releaseAll } = await h.boot({
      ingest: { max_pending_rows: 100, high_water_pct: 80, retry_after_seconds: 7 },
      holdWrites: true,
    })
    // High-water threshold = 80. A single 80-row batch lands the queue
    // exactly at the high-water mark.
    const fillRows = Array.from({ length: 80 }, (_, i) => ({ i }))
    const fillRes = fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson(fillRows),
    })
    await waitFor(() => ingest.pendingRows >= 80)

    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('7')
    expect(await res.json()).toEqual({
      error: 'ingest backpressure',
      retry_after_seconds: 7,
    })
    expect(ingest.throttleStats.pendingHighWater).toBe(1)
    expect(ingest.throttleStats.pendingAtCapacity).toBe(0)

    // Release the held write so the original POST resolves cleanly and
    // `plane.stop()` in afterEach has nothing left to drain.
    releaseAll()
    await fillRes
  })

  it('emits 503 with Retry-After once pendingRows hits the hard cap', async () => {
    const { jwt, baseUrl, ingest, releaseAll } = await h.boot({
      ingest: { max_pending_rows: 50, high_water_pct: 80, retry_after_seconds: 3 },
      holdWrites: true,
    })
    // Pin the queue to maxPendingRows so the next request lands on the
    // >= cap branch (503), not the >= high_water branch (429).
    const fillRes = fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson(Array.from({ length: 50 }, (_, i) => ({ i }))),
    })
    await waitFor(() => ingest.pendingRows >= 50)

    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('3')
    expect(await res.json()).toEqual({
      error: 'ingest at capacity',
      retry_after_seconds: 3,
    })
    expect(ingest.throttleStats.pendingAtCapacity).toBe(1)
    // The capacity branch returns BEFORE the high-water branch is reached.
    expect(ingest.throttleStats.pendingHighWater).toBe(0)

    releaseAll()
    const fillResolved = await fillRes
    expect(fillResolved.status).toBe(202)
  })

  it('drains back below high-water and resumes accepting (202)', async () => {
    const { jwt, baseUrl, ingest, releaseAll } = await h.boot({
      ingest: { max_pending_rows: 100, high_water_pct: 80 },
      holdWrites: true,
    })
    const fillRes = fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson(Array.from({ length: 80 }, (_, i) => ({ i }))),
    })
    await waitFor(() => ingest.pendingRows >= 80)

    let res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(429)
    expect(ingest.throttleStats.pendingHighWater).toBe(1)

    // Drain the buffered batch — pendingRows returns to 0 — and restore
    // the real appendBatch so subsequent traffic exercises the normal path.
    releaseAll()
    await fillRes
    expect(ingest.pendingRows).toBe(0)
    // `delete` on the own-property stub falls back to Ingest.prototype.appendBatch.
    delete /** @type {Record<string, unknown>} */ /** @type {unknown} */ ingest.appendBatch

    // A fresh request now lands normally. The stat counter must NOT have
    // ticked again — the very point of the drain.
    res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(202)
    expect(ingest.throttleStats.pendingHighWater).toBe(1)
  })

  it('fires onThrottle with kind=high_water and kind=capacity', async () => {
    /** @type {string[]} */
    const kinds = []
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-ingest-hook-'))
    try {
      const clock = fakeClock(Date.UTC(2026, 4, 8, 12, 0, 0))
      const ingest = new Ingest({
        sinkDir: dir,
        now: clock.now,
        maxPendingRows: 10,
        highWaterPct: 50, // high-water threshold = 5
        onThrottle: (info) => kinds.push(info.kind),
      })
      const registry = createConfigRegistry({ configsDir: path.join(dir, 'configs') })
      setConfig(registry, 'gw-1', gatewayConfig())
      const cp = new ControlPlane(
        serverConfig({ sinkDir: dir }),
        { now: clock.now, ingest, configRegistry: registry }
      )
      await cp.start()
      try {
        const addr = cp.server?.address()
        if (!addr || typeof addr === 'string') throw new Error('no address')
        const baseUrl = `http://127.0.0.1:${addr.port}`
        const jwt = signJwt({ gatewayId: 'gw-1', ttlSeconds: 3600, secret: SECRET, now: clock.now })

        // Bump pendingRows to capacity → expect 503 + 'capacity' kind.
        ingest.pendingRows = 10
        let res = await fetch(`${baseUrl}/v1/ingest/logs`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
          body: ndjson([{ x: 1 }]),
        })
        expect(res.status).toBe(503)

        // Drop to high-water line → expect 429 + 'high_water' kind.
        ingest.pendingRows = 5
        res = await fetch(`${baseUrl}/v1/ingest/logs`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
          body: ndjson([{ x: 1 }]),
        })
        expect(res.status).toBe(429)

        // Drop below high-water → request lands normally.
        ingest.pendingRows = 0
        res = await fetch(`${baseUrl}/v1/ingest/logs`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
          body: ndjson([{ x: 1 }]),
        })
        expect(res.status).toBe(202)

        expect(kinds).toEqual(['capacity', 'high_water'])
      } finally {
        await cp.stop()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes proceed normally below the high-water mark', async () => {
    const { jwt, baseUrl, ingest, getDir } = await h.boot({
      ingest: { max_pending_rows: 100, high_water_pct: 80 },
    })
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ x: 1 }, { x: 2 }]),
    })
    expect(res.status).toBe(202)
    expect(ingest.throttleStats.pendingHighWater).toBe(0)
    expect(ingest.throttleStats.pendingAtCapacity).toBe(0)
    expect(ingest.pendingRows).toBe(0)
    const d = getDir()
    const file = path.join(d, 'gw-1', 'logs', '2026-05-08.jsonl')
    expect(fs.existsSync(file)).toBe(true)
  })
})

describe('Ingest disk-rate throttle', () => {
  /** @type {string} */
  let dir
  /** @type {ControlPlane | undefined} */
  let plane

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-ingest-rate-'))
  })
  afterEach(async () => {
    if (plane) await plane.stop()
    plane = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns 429 when a single batch would exceed the bytes-per-second ceiling', async () => {
    const clock = fakeClock(Date.UTC(2026, 4, 8, 12, 0, 0))
    const registry = createConfigRegistry({ configsDir: path.join(dir, 'configs') })
    setConfig(registry, 'gw-1', gatewayConfig())
    plane = new ControlPlane(
      serverConfig({ sinkDir: dir, ingest: { max_bytes_per_second: 64 } }),
      { now: clock.now, configRegistry: registry }
    )
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const jwt = signJwt({ gatewayId: 'gw-1', ttlSeconds: 3600, secret: SECRET, now: clock.now })

    // After tagging this row well exceeds 64 bytes — the bucket can never
    // grow past capacity, so it's rejected even on a fresh budget.
    const big = { i: 1, payload: 'x'.repeat(200) }
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([big]),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(await res.json()).toEqual({
      error: 'ingest disk-rate throttled',
      retry_after_seconds: 5,
    })
    expect(plane.ingest.throttleStats.byteRate).toBe(1)
  })

  it('drains the budget over time so steady-state traffic eventually accepts', async () => {
    const clock = fakeClock(Date.UTC(2026, 4, 8, 12, 0, 0))
    const registry = createConfigRegistry({ configsDir: path.join(dir, 'configs') })
    setConfig(registry, 'gw-1', gatewayConfig())
    plane = new ControlPlane(
      serverConfig({ sinkDir: dir, ingest: { max_bytes_per_second: 300 } }),
      { now: clock.now, configRegistry: registry }
    )
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const jwt = signJwt({ gatewayId: 'gw-1', ttlSeconds: 3600, secret: SECRET, now: clock.now })

    const row = { msg: 'hello' }
    /** @returns {Promise<Response>} */
    function post() {
      return fetch(`${baseUrl}/v1/ingest/logs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
        body: ndjson([row]),
      })
    }

    // The clock isn't advancing inside this loop, so the bucket only refills
    // by the real-wall-clock delta between requests. With a 300-byte ceiling
    // and ~75-byte rows, a few back-to-back posts will exhaust the budget.
    let throttled = 0
    let ok = 0
    for (let i = 0; i < 10; i++) {
      const res = await post()
      if (res.status === 429) throttled++
      else if (res.status === 202) ok++
      else throw new Error(`unexpected status ${res.status}`)
    }
    expect(throttled).toBeGreaterThan(0)
    expect(ok).toBeGreaterThan(0)

    // Advance the test clock by a full second; bucket refills to capacity.
    clock.advance(1000)
    expect((await post()).status).toBe(202)
  })

  it('does not throttle when max_bytes_per_second is omitted (default unlimited)', async () => {
    const clock = fakeClock(Date.UTC(2026, 4, 8, 12, 0, 0))
    const registry = createConfigRegistry({ configsDir: path.join(dir, 'configs') })
    setConfig(registry, 'gw-1', gatewayConfig())
    plane = new ControlPlane(serverConfig({ sinkDir: dir }), { now: clock.now, configRegistry: registry })
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const jwt = signJwt({ gatewayId: 'gw-1', ttlSeconds: 3600, secret: SECRET, now: clock.now })

    expect(plane.ingest.byteBudget).toBeUndefined()

    const big = { i: 1, payload: 'x'.repeat(10_000) }
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([big]),
    })
    expect(res.status).toBe(202)
    expect(plane.ingest.throttleStats.byteRate).toBe(0)
  })

  it('skips the byte budget for empty (zero-row) batches so they cannot consume tokens', async () => {
    const clock = fakeClock(Date.UTC(2026, 4, 8, 12, 0, 0))
    const registry = createConfigRegistry({ configsDir: path.join(dir, 'configs') })
    setConfig(registry, 'gw-1', gatewayConfig())
    plane = new ControlPlane(
      serverConfig({ sinkDir: dir, ingest: { max_bytes_per_second: 100 } }),
      { now: clock.now, configRegistry: registry }
    )
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const jwt = signJwt({ gatewayId: 'gw-1', ttlSeconds: 3600, secret: SECRET, now: clock.now })

    // A body of just blank lines parses to zero accepted rows. The handler
    // returns 202 with `accepted: 0` and must NOT debit the byte budget.
    const before = plane.ingest.byteBudget?.available()
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: '\n\n\n',
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: 0 })
    expect(plane.ingest.byteBudget?.available()).toBe(before)
  })
})

describe('Ingest constructor validation', () => {
  /** @type {string} */
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-ingest-cfg-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('applies spec defaults when the throttle options are omitted', () => {
    const ingest = new Ingest({ sinkDir: dir })
    expect(ingest.maxPendingRows).toBe(50_000)
    expect(ingest.highWaterPct).toBe(80)
    expect(ingest.retryAfterSeconds).toBe(5)
    expect(ingest.maxBytesPerSecond).toBeUndefined()
    expect(ingest.highWaterRows).toBe(40_000)
    expect(ingest.byteBudget).toBeUndefined()
  })

  it('rejects non-positive maxPendingRows', () => {
    expect(() => new Ingest({ sinkDir: dir, maxPendingRows: 0 }))
      .toThrow(/maxPendingRows must be a positive integer/)
    expect(() => new Ingest({ sinkDir: dir, maxPendingRows: -5 }))
      .toThrow(/maxPendingRows must be a positive integer/)
    expect(() => new Ingest({ sinkDir: dir, maxPendingRows: 1.5 }))
      .toThrow(/maxPendingRows must be a positive integer/)
  })

  it('rejects highWaterPct outside [1,100]', () => {
    expect(() => new Ingest({ sinkDir: dir, highWaterPct: 0 }))
      .toThrow(/highWaterPct must be an integer in \[1,100\]/)
    expect(() => new Ingest({ sinkDir: dir, highWaterPct: 101 }))
      .toThrow(/highWaterPct must be an integer in \[1,100\]/)
  })

  it('rejects non-positive retryAfterSeconds', () => {
    expect(() => new Ingest({ sinkDir: dir, retryAfterSeconds: 0 }))
      .toThrow(/retryAfterSeconds must be a positive integer/)
  })

  it('rejects non-positive maxBytesPerSecond when set', () => {
    expect(() => new Ingest({ sinkDir: dir, maxBytesPerSecond: 0 }))
      .toThrow(/maxBytesPerSecond must be a positive integer when set/)
  })

  it('floors fractional thresholds (101 * 50 / 100 = 50)', () => {
    const ingest = new Ingest({ sinkDir: dir, maxPendingRows: 101, highWaterPct: 50 })
    expect(ingest.highWaterRows).toBe(50)
  })
})

describe('TokenBucket', () => {
  it('starts full and rejects costs over capacity', () => {
    const clock = fakeClock(0)
    const b = new TokenBucket({ capacity: 100, refillPerSecond: 100, now: clock.now })
    expect(b.available()).toBe(100)
    expect(b.tryConsume(101)).toBe(false)
    expect(b.tryConsume(50)).toBe(true)
    expect(b.available()).toBe(50)
  })

  it('refills linearly over time, never exceeding capacity', () => {
    const clock = fakeClock(0)
    const b = new TokenBucket({ capacity: 100, refillPerSecond: 100, now: clock.now })
    expect(b.tryConsume(100)).toBe(true)
    expect(b.available()).toBe(0)
    clock.advance(500) // half a second → 50 tokens
    expect(b.available()).toBe(50)
    clock.advance(2_000) // way past full refill — caps at capacity
    expect(b.available()).toBe(100)
  })

  it('handles zero or negative time deltas without going backwards', () => {
    const clock = fakeClock(1_000)
    const b = new TokenBucket({ capacity: 100, refillPerSecond: 100, now: clock.now })
    b.tryConsume(50)
    expect(b.available()).toBe(50)
    expect(b.available()).toBe(50)
    // Even a misbehaving clock that rewinds doesn't add tokens.
    clock.set(500)
    expect(b.available()).toBe(50)
  })

  it('refills at the configured rate even when capacity > rate', () => {
    const clock = fakeClock(0)
    // Capacity 1000 but refill only 100/s — bursty tolerance, slow recovery.
    const b = new TokenBucket({ capacity: 1000, refillPerSecond: 100, now: clock.now })
    expect(b.tryConsume(1000)).toBe(true)
    clock.advance(5_000) // 5s × 100/s = 500 tokens
    expect(b.available()).toBe(500)
  })
})

// Helpers -------------------------------------------------------------------

/**
 * Poll an assertion until it passes or `timeoutMs` elapses. Used to wait
 * for a background fetch to populate `pendingRows` without inserting
 * brittle real-time sleeps in the test body.
 *
 * @param {() => boolean} cond
 * @param {number} [timeoutMs]
 */
async function waitFor(cond, timeoutMs = 1000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
