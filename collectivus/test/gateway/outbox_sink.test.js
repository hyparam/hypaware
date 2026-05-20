import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OutboxSink, defaultOutboxDir } from '../../src/gateway/outbox_sink.js'

/**
 * @import { ShippingSinkIdentitySource } from '../../src/gateway/types.d.ts'
 */

/** @type {string} */
let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-outbox-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function memo() {
  let buf = ''
  return {
    write(/** @type {string} */ s) { buf += s },
    value() { return buf },
  }
}

/**
 * @returns {ShippingSinkIdentitySource & { refreshes: number, jwts: string[] }}
 */
function fakeIdentity() {
  return {
    refreshes: 0,
    jwts: ['jwt-1'],
    getCurrentJwt() {
      return Promise.resolve(this.jwts[this.jwts.length - 1])
    },
    refresh() {
      this.refreshes += 1
      this.jwts.push(`jwt-${this.refreshes + 1}`)
      return Promise.resolve()
    },
  }
}

/**
 * @param {Array<Response | Error | { status: number, body?: string, headers?: Record<string, string> }>} responses
 * @returns {{ fetch: typeof fetch, calls: Array<{ url: string, headers: Headers, body: string }> }}
 */
function fakeFetch(responses) {
  /** @type {Array<{ url: string, headers: Headers, body: string }>} */
  const calls = []
  function fetchFn(/** @type {string | URL | Request} */ url, /** @type {RequestInit | undefined} */ init) {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ''),
    })
    const next = responses.shift()
    if (next instanceof Error) return Promise.reject(next)
    if (next instanceof Response) return Promise.resolve(next)
    const status = next?.status ?? 202
    return Promise.resolve(new Response(next?.body ?? JSON.stringify({ ok: status < 400 }), {
      status,
      headers: next?.headers,
    }))
  }
  /** @type {typeof fetch} */
  const fetchTyped = fetchFn
  return { fetch: fetchTyped, calls }
}

/**
 * @returns {{ setTimeoutFn: (handler: () => void, ms: number) => unknown, clearTimeoutFn: (h: unknown) => void, delays: number[] }}
 */
function fakeTimers() {
  /** @type {number[]} */
  const delays = []
  return {
    delays,
    setTimeoutFn(handler, ms) {
      delays.push(ms)
      // Rotation timers use 60s in these tests. Retry sleeps use smaller
      // durations and fire immediately so retry behavior is deterministic.
      if (ms !== 60_000) queueMicrotask(handler)
      return { id: delays.length }
    },
    clearTimeoutFn() {},
  }
}

/**
 * @param {Partial<ConstructorParameters<typeof OutboxSink>[0]>} [opts]
 * @returns {{ sink: OutboxSink, fetch: ReturnType<typeof fakeFetch>, timers: ReturnType<typeof fakeTimers>, identity: ReturnType<typeof fakeIdentity>, stderr: ReturnType<typeof memo> }}
 */
function buildSink(opts = {}) {
  const fetch = fakeFetch(opts.fetchFn ? [] : [{ status: 202 }])
  const timers = fakeTimers()
  const identity = fakeIdentity()
  const stderr = memo()
  const sink = new OutboxSink({
    outboxDir: tmpDir,
    centralUrl: 'https://central.example',
    identityClient: identity,
    signal: 'proxy',
    batch: { maxRows: 1, maxBytes: 1024 * 1024, maxSeconds: 60 },
    fetchFn: fetch.fetch,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    stderr,
    ...opts,
  })
  return { sink, fetch, timers, identity, stderr }
}

describe('defaultOutboxDir', () => {
  it('uses central_server.outbox_dir when configured', () => {
    expect(defaultOutboxDir({
      url: 'https://central.example',
      identity: {},
      outbox_dir: '/var/lib/collectivus/outbox',
    })).toBe('/var/lib/collectivus/outbox')
  })

  it('defaults next to the persisted identity file', () => {
    expect(defaultOutboxDir({
      url: 'https://central.example',
      identity: { persisted_path: '/var/lib/collectivus/identity.json' },
    })).toBe('/var/lib/collectivus/outbox')
  })
})

