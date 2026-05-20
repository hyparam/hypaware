import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ConfigClient,
  DEFAULT_POLL_INTERVAL_SECONDS,
  NETWORK_BACKOFF_SCHEDULE_SECONDS,
  NOT_REGISTERED_BACKOFF_SECONDS,
} from '../../src/gateway/config_client.js'

/**
 * @import { CentralServerConfig, CollectivusConfig } from '../../src/types.js'
 * @import { ConfigChangedEvent } from '../../src/gateway/types.d.ts'
 */

/**
 * Build a `CentralServerConfig` for tests with sensible defaults.
 *
 * @param {Partial<{ url: string, poll_interval_seconds: number, bootstrap_token: string }>} [overrides]
 * @returns {CentralServerConfig}
 */
function centralConfig(overrides = {}) {
  return {
    url: overrides.url ?? 'https://central.example/',
    identity: { bootstrap_token: overrides.bootstrap_token ?? 'unused' },
    poll_interval_seconds: overrides.poll_interval_seconds,
  }
}

/**
 * Build a fake IdentitySource that satisfies ConfigClient's contract: a
 * persisted-path field (used to derive the etag sidecar location), plus
 * `getCurrentJwt` and `refresh` methods. Tests don't need the full identity
 * lifecycle here; that's covered in test/gateway/identity.test.js.
 *
 * @param {{
 *   jwt?: string,
 *   refreshedJwt?: string,
 *   persistedPath: string,
 *   getCurrentJwtThrows?: () => Error,
 *   refreshThrows?: () => Error,
 * }} opts
 * @returns {{
 *   persistedPath: string,
 *   calls: { getCurrentJwt: number, refresh: number },
 *   readonly jwt: string,
 *   getCurrentJwt(): Promise<string>,
 *   refresh(): Promise<void>,
 * }}
 */
function fakeIdentityClient(opts) {
  const calls = { getCurrentJwt: 0, refresh: 0 }
  let currentJwt = opts.jwt ?? 'jwt-1'
  return {
    persistedPath: opts.persistedPath,
    calls,
    get jwt() { return currentJwt },
    getCurrentJwt() {
      calls.getCurrentJwt++
      if (opts.getCurrentJwtThrows) return Promise.reject(opts.getCurrentJwtThrows())
      return Promise.resolve(currentJwt)
    },
    refresh() {
      calls.refresh++
      if (opts.refreshThrows) return Promise.reject(opts.refreshThrows())
      currentJwt = opts.refreshedJwt ?? `${currentJwt}-refreshed`
      return Promise.resolve()
    },
  }
}

/**
 * Stub fetch with a queue of canned responses. Each call consumes the next
 * handler. `calls` records what we asked for so tests can assert on URL,
 * method, and headers.
 *
 * @param {Array<(url: string, init?: RequestInit) => Response | Promise<Response>>} handlers
 * @returns {{
 *   calls: Array<{ url: string, init?: RequestInit }>,
 *   fetchFn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
 * }}
 */
function stubFetch(handlers) {
  /** @type {Array<{ url: string, init?: RequestInit }>} */
  const calls = []
  let i = 0
  /**
   * @param {string | URL | Request} url
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  function fetchFn(url, init) {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    calls.push({ url: u, init })
    if (i >= handlers.length) {
      return Promise.reject(new Error(`stubFetch: unexpected call #${i + 1} to ${u}`))
    }
    const handler = handlers[i++]
    return Promise.resolve(handler(u, init))
  }
  return { calls, fetchFn }
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * @param {string} etag
 * @returns {Response}
 */
function notModified(etag) {
  return new Response(null, { status: 304, headers: { etag } })
}

/**
 * @param {RequestInit | undefined} init
 * @param {string} name
 * @returns {string | undefined}
 */
function readHeader(init, name) {
  const headers = init?.headers
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => k.toLowerCase() === name.toLowerCase())
    return found ? found[1] : undefined
  }
  const map = /** @type {Record<string, string>} */ (headers)
  return map[name] ?? map[name.toLowerCase()] ?? map[name.toUpperCase()]
}

