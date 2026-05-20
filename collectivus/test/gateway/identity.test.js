import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  IdentityClient,
  REFRESH_WINDOW_SECONDS,
} from '../../src/gateway/identity.js'
import { signJwt } from '../../src/server/identity.js'

/**
 * @import { CentralServerConfig } from '../../src/types.js'
 * @import { PersistedIdentity } from '../../src/gateway/types.d.ts'
 */

const SECRET = 'a'.repeat(32)

/**
 * @param {number} initialMs
 * @returns {{ now: () => number, set: (ms: number) => void, advance: (ms: number) => void }}
 */
function fakeClock(initialMs) {
  let t = initialMs
  return {
    now: () => t,
    set: (ms) => { t = ms },
    advance: (ms) => { t += ms },
  }
}

/**
 * Build a stub `fetch` that records calls and returns canned responses. The
 * IdentityClient is the only `fetch` consumer in the gateway, so we don't
 * need a full server — just shape the responses.
 *
 * @param {Array<(url: string, init?: RequestInit) => Response | Promise<Response>>} handlers
 *   One handler per expected call, applied in order. Tests assert handler
 *   exhaustion via `calls.length`.
 * @returns {{
 *   fetchFn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
 *   calls: Array<{ url: string, init?: RequestInit }>,
 * }}
 */
function stubFetch(handlers) {
  /** @type {Array<{ url: string, init?: RequestInit }>} */
  const calls = []
  let i = 0
  return {
    calls,
    fetchFn: (url, init) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      calls.push({ url: u, init })
      if (i >= handlers.length) {
        return Promise.reject(new Error(`stubFetch: unexpected call #${i + 1} to ${u}`))
      }
      const handler = handlers[i++]
      return Promise.resolve(handler(u, init))
    },
  }
}

/**
 * @param {number} status
 * @param {unknown} body
 * @returns {Response}
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Forge a JWT for tests — we use the real `signJwt` rather than hand-rolling
 * base64 because the IdentityClient must decode the `sub` claim.
 *
 * @param {{ gatewayId: string, ttlSeconds: number, now?: () => number }} args
 * @returns {string}
 */
function jwt(args) {
  return signJwt({ gatewayId: args.gatewayId, ttlSeconds: args.ttlSeconds, secret: SECRET, now: args.now })
}

/**
 * Build a `CentralServerConfig` for tests with sensible defaults.
 *
 * @param {Partial<{ url: string, bootstrap_token?: string, persisted_path?: string }>} overrides
 * @returns {CentralServerConfig}
 */
function centralConfig(overrides = {}) {
  return {
    url: overrides.url ?? 'https://central.example/',
    identity: {
      bootstrap_token: overrides.bootstrap_token,
      persisted_path: overrides.persisted_path,
    },
  }
}