describe('OutboxSink local durability and lifecycle', () => {
  it('writeRow resolves after the row is fsynced to an active .open file', async () => {
    const fetch = fakeFetch([])
    const timers = fakeTimers()
    const sink = new OutboxSink({
      outboxDir: tmpDir,
      centralUrl: 'https://central.example',
      identityClient: fakeIdentity(),
      signal: 'proxy',
      batch: { maxRows: 1000, maxBytes: 1024 * 1024, maxSeconds: 60 },
      fetchFn: fetch.fetch,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      stderr: memo(),
    })

    await sink.writeRow({ seq: 1 })

    const files = fs.readdirSync(path.join(tmpDir, 'proxy'))
    expect(files.filter((name) => name.endsWith('.open'))).toHaveLength(1)
    const text = fs.readFileSync(path.join(tmpDir, 'proxy', files[0]), 'utf8')
    expect(text).toBe(JSON.stringify({ seq: 1 }) + '\n')
    expect(fetch.calls).toHaveLength(0)
    await sink.close()
  })

  it('rotates on row threshold, sends the batch, and deletes it on 202', async () => {
    const { sink, fetch } = buildSink()

    await sink.writeRow({ seq: 1 })
    await sink.whenIdle()

    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0].url).toBe('https://central.example/v1/ingest/proxy')
    expect(fetch.calls[0].body).toBe(JSON.stringify({ seq: 1 }) + '\n')
    const files = fs.readdirSync(path.join(tmpDir, 'proxy'))
    expect(files).toEqual([])
    await sink.close()
  })

  it('recovers .open and .sending files back into the send queue on startup', async () => {
    const signalDir = path.join(tmpDir, 'proxy')
    fs.mkdirSync(signalDir, { recursive: true })
    fs.writeFileSync(path.join(signalDir, 'a.open'), '{"a":1}\n')
    fs.writeFileSync(path.join(signalDir, 'b.sending'), '{"b":2}\n')
    const fetch = fakeFetch([{ status: 202 }, { status: 202 }])

    const sink = new OutboxSink({
      outboxDir: tmpDir,
      centralUrl: 'https://central.example',
      identityClient: fakeIdentity(),
      signal: 'proxy',
      batch: { maxRows: 1, maxBytes: 1024 * 1024, maxSeconds: 60 },
      fetchFn: fetch.fetch,
      stderr: memo(),
    })
    await sink.whenIdle()

    expect(fetch.calls.map((c) => c.body).sort()).toEqual(['{"a":1}\n', '{"b":2}\n'])
    expect(fs.readdirSync(signalDir)).toEqual([])
    await sink.close()
  })
})

describe('OutboxSink shipping retries', () => {
  it('refreshes the JWT once on 401 and retries the same batch', async () => {
    const fetch = fakeFetch([{ status: 401, body: '{"error":"expired"}' }, { status: 202 }])
    const { sink, identity } = buildSink({ fetchFn: fetch.fetch })

    await sink.writeRow({ seq: 1 })
    await sink.whenIdle()

    expect(identity.refreshes).toBe(1)
    expect(fetch.calls).toHaveLength(2)
    expect(fetch.calls[0].headers.get('authorization')).toBe('Bearer jwt-1')
    expect(fetch.calls[1].headers.get('authorization')).toBe('Bearer jwt-2')
    await sink.close()
  })

  it('honors Retry-After for 429 and 503 before retrying', async () => {
    const fetch = fakeFetch([
      { status: 429, headers: { 'retry-after': '7' } },
      { status: 503, headers: { 'retry-after': '11' } },
      { status: 202 },
    ])
    const timers = fakeTimers()
    const sink = new OutboxSink({
      outboxDir: tmpDir,
      centralUrl: 'https://central.example',
      identityClient: fakeIdentity(),
      signal: 'proxy',
      batch: { maxRows: 1, maxBytes: 1024 * 1024, maxSeconds: 60 },
      fetchFn: fetch.fetch,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      stderr: memo(),
    })

    await sink.writeRow({ seq: 1 })
    await sink.whenIdle()

    expect(fetch.calls).toHaveLength(3)
    expect(timers.delays).toContain(7000)
    expect(timers.delays).toContain(11000)
    await sink.close()
  })

  it('uses exponential backoff for network and 5xx failures', async () => {
    const fetch = fakeFetch([
      new Error('ECONNRESET'),
      { status: 500, body: '{"error":"nope"}' },
      { status: 202 },
    ])
    const timers = fakeTimers()
    const sink = new OutboxSink({
      outboxDir: tmpDir,
      centralUrl: 'https://central.example',
      identityClient: fakeIdentity(),
      signal: 'proxy',
      batch: { maxRows: 1, maxBytes: 1024 * 1024, maxSeconds: 60 },
      fetchFn: fetch.fetch,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      stderr: memo(),
    })

    await sink.writeRow({ seq: 1 })
    await sink.whenIdle()

    expect(fetch.calls).toHaveLength(3)
    expect(timers.delays).toContain(1000)
    expect(timers.delays).toContain(2000)
    await sink.close()
  })

  it('moves unrecoverable 4xx batches to failed', async () => {
    const fetch = fakeFetch([{ status: 400, body: '{"error":"bad row"}' }])
    const stderr = memo()
    const { sink } = buildSink({ fetchFn: fetch.fetch, stderr })

    await sink.writeRow({ seq: 1 })
    await sink.whenIdle()

    const failedDir = path.join(tmpDir, 'proxy', 'failed')
    const failed = fs.readdirSync(failedDir)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatch(/\.ndjson$/)
    expect(fs.readFileSync(path.join(failedDir, failed[0]), 'utf8')).toBe(JSON.stringify({ seq: 1 }) + '\n')
    expect(stderr.value()).toMatch(/moved poison batch to failed/)
    await sink.close()
  })
})