/**
 * Capture stderr writes for assertion.
 *
 * @returns {{ write(s: string): void, value(): string }}
 */
function memoStream() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

/**
 * Shape a valid gateway-side CollectivusConfig for stubbed `200` responses.
 *
 * @param {{ url?: string }} [opts]
 * @returns {CollectivusConfig}
 */
function gatewayConfig(opts = {}) {
  return {
    version: 1,
    role: 'gateway',
    sink: { type: 'file', dir: '/tmp/cfg-test-sink' },
    central_server: {
      url: opts.url ?? 'https://central.example',
      identity: { bootstrap_token: 'placeholder' },
    },
  }
}

describe('ConfigClient.tick: first fetch', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let identityPath
  /** @type {string} */
  let etagPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cfgc-'))
    identityPath = path.join(dir, 'identity.json')
    etagPath = path.join(dir, 'config-etag.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('issues GET /v1/config with bearer JWT and no If-None-Match when etag is unknown', async () => {
    const cfg = gatewayConfig({ url: 'https://upstream-a.example' })
    const { fetchFn, calls } = stubFetch([
      () => jsonResponse(200, cfg, { etag: 'etag-a' }),
    ])
    const identity = fakeIdentityClient({ jwt: 'jwt-1', persistedPath: identityPath })
    const client = new ConfigClient(centralConfig(), identity, { fetchFn })

    /** @type {ConfigChangedEvent | undefined} */
    let event
    client.on('config-changed', (e) => { event = e })
    const next = await client.tick()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://central.example/v1/config')
    expect(calls[0].init?.method).toBe('GET')
    expect(readHeader(calls[0].init, 'authorization')).toBe('Bearer jwt-1')
    expect(readHeader(calls[0].init, 'if-none-match')).toBeUndefined()

    if (!event) throw new Error('expected config-changed event')
    expect(event.newConfig).toEqual(cfg)
    expect(event.etag).toBe('etag-a')
    expect(typeof event.fetchedAt).toBe('string')

    // ETag persisted to the sidecar with mode 0600.
    expect(fs.existsSync(etagPath)).toBe(true)
    expect(fs.statSync(etagPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(etagPath, 'utf8'))).toEqual({ etag: 'etag-a' })

    // Cadence resumes at the configured poll interval.
    expect(next).toBe(DEFAULT_POLL_INTERVAL_SECONDS)
  })

  it('sends If-None-Match on subsequent ticks once the etag is known', async () => {
    const cfg = gatewayConfig()
    const { fetchFn, calls } = stubFetch([
      () => jsonResponse(200, cfg, { etag: 'etag-1' }),
      () => notModified('etag-1'),
    ])
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const client = new ConfigClient(centralConfig(), identity, { fetchFn })

    await client.tick()
    expect(readHeader(calls[0].init, 'if-none-match')).toBeUndefined()

    let emitted = 0
    client.on('config-changed', () => { emitted++ })
    await client.tick()
    expect(readHeader(calls[1].init, 'if-none-match')).toBe('etag-1')
    expect(emitted).toBe(0)
  })

  it('reads a previously-persisted etag and short-circuits to 304 on first tick', async () => {
    fs.writeFileSync(etagPath, JSON.stringify({ etag: 'etag-from-disk' }), { mode: 0o600 })
    const { fetchFn, calls } = stubFetch([
      () => notModified('etag-from-disk'),
    ])
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const client = new ConfigClient(centralConfig(), identity, { fetchFn })

    let emitted = 0
    client.on('config-changed', () => { emitted++ })
    await client.tick()

    expect(readHeader(calls[0].init, 'if-none-match')).toBe('etag-from-disk')
    expect(emitted).toBe(0)
  })
})