describe('IdentityClient.bootstrap', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let persistedPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-gw-id-'))
    persistedPath = path.join(dir, 'identity.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('exchanges the bootstrap token for a JWT and persists with mode 0600', async () => {
    const clock = fakeClock(1_700_000_000_000)
    const ttl = 30 * 24 * 60 * 60
    const issuedJwt = jwt({ gatewayId: 'gw-99', ttlSeconds: ttl, now: clock.now })
    const expiresAt = Math.floor(clock.now() / 1000) + ttl

    const { fetchFn, calls } = stubFetch([
      () => jsonResponse(200, { jwt: issuedJwt, expires_at: expiresAt }),
    ])

    const client = new IdentityClient(
      centralConfig({ bootstrap_token: 'btok-test', persisted_path: persistedPath }),
      { now: clock.now, fetchFn }
    )
    await client.bootstrap()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://central.example/v1/identity/bootstrap')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.headers).toMatchObject({ 'content-type': 'application/json' })
    const body = /** @type {string} */ (calls[0].init?.body)
    expect(JSON.parse(body)).toEqual({ bootstrap_token: 'btok-test' })

    // The persisted file lives at the requested path with mode 0600.
    const stat = fs.statSync(persistedPath)
    expect(stat.mode & 0o777).toBe(0o600)

    /** @type {PersistedIdentity} */
    const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf8'))
    expect(persisted.jwt).toBe(issuedJwt)
    expect(persisted.expires_at).toBe(expiresAt)
    expect(persisted.gateway_id).toBe('gw-99')
  })

  it('creates the parent directory if it does not yet exist', async () => {
    // Persisted path under a nested directory the operator has not pre-created.
    const nested = path.join(dir, 'a', 'b', 'identity.json')
    const clock = fakeClock(1_700_000_000_000)
    const issuedJwt = jwt({ gatewayId: 'gw-1', ttlSeconds: 60, now: clock.now })
    const { fetchFn } = stubFetch([
      () => jsonResponse(200, { jwt: issuedJwt, expires_at: Math.floor(clock.now() / 1000) + 60 }),
    ])
    const client = new IdentityClient(
      centralConfig({ bootstrap_token: 'tok', persisted_path: nested }),
      { now: clock.now, fetchFn }
    )
    await client.bootstrap()
    expect(fs.existsSync(nested)).toBe(true)
  })

  it('throws "identity bootstrap failed: ..." when the server rejects the token', async () => {
    const { fetchFn } = stubFetch([
      () => jsonResponse(401, { error: 'invalid bootstrap token', reason: 'already_used' }),
    ])
    const client = new IdentityClient(
      centralConfig({ bootstrap_token: 'used', persisted_path: persistedPath }),
      { fetchFn }
    )
    await expect(client.bootstrap()).rejects.toThrow(
      /identity bootstrap failed: 401 invalid bootstrap token \(already_used\)/
    )
    expect(fs.existsSync(persistedPath)).toBe(false)
  })

  it('throws "failed to reach central server ..." when the network is down', async () => {
    const { fetchFn } = stubFetch([
      () => { throw new Error('ECONNREFUSED 127.0.0.1:443') },
    ])
    const client = new IdentityClient(
      centralConfig({
        url: 'https://central.example',
        bootstrap_token: 'tok',
        persisted_path: persistedPath,
      }),
      { fetchFn }
    )
    await expect(client.bootstrap()).rejects.toThrow(
      /failed to reach central server https:\/\/central\.example: ECONNREFUSED 127\.0\.0\.1:443/
    )
    expect(fs.existsSync(persistedPath)).toBe(false)
  })

  it('rejects when bootstrap_token is missing from config', async () => {
    const { fetchFn } = stubFetch([])
    const client = new IdentityClient(
      centralConfig({ persisted_path: persistedPath }),
      { fetchFn }
    )
    await expect(client.bootstrap()).rejects.toThrow(
      /identity bootstrap failed:.*bootstrap_token is not set/
    )
  })

  it('rejects malformed server responses', async () => {
    const { fetchFn } = stubFetch([
      () => jsonResponse(200, { jwt: '', expires_at: 0 }),
    ])
    const client = new IdentityClient(
      centralConfig({ bootstrap_token: 'tok', persisted_path: persistedPath }),
      { fetchFn }
    )
    await expect(client.bootstrap()).rejects.toThrow(/missing jwt/)
  })
})