describe('ConfigClient.tick: config change & validation', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let identityPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cfgc-'))
    identityPath = path.join(dir, 'identity.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('emits config-changed with the new etag when the server returns 200 after a 304 streak', async () => {
    const original = gatewayConfig({ url: 'https://upstream-old.example' })
    const updated = gatewayConfig({ url: 'https://upstream-new.example' })
    const { fetchFn } = stubFetch([
      () => jsonResponse(200, original, { etag: 'etag-1' }),
      () => notModified('etag-1'),
      () => jsonResponse(200, updated, { etag: 'etag-2' }),
    ])
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const client = new ConfigClient(centralConfig(), identity, { fetchFn })

    /** @type {ConfigChangedEvent[]} */
    const events = []
    client.on('config-changed', (e) => { events.push(e) })

    await client.tick() // initial 200
    await client.tick() // 304, no event
    await client.tick() // updated 200

    expect(events).toHaveLength(2)
    expect(events[1].newConfig).toEqual(updated)
    expect(events[1].etag).toBe('etag-2')
  })

  it('discards an invalid config (logs + no event) and continues at the normal cadence', async () => {
    const invalid = { version: 99, role: 'gateway' } // bad version, missing central_server
    const { fetchFn } = stubFetch([
      () => jsonResponse(200, invalid, { etag: 'etag-bad' }),
    ])
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const stderr = memoStream()
    const client = new ConfigClient(centralConfig(), identity, { fetchFn, stderr })

    let emitted = 0
    client.on('config-changed', () => { emitted++ })
    const next = await client.tick()

    expect(emitted).toBe(0)
    expect(stderr.value()).toMatch(/server returned invalid config/)
    // The normal cadence still applies; invalid configs aren't a transport
    // failure, so we don't escalate the backoff.
    expect(next).toBe(DEFAULT_POLL_INTERVAL_SECONDS)
    // ETag is NOT advanced to the bad one: keep what we had (none).
    expect(client.etag).toBeUndefined()
  })
})

describe('ConfigClient.tick: auth (401)', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let identityPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cfgc-'))
    identityPath = path.join(dir, 'identity.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refreshes the JWT on 401 and retries with the new bearer once', async () => {
    const cfg = gatewayConfig()
    const { fetchFn, calls } = stubFetch([
      () => jsonResponse(401, { error: 'expired' }),
      () => jsonResponse(200, cfg, { etag: 'etag-fresh' }),
    ])
    const identity = fakeIdentityClient({
      jwt: 'jwt-old',
      refreshedJwt: 'jwt-new',
      persistedPath: identityPath,
    })
    const client = new ConfigClient(centralConfig(), identity, { fetchFn })

    /** @type {ConfigChangedEvent | undefined} */
    let event
    client.on('config-changed', (e) => { event = e })
    await client.tick()

    expect(identity.calls.refresh).toBe(1)
    expect(calls).toHaveLength(2)
    expect(readHeader(calls[0].init, 'authorization')).toBe('Bearer jwt-old')
    expect(readHeader(calls[1].init, 'authorization')).toBe('Bearer jwt-new')
    if (!event) throw new Error('expected config-changed event')
    expect(event.etag).toBe('etag-fresh')
  })

  it('treats a second 401 (after refresh) as a transport failure and backs off', async () => {
    const { fetchFn, calls } = stubFetch([
      () => jsonResponse(401, { error: 'expired' }),
      () => jsonResponse(401, { error: 'still bad' }),
    ])
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const stderr = memoStream()
    const client = new ConfigClient(centralConfig(), identity, { fetchFn, stderr })

    const next = await client.tick()
    expect(calls).toHaveLength(2)
    expect(next).toBe(NETWORK_BACKOFF_SCHEDULE_SECONDS[0])
    expect(stderr.value()).toMatch(/401 even after JWT refresh/)
  })

  it('treats a refresh failure as a network error and skips the retry', async () => {
    const { fetchFn, calls } = stubFetch([
      () => jsonResponse(401, { error: 'expired' }),
    ])
    const identity = fakeIdentityClient({
      persistedPath: identityPath,
      refreshThrows: () => new Error('refresh: ECONNREFUSED'),
    })
    const stderr = memoStream()
    const client = new ConfigClient(centralConfig(), identity, { fetchFn, stderr })

    const next = await client.tick()
    expect(calls).toHaveLength(1)
    expect(next).toBe(NETWORK_BACKOFF_SCHEDULE_SECONDS[0])
    expect(stderr.value()).toMatch(/refresh failed/)
  })
})

describe('ConfigClient.tick: 404 not registered', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let identityPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cfgc-'))
    identityPath = path.join(dir, 'identity.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('logs once, applies the 5-min backoff, and re-logs after a transition out and back in', async () => {
    const cfg = gatewayConfig()
    const { fetchFn } = stubFetch([
      () => jsonResponse(404, { error: 'no config' }),
      () => jsonResponse(404, { error: 'no config' }),
      () => jsonResponse(200, cfg, { etag: 'etag-1' }),
      () => jsonResponse(404, { error: 'no config' }),
    ])
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const stderr = memoStream()
    const client = new ConfigClient(centralConfig(), identity, { fetchFn, stderr })

    expect(await client.tick()).toBe(NOT_REGISTERED_BACKOFF_SECONDS)
    expect(await client.tick()).toBe(NOT_REGISTERED_BACKOFF_SECONDS)
    expect(await client.tick()).toBe(DEFAULT_POLL_INTERVAL_SECONDS)
    expect(await client.tick()).toBe(NOT_REGISTERED_BACKOFF_SECONDS)

    const matches = stderr.value().match(/no config registered/g) ?? []
    // First 404 logs; second 404 is suppressed; success clears the flag;
    // the trailing 404 logs again.
    expect(matches).toHaveLength(2)
  })
})

describe('ConfigClient.tick: transport failures (network / 5xx)', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let identityPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cfgc-'))
    identityPath = path.join(dir, 'identity.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('walks the linear backoff schedule on consecutive failures and resets on success', async () => {
    const cfg = gatewayConfig()
    const { fetchFn } = stubFetch([
      () => { throw new Error('ECONNREFUSED') },
      () => { throw new Error('ECONNREFUSED') },
      () => { throw new Error('ECONNREFUSED') },
      () => { throw new Error('ECONNREFUSED') },
      () => { throw new Error('ECONNREFUSED') },
      () => jsonResponse(200, cfg, { etag: 'etag-1' }),
      () => { throw new Error('ECONNREFUSED') },
    ])
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const stderr = memoStream()
    const client = new ConfigClient(centralConfig(), identity, { fetchFn, stderr })

    expect(await client.tick()).toBe(NETWORK_BACKOFF_SCHEDULE_SECONDS[0])
    expect(await client.tick()).toBe(NETWORK_BACKOFF_SCHEDULE_SECONDS[1])
    expect(await client.tick()).toBe(NETWORK_BACKOFF_SCHEDULE_SECONDS[2])
    expect(await client.tick()).toBe(NETWORK_BACKOFF_SCHEDULE_SECONDS[3])
    expect(await client.tick()).toBe(NETWORK_BACKOFF_SCHEDULE_SECONDS[3])
    expect(await client.tick()).toBe(DEFAULT_POLL_INTERVAL_SECONDS)
    // Backoff resets after success.
    expect(await client.tick()).toBe(NETWORK_BACKOFF_SCHEDULE_SECONDS[0])
  })

  it('treats 500-class responses the same as a network error', async () => {
    const { fetchFn } = stubFetch([
      () => jsonResponse(500, { error: 'boom' }),
      () => jsonResponse(503, { error: 'try again' }),
    ])
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const stderr = memoStream()
    const client = new ConfigClient(centralConfig(), identity, { fetchFn, stderr })

    expect(await client.tick()).toBe(NETWORK_BACKOFF_SCHEDULE_SECONDS[0])
    expect(await client.tick()).toBe(NETWORK_BACKOFF_SCHEDULE_SECONDS[1])
    expect(stderr.value()).toMatch(/server returned 500/)
    expect(stderr.value()).toMatch(/server returned 503/)
  })
})