describe('IdentityClient.acquire — startup flow', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let persistedPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-gw-id-'))
    persistedPath = path.join(dir, 'identity.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns "bootstrapped" when no persisted file exists', async () => {
    const clock = fakeClock(1_700_000_000_000)
    const issuedJwt = jwt({ gatewayId: 'gw-x', ttlSeconds: 60, now: clock.now })
    const { fetchFn, calls } = stubFetch([
      () => jsonResponse(200, { jwt: issuedJwt, expires_at: Math.floor(clock.now() / 1000) + 60 }),
    ])
    const client = new IdentityClient(
      centralConfig({ bootstrap_token: 'tok', persisted_path: persistedPath }),
      { now: clock.now, fetchFn }
    )
    expect(await client.acquire()).toBe('bootstrapped')
    expect(calls).toHaveLength(1)
  })

  it('returns "loaded" and makes no network call when persisted JWT is healthy', async () => {
    // Persist a JWT whose remaining lifetime is well outside the 24h refresh
    // window — no refresh required.
    const clock = fakeClock(1_700_000_000_000)
    const farFutureSec = Math.floor(clock.now() / 1000) + REFRESH_WINDOW_SECONDS + 60 * 60
    const persisted = {
      jwt: jwt({ gatewayId: 'gw-loaded', ttlSeconds: REFRESH_WINDOW_SECONDS + 60 * 60, now: clock.now }),
      expires_at: farFutureSec,
      gateway_id: 'gw-loaded',
    }
    fs.writeFileSync(persistedPath, JSON.stringify(persisted), { mode: 0o600 })

    const { fetchFn, calls } = stubFetch([])
    const client = new IdentityClient(
      centralConfig({ bootstrap_token: 'unused', persisted_path: persistedPath }),
      { now: clock.now, fetchFn }
    )
    expect(await client.acquire()).toBe('loaded')
    expect(calls).toHaveLength(0)
    expect(client.identity?.gateway_id).toBe('gw-loaded')
  })

  it('returns "refreshed" when persisted JWT is within the 24h refresh window', async () => {
    const clock = fakeClock(1_700_000_000_000)
    // Existing JWT: expires in 12h (inside the 24h window).
    const oldExp = Math.floor(clock.now() / 1000) + 12 * 60 * 60
    const oldJwt = jwt({ gatewayId: 'gw-aged', ttlSeconds: 12 * 60 * 60, now: clock.now })
    fs.writeFileSync(persistedPath, JSON.stringify({
      jwt: oldJwt,
      expires_at: oldExp,
      gateway_id: 'gw-aged',
    }))

    // Refresh response.
    const newJwt = jwt({ gatewayId: 'gw-aged', ttlSeconds: 30 * 24 * 60 * 60, now: clock.now })
    const newExp = Math.floor(clock.now() / 1000) + 30 * 24 * 60 * 60
    const { fetchFn, calls } = stubFetch([
      (url, init) => {
        // Refresh request must carry the OLD JWT as bearer.
        const auth = readHeader(init, 'authorization')
        expect(auth).toBe(`Bearer ${oldJwt}`)
        expect(url).toBe('https://central.example/v1/identity/refresh')
        return jsonResponse(200, { jwt: newJwt, expires_at: newExp })
      },
    ])

    const client = new IdentityClient(
      centralConfig({ bootstrap_token: 'unused', persisted_path: persistedPath }),
      { now: clock.now, fetchFn }
    )
    expect(await client.acquire()).toBe('refreshed')
    expect(calls).toHaveLength(1)
    expect(client.identity?.jwt).toBe(newJwt)
    expect(client.identity?.expires_at).toBe(newExp)

    // The refreshed JWT must be on disk for the next start.
    const onDisk = JSON.parse(fs.readFileSync(persistedPath, 'utf8'))
    expect(onDisk.jwt).toBe(newJwt)
    expect(onDisk.expires_at).toBe(newExp)
    expect(onDisk.gateway_id).toBe('gw-aged')
  })

  it('rejects a malformed persisted file rather than silently re-bootstrapping', async () => {
    fs.writeFileSync(persistedPath, '{"not_an_identity": true}')
    const { fetchFn, calls } = stubFetch([])
    const client = new IdentityClient(
      centralConfig({ bootstrap_token: 'tok', persisted_path: persistedPath }),
      { fetchFn }
    )
    await expect(client.acquire()).rejects.toThrow(/missing or invalid jwt/)
    // Crucially: bootstrap_token was NOT spent.
    expect(calls).toHaveLength(0)
  })
})

describe('IdentityClient.refresh', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let persistedPath
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-gw-id-'))
    persistedPath = path.join(dir, 'identity.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('coalesces concurrent refresh calls into a single network request', async () => {
    const clock = fakeClock(1_700_000_000_000)
    const oldJwt = jwt({ gatewayId: 'gw-1', ttlSeconds: 60, now: clock.now })
    fs.writeFileSync(persistedPath, JSON.stringify({
      jwt: oldJwt,
      expires_at: Math.floor(clock.now() / 1000) + 60,
      gateway_id: 'gw-1',
    }))

    let inflight = 0
    let maxInflight = 0
    const newJwt = jwt({ gatewayId: 'gw-1', ttlSeconds: 60_000, now: clock.now })
    const { fetchFn } = stubFetch([
      async () => {
        inflight++
        if (inflight > maxInflight) maxInflight = inflight
        // Yield so concurrent callers can pile in if coalescing is broken.
        await new Promise((r) => setTimeout(r, 0))
        inflight--
        return jsonResponse(200, { jwt: newJwt, expires_at: Math.floor(clock.now() / 1000) + 60_000 })
      },
    ])

    const client = new IdentityClient(
      centralConfig({ bootstrap_token: 'unused', persisted_path: persistedPath }),
      { now: clock.now, fetchFn }
    )
    client.loadPersisted()
    await Promise.all([client.refresh(), client.refresh(), client.refresh()])
    expect(maxInflight).toBe(1)
    expect(client.identity?.jwt).toBe(newJwt)
  })

  it('throws "identity refresh failed: ..." on server rejection', async () => {
    const clock = fakeClock(1_700_000_000_000)
    const oldJwt = jwt({ gatewayId: 'gw-1', ttlSeconds: 60, now: clock.now })
    fs.writeFileSync(persistedPath, JSON.stringify({
      jwt: oldJwt,
      expires_at: Math.floor(clock.now() / 1000) + 60,
      gateway_id: 'gw-1',
    }))
    const { fetchFn } = stubFetch([
      () => jsonResponse(401, { error: 'unauthorized' }),
    ])
    const client = new IdentityClient(
      centralConfig({ persisted_path: persistedPath }),
      { now: clock.now, fetchFn }
    )
    client.loadPersisted()
    await expect(client.refresh()).rejects.toThrow(/identity refresh failed: 401 unauthorized/)
  })
})