describe('ConfigClient: start / stop / poll interval', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let identityPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cfgc-'))
    identityPath = path.join(dir, 'identity.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('honors central_server.poll_interval_seconds when set', async () => {
    const cfg = gatewayConfig()
    const { fetchFn } = stubFetch([
      () => jsonResponse(200, cfg, { etag: 'etag-1' }),
    ])
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const client = new ConfigClient(
      centralConfig({ poll_interval_seconds: 600 }),
      identity,
      { fetchFn }
    )
    expect(client.pollIntervalSeconds).toBe(600)
    expect(await client.tick()).toBe(600)
  })

  it('start() schedules the first tick via the injected setTimeout, and stop() cancels it', () => {
    /** @type {Array<{ delay: number, handler: () => void, cancelled: boolean }>} */
    const scheduled = []
    /**
     * @param {() => void} handler
     * @param {number} delay
     * @returns {{ delay: number, handler: () => void, cancelled: boolean }}
     */
    function setTimeoutFn(handler, delay) {
      const handle = { delay, handler, cancelled: false }
      scheduled.push(handle)
      return handle
    }
    /** @param {{ cancelled: boolean }} handle */
    function clearTimeoutFn(handle) { if (handle) handle.cancelled = true }

    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const client = new ConfigClient(
      centralConfig(),
      identity,
      {
        fetchFn: () => Promise.reject(new Error('not used')),
        setTimeoutFn: /** @type {any} */ (setTimeoutFn),
        clearTimeoutFn: /** @type {any} */ (clearTimeoutFn),
      }
    )
    client.start()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].delay).toBe(0)

    client.stop()
    expect(scheduled[0].cancelled).toBe(true)
    // Scheduling after stop is a no-op so a late completion can't restart us.
    client.scheduleNext(10)
    expect(scheduled).toHaveLength(1)
  })

  it('whenIdle resolves immediately when no tick is in flight', async () => {
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const client = new ConfigClient(
      centralConfig(),
      identity,
      { fetchFn: () => Promise.reject(new Error('not used')) }
    )
    await client.whenIdle()
  })

  it('whenIdle waits for an in-flight tick before resolving', async () => {
    /** @type {((value: Response) => void) | undefined} */
    let resolveFetch
    /** @returns {Promise<Response>} */
    function fetchFn() {
      return new Promise((resolve) => {
        resolveFetch = resolve
      })
    }
    const identity = fakeIdentityClient({ persistedPath: identityPath })
    const client = new ConfigClient(
      centralConfig(),
      identity,
      { fetchFn: /** @type {any} */ (fetchFn) }
    )
    const tickPromise = client.tick()
    let idleResolved = false
    const idle = client.whenIdle().then(() => { idleResolved = true })
    // Yield once: whenIdle must NOT resolve while the fetch hangs.
    await new Promise((r) => setTimeout(r, 0))
    expect(idleResolved).toBe(false)
    if (!resolveFetch) throw new Error('fetch did not register a resolver')
    resolveFetch(notModified('x'))
    await tickPromise
    await idle
    expect(idleResolved).toBe(true)
  })
})

describe('ConfigClient: construction', () => {
  it('throws when central_server.url is missing', () => {
    const identity = fakeIdentityClient({ persistedPath: '/tmp/no.json' })
    expect(() => new ConfigClient(/** @type {any} */ ({ identity: {} }), identity)).toThrow(
      /central_server\.url is required/
    )
  })

  it('throws when identityClient is missing', () => {
    expect(() => new ConfigClient(centralConfig(), /** @type {any} */ (undefined))).toThrow(
      /identityClient is required/
    )
  })

  it('derives the etag sidecar path from the identity persisted path', () => {
    const identity = fakeIdentityClient({ persistedPath: '/var/state/collectivus/identity.json' })
    const client = new ConfigClient(centralConfig(), identity)
    expect(client.etagPath).toBe('/var/state/collectivus/config-etag.json')
  })
})