describe('IdentityClient.getCurrentJwt', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let persistedPath
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-gw-id-'))
    persistedPath = path.join(dir, 'identity.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns the cached JWT without a network call when it is healthy', async () => {
    const clock = fakeClock(1_700_000_000_000)
    const ttl = REFRESH_WINDOW_SECONDS + 60 * 60
    const issuedJwt = jwt({ gatewayId: 'gw-ok', ttlSeconds: ttl, now: clock.now })
    fs.writeFileSync(persistedPath, JSON.stringify({
      jwt: issuedJwt,
      expires_at: Math.floor(clock.now() / 1000) + ttl,
      gateway_id: 'gw-ok',
    }))
    const { fetchFn, calls } = stubFetch([])
    const client = new IdentityClient(
      centralConfig({ persisted_path: persistedPath }),
      { now: clock.now, fetchFn }
    )
    client.loadPersisted()
    expect(await client.getCurrentJwt()).toBe(issuedJwt)
    expect(await client.getCurrentJwt()).toBe(issuedJwt)
    expect(calls).toHaveLength(0)
  })

  it('lazily refreshes when the cached JWT enters the refresh window', async () => {
    const clock = fakeClock(1_700_000_000_000)
    // Healthy: 48h to live (outside 24h window).
    const oldTtl = 48 * 60 * 60
    const oldJwt = jwt({ gatewayId: 'gw', ttlSeconds: oldTtl, now: clock.now })
    fs.writeFileSync(persistedPath, JSON.stringify({
      jwt: oldJwt,
      expires_at: Math.floor(clock.now() / 1000) + oldTtl,
      gateway_id: 'gw',
    }))

    const newJwt = jwt({ gatewayId: 'gw', ttlSeconds: 30 * 24 * 60 * 60, now: clock.now })
    const { fetchFn, calls } = stubFetch([
      () => jsonResponse(200, {
        jwt: newJwt,
        expires_at: Math.floor(clock.now() / 1000) + 30 * 24 * 60 * 60,
      }),
    ])
    const client = new IdentityClient(
      centralConfig({ persisted_path: persistedPath }),
      { now: clock.now, fetchFn }
    )
    client.loadPersisted()
    // First call: cached, no network.
    expect(await client.getCurrentJwt()).toBe(oldJwt)
    expect(calls).toHaveLength(0)

    // Advance 25h — now inside the refresh window.
    clock.advance(25 * 60 * 60 * 1000)
    expect(await client.getCurrentJwt()).toBe(newJwt)
    expect(calls).toHaveLength(1)
  })

  it('throws when called before identity is acquired', async () => {
    const { fetchFn } = stubFetch([])
    const client = new IdentityClient(
      centralConfig({ persisted_path: persistedPath }),
      { fetchFn }
    )
    await expect(client.getCurrentJwt()).rejects.toThrow(/identity not acquired/)
  })
})

describe('IdentityClient construction', () => {
  it('throws when central_server.url is missing', () => {
    expect(() => new IdentityClient(/** @type {any} */ ({ identity: {} }))).toThrow(
      /central_server\.url is required/
    )
  })

  it('falls back to ~/.hyp/collectivus/identity.json when persisted_path is omitted', () => {
    const client = new IdentityClient(centralConfig())
    expect(client.persistedPath).toBe(
      path.join(os.homedir(), '.hyp', 'collectivus', 'identity.json')
    )
  })
})

/**
 * Read a header from a `RequestInit` regardless of whether it was passed as a
 * plain object, an array of pairs, or a Headers instance — the IdentityClient
 * only uses the plain-object form, but tests should not depend on that detail.
 *
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
  const map = /** @type {Record<string, string>} */ headers
  return map[name] ?? map[name.toLowerCase()] ?? map[name.toUpperCase()]
}
