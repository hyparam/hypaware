import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../../src/cli.js'
import { sha256Hex } from '../../src/rendezvous/store.js'
import { createConfigRegistry, deleteConfig, setConfig } from '../../src/server/config_registry.js'
import { ControlPlane } from '../../src/server/control_plane.js'
import { createEnrollmentStore, registerEnrollment } from '../../src/server/enrollment.js'
import { BootstrapStore, signJwt, verifyJwt } from '../../src/server/identity.js'

/**
 * @import { CollectivusConfig, ServerConfig } from '../../src/types.js'
 * @import { ConfigRegistry } from '../../src/server/types.d.ts'
 */

const PLACEHOLDER_SECRET = 'a'.repeat(32)

/** @returns {ServerConfig} */
function serverConfig() {
  return {
    control_plane_listen: '127.0.0.1:0',
    identity_issuer: { secret: PLACEHOLDER_SECRET },
  }
}

/**
 * @param {number} initialMs
 * @returns {{ now: () => number, advance: (ms: number) => void }}
 */
function fakeClock(initialMs) {
  let t = initialMs
  return {
    now: () => t,
    advance: (ms) => { t += ms },
  }
}

function memo() {
  let buf = ''
  return {
    write(/** @type {string} */ s) { buf += s },
    value() { return buf },
  }
}

function noop() {}

/**
 * @returns {CollectivusConfig}
 */
function gatewayCfg() {
  return {
    version: 1,
    role: 'gateway',
    central_server: {
      url: 'https://control.example.com',
      identity: {},
    },
  }
}

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('ControlPlane class', () => {
  /** @type {ControlPlane} */
  let plane
  /** @type {string} */
  let baseUrl

  beforeEach(async () => {
    plane = new ControlPlane(serverConfig())
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await plane.stop()
  })

  it('binds the listener and exposes the assigned port via .server', () => {
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    expect(addr.port).toBeGreaterThan(0)
    expect(addr.address).toBe('127.0.0.1')
  })

  describe('GET /health (no auth)', () => {
    it('returns 200 with status and version', async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      // version comes from package.json — assert shape, not the exact value.
      expect(typeof body.version).toBe('string')
      expect(body.version.length).toBeGreaterThan(0)
    })

    it('does not require an Authorization header', async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
    })

    it('returns 405 on non-GET methods', async () => {
      const res = await fetch(`${baseUrl}/health`, { method: 'POST' })
      expect(res.status).toBe(405)
    })
  })

  describe('POST /v1/identity/bootstrap (no auth)', () => {
    it('returns 503 when no bootstrap store is configured (no body required)', async () => {
      // The default test config omits bootstrap_store_path, so the bootstrap
      // endpoint is intentionally disabled — refresh and ordinary auth still
      // work. handleBootstrap rejects before parsing the body, so an empty
      // POST reaches the 503 branch instead of "empty request body".
      const res = await fetch(`${baseUrl}/v1/identity/bootstrap`, { method: 'POST' })
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('bootstrap not provisioned')
    })

    it('returns 405 on non-POST methods', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/bootstrap`)
      expect(res.status).toBe(405)
    })
  })

  describe('POST /v1/identity/refresh (auth required)', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/refresh`, { method: 'POST' })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
    })

    it('returns 401 when Authorization is not a Bearer scheme', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
        method: 'POST',
        headers: { authorization: 'Basic abcdef' },
      })
      expect(res.status).toBe(401)
    })

    it('returns 401 when Bearer token is empty', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
        method: 'POST',
        headers: { authorization: 'Bearer    ' },
      })
      expect(res.status).toBe(401)
    })

    it('returns 401 when Bearer token is not a valid JWT', async () => {
      // A.3 verifies the JWT — a non-JWT bearer string can no longer reach
      // the handler. Detailed JWT-shape coverage lives in auth.test.js.
      const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
        method: 'POST',
        headers: { authorization: 'Bearer placeholder-token' },
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
    })

    it('returns 405 on non-POST methods', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/refresh`)
      expect(res.status).toBe(405)
    })
  })

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/anything-else`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('not found')
  })

  it('rejects invalid listen addresses at construction', () => {
    expect(() => new ControlPlane({
      control_plane_listen: 'not-a-host-port',
      identity_issuer: { secret: PLACEHOLDER_SECRET },
    })).toThrow(/invalid listen address/)
  })

  it('stop() is idempotent — calling twice does not reject', async () => {
    await plane.stop()
    await plane.stop()
  })
})

describe('Identity flow end-to-end (HTTP)', () => {
  /** @type {string} */
  let dir
  /** @type {ControlPlane | undefined} */
  let plane
  /** @type {string} */
  let baseUrl

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cp-id-'))
  })
  afterEach(async () => {
    if (plane) await plane.stop()
    plane = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Spin up a control plane backed by a real BootstrapStore at `dir`.
   *
   * @param {{ clock?: { now: () => number }, publicUrl?: string }} [opts]
   * @returns {Promise<{ store: BootstrapStore, plane: ControlPlane, registry: ConfigRegistry }>}
   */
  async function bootPlane(opts = {}) {
    const storePath = path.join(dir, 'bootstrap.json')
    const store = new BootstrapStore({ path: storePath, now: opts.clock?.now })
    const registry = createConfigRegistry({ configsDir: path.join(dir, 'configs') })
    /** @type {ServerConfig} */
    const cfg = {
      control_plane_listen: '127.0.0.1:0',
      identity_issuer: { secret: PLACEHOLDER_SECRET, bootstrap_store_path: storePath },
    }
    if (opts.publicUrl) cfg.public_url = opts.publicUrl
    plane = new ControlPlane(
      cfg,
      { bootstrapStore: store, now: opts.clock?.now, configRegistry: registry }
    )
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    baseUrl = `http://127.0.0.1:${addr.port}`
    return { store, plane, registry }
  }

  it('exchanges a bootstrap token for a usable JWT exactly once', async () => {
    const { store } = await bootPlane()
    const { token } = store.register({ gatewayId: 'gw-1', ttlSeconds: 60 })

    const ok = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: token }),
    })
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(typeof body.jwt).toBe('string')
    expect(typeof body.expires_at).toBe('number')

    const verified = verifyJwt(body.jwt, PLACEHOLDER_SECRET)
    expect(verified.valid).toBe(true)
    if (!verified.valid) throw new Error('unreachable')
    expect(verified.claims.sub).toBe('gw-1')

    // Replay must fail with 401.
    const replay = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: token }),
    })
    expect(replay.status).toBe(401)
  })

  it('rejects bootstrap requests with a missing/invalid body', async () => {
    await bootPlane()
    const empty = await fetch(`${baseUrl}/v1/identity/bootstrap`, { method: 'POST' })
    expect(empty.status).toBe(400)

    const bad = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(bad.status).toBe(400)

    const wrongShape = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wrong: 'field' }),
    })
    expect(wrongShape.status).toBe(400)
  })

  it('rejects unknown bootstrap tokens with 401', async () => {
    await bootPlane()
    const res = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: 'not-a-real-token' }),
    })
    expect(res.status).toBe(401)
  })

  it('refresh issues a new JWT for an authenticated gateway', async () => {
    const { registry } = await bootPlane()
    setConfig(registry, 'gw-7', gatewayCfg())
    const jwt = signJwt({ gatewayId: 'gw-7', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })
    const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.jwt).toBe('string')
    expect(body.jwt).not.toBe(jwt)
    const verified = verifyJwt(body.jwt, PLACEHOLDER_SECRET)
    expect(verified.valid).toBe(true)
    if (!verified.valid) throw new Error('unreachable')
    expect(verified.claims.sub).toBe('gw-7')
  })

  it('rejects refresh after the gateway config is deleted', async () => {
    const { registry } = await bootPlane()
    setConfig(registry, 'gw-offboarded', gatewayCfg())
    const jwt = signJwt({ gatewayId: 'gw-offboarded', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })
    expect(deleteConfig(registry, 'gw-offboarded')).toBe(true)

    const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: 'unauthorized',
      reason: 'no config registered for this gateway',
    })
  })

  it('rejects refresh with an expired JWT', async () => {
    const clock = fakeClock(1_700_000_000_000)
    const { registry } = await bootPlane({ clock })
    setConfig(registry, 'gw', gatewayCfg())
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: PLACEHOLDER_SECRET, now: clock.now })
    clock.advance(61_000)
    const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(401)
  })

  it('rate-limits bootstrap to 5 requests/min/IP', async () => {
    const clock = fakeClock(1_700_000_000_000)
    await bootPlane({ clock })
    // 5 requests with bogus tokens — each is 401 but counts toward the limit.
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap_token: 'nope' }),
      })
      expect(r.status).toBe(401)
    }
    // The 6th in the same window must be 429.
    const limited = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: 'nope' }),
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
  })

  it('rate-limits refresh to 1 request/min/gateway', async () => {
    const clock = fakeClock(1_700_000_000_000)
    const { registry } = await bootPlane({ clock })
    setConfig(registry, 'gw', gatewayCfg())
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 600, secret: PLACEHOLDER_SECRET, now: clock.now })
    const first = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(first.status).toBe(200)

    const second = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(second.status).toBe(429)

    // Move the clock past the window — refresh works again.
    clock.advance(60_001)
    const third = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(third.status).toBe(200)
  })

  it('rejects bootstrap bodies larger than 4KiB', async () => {
    await bootPlane()
    const big = 'x'.repeat(5 * 1024)
    const res = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: big }),
    })
    expect(res.status).toBe(413)
  })

  describe('GET /v1/bootstrap-config (no auth)', () => {
    it('returns a gateway starter config for a setup URL without consuming the token', async () => {
      const { store } = await bootPlane({ publicUrl: 'https://collectivus.example.com' })
      const { token } = store.register({ gatewayId: 'gw-setup', ttlSeconds: 60 })

      const res = await fetch(`${baseUrl}/v1/bootstrap-config?token=${token}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = await res.json()
      expect(body).toEqual({
        version: 1,
        role: 'gateway',
        central_server: {
          url: 'https://collectivus.example.com',
          identity: { bootstrap_token: token },
        },
      })

      const bootstrap = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap_token: token }),
      })
      expect(bootstrap.status).toBe(200)
      const bootstrapBody = await bootstrap.json()
      const verified = verifyJwt(bootstrapBody.jwt, PLACEHOLDER_SECRET)
      expect(verified.valid).toBe(true)
      if (!verified.valid) throw new Error('unreachable')
      expect(verified.claims.sub).toBe('gw-setup')
    })

    it('returns the registered gateway config with the bootstrap token overlaid', async () => {
      const { store, registry } = await bootPlane({ publicUrl: 'https://collectivus.example.com' })
      const { token } = store.register({ gatewayId: 'gw-configured', ttlSeconds: 60 })
      setConfig(registry, 'gw-configured', {
        version: 1,
        role: 'gateway',
        otel: { listen: '127.0.0.1:4318' },
        proxy: {
          listen: '127.0.0.1:8787',
          upstreams: [{
            name: 'anthropic',
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          }],
        },
        central_server: {
          url: 'https://collectivus.example.com',
          identity: { persisted_path: '/tmp/gw-configured-identity.json' },
        },
      })

      const res = await fetch(`${baseUrl}/v1/bootstrap-config?token=${token}`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        version: 1,
        role: 'gateway',
        otel: { listen: '127.0.0.1:4318' },
        proxy: {
          listen: '127.0.0.1:8787',
          upstreams: [{
            name: 'anthropic',
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          }],
        },
        central_server: {
          url: 'https://collectivus.example.com',
          identity: {
            persisted_path: '/tmp/gw-configured-identity.json',
            bootstrap_token: token,
          },
        },
      })

      const bootstrap = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap_token: token }),
      })
      expect(bootstrap.status).toBe(200)
    })

    it('rejects missing and unknown setup tokens', async () => {
      await bootPlane()
      const missing = await fetch(`${baseUrl}/v1/bootstrap-config`)
      expect(missing.status).toBe(400)

      const unknown = await fetch(`${baseUrl}/v1/bootstrap-config?token=${'a'.repeat(64)}`)
      expect(unknown.status).toBe(401)
      const body = await unknown.json()
      expect(body.error).toBe('invalid bootstrap token')
    })
  })

  describe('POST /v1/enrollments/bootstrap-config (no auth)', () => {
    it('mints per-use bootstrap tokens and enforces max uses', async () => {
      const clock = fakeClock(Date.parse('2026-05-11T12:00:00.000Z'))
      await bootPlane({ clock, publicUrl: 'https://collectivus.example.com' })
      const enrollmentStore = createEnrollmentStore({ path: path.join(dir, 'enrollments.json'), now: clock.now })
      const joinCode = 'ACME7K9Q2P'
      registerEnrollment(enrollmentStore, {
        joinCodeHash: sha256Hex(joinCode),
        gatewayId: 'acme-user',
        ttlSeconds: 60,
        maxUses: 2,
      })
      if (!plane) throw new Error('plane missing')
      plane.enrollmentStore = enrollmentStore

      const first = await fetch(`${baseUrl}/v1/enrollments/bootstrap-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ join_code: joinCode }),
      })
      expect(first.status).toBe(200)
      const firstBody = await first.json()
      expect(firstBody.gateway_id).toBe('acme-user-1')
      expect(firstBody.config.central_server.identity.bootstrap_token).toMatch(/^[0-9a-f]{64}$/)

      const second = await fetch(`${baseUrl}/v1/enrollments/bootstrap-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ join_code: joinCode }),
      })
      expect(second.status).toBe(200)
      const secondBody = await second.json()
      expect(secondBody.gateway_id).toBe('acme-user-2')

      const exhausted = await fetch(`${baseUrl}/v1/enrollments/bootstrap-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ join_code: joinCode }),
      })
      expect(exhausted.status).toBe(409)
    })

    it('rejects expired enrollment keys', async () => {
      const clock = fakeClock(Date.parse('2026-05-11T12:00:00.000Z'))
      await bootPlane({ clock })
      const enrollmentStore = createEnrollmentStore({ path: path.join(dir, 'enrollments.json'), now: clock.now })
      const joinCode = 'ACMEEXPIRE'
      registerEnrollment(enrollmentStore, {
        joinCodeHash: sha256Hex(joinCode),
        gatewayId: 'acme-expire',
        ttlSeconds: 1,
        maxUses: 1,
      })
      if (!plane) throw new Error('plane missing')
      plane.enrollmentStore = enrollmentStore
      clock.advance(1000)

      const expired = await fetch(`${baseUrl}/v1/enrollments/bootstrap-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ join_code: joinCode }),
      })
      expect(expired.status).toBe(410)
    })
  })
})

describe('GET /v1/config (auth required)', () => {
  /** @type {string} */
  let dir
  /** @type {ControlPlane | undefined} */
  let plane
  /** @type {string} */
  let baseUrl
  /** @type {ConfigRegistry} */
  let registry

  /**
   * @param {{ url?: string }} [opts]
   * @returns {CollectivusConfig}
   */
  function gatewayCfg(opts = {}) {
    return {
      version: 1,
      role: 'gateway',
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: '/tmp/cfg-vending-test-sink' },
      central_server: {
        url: opts.url ?? 'https://control.example.com:8788',
        identity: {
          bootstrap_token: 'placeholder-bootstrap-token',
        },
      },
    }
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cp-cfg-'))
    registry = createConfigRegistry({ configsDir: path.join(dir, 'configs') })
    plane = new ControlPlane(serverConfig(), { configRegistry: registry })
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    if (plane) await plane.stop()
    plane = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns 401 when Authorization header is missing', async () => {
    const res = await fetch(`${baseUrl}/v1/config`)
    expect(res.status).toBe(401)
  })

  it('returns 405 on non-GET methods', async () => {
    const res = await fetch(`${baseUrl}/v1/config`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  it('returns 404 when no config is registered for the JWT subject', async () => {
    const jwt = signJwt({ gatewayId: 'gw-unregistered', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })
    const res = await fetch(`${baseUrl}/v1/config`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/no config registered/)
  })

  it('returns 200 + JSON body + ETag on a fresh fetch', async () => {
    const cfg = gatewayCfg({ url: 'https://gw-a.example.com' })
    setConfig(registry, 'gw-a', cfg)
    const jwt = signJwt({ gatewayId: 'gw-a', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })

    const res = await fetch(`${baseUrl}/v1/config`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(200)
    const etag = res.headers.get('etag')
    expect(etag).toMatch(/^[0-9a-f]{64}$/)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = await res.json()
    expect(body).toEqual(cfg)
  })

  it('returns 304 with empty body when If-None-Match matches the current ETag', async () => {
    setConfig(registry, 'gw-a', gatewayCfg())
    const jwt = signJwt({ gatewayId: 'gw-a', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })

    const first = await fetch(`${baseUrl}/v1/config`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    if (!etag) throw new Error('expected etag')
    await first.text()

    const second = await fetch(`${baseUrl}/v1/config`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        'if-none-match': etag,
      },
    })
    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
    const body = await second.text()
    expect(body).toBe('')
  })

  it('returns 200 + new body when the stored config has changed since the cached ETag', async () => {
    setConfig(registry, 'gw-a', gatewayCfg({ url: 'https://old.example.com' }))
    const jwt = signJwt({ gatewayId: 'gw-a', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })

    const first = await fetch(`${baseUrl}/v1/config`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    const oldEtag = first.headers.get('etag')
    if (!oldEtag) throw new Error('expected etag')
    await first.text()

    // Operator updates the config out-of-band.
    setConfig(registry, 'gw-a', gatewayCfg({ url: 'https://new.example.com' }))

    const second = await fetch(`${baseUrl}/v1/config`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        'if-none-match': oldEtag,
      },
    })
    expect(second.status).toBe(200)
    const newEtag = second.headers.get('etag')
    expect(newEtag).not.toBe(oldEtag)
    const body = await second.json()
    expect(body.central_server.url).toBe('https://new.example.com')
  })

  it('returns 200 with a stale (different) ETag rather than treating it as no-match', async () => {
    setConfig(registry, 'gw-a', gatewayCfg())
    const jwt = signJwt({ gatewayId: 'gw-a', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })

    const res = await fetch(`${baseUrl}/v1/config`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        'if-none-match': '0000000000000000000000000000000000000000000000000000000000000000',
      },
    })
    expect(res.status).toBe(200)
  })

  it('honors the wildcard If-None-Match: *', async () => {
    setConfig(registry, 'gw-a', gatewayCfg())
    const jwt = signJwt({ gatewayId: 'gw-a', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })

    const res = await fetch(`${baseUrl}/v1/config`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        'if-none-match': '*',
      },
    })
    expect(res.status).toBe(304)
  })

  it('accepts a quoted ETag in If-None-Match (RFC 7232 wrapping)', async () => {
    setConfig(registry, 'gw-a', gatewayCfg())
    const jwt = signJwt({ gatewayId: 'gw-a', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })

    const first = await fetch(`${baseUrl}/v1/config`, {
      headers: { authorization: `Bearer ${jwt}` },
    })
    const etag = first.headers.get('etag')
    if (!etag) throw new Error('expected etag')
    await first.text()

    const second = await fetch(`${baseUrl}/v1/config`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        'if-none-match': `"${etag}"`,
      },
    })
    expect(second.status).toBe(304)
  })

  it('serves the JWT subject\'s config and never another gateway\'s by query/path', async () => {
    // Two gateways with distinct configs registered.
    setConfig(registry, 'gw-a', gatewayCfg({ url: 'https://a.example.com' }))
    setConfig(registry, 'gw-b', gatewayCfg({ url: 'https://b.example.com' }))

    // Gateway A's JWT.
    const jwtA = signJwt({ gatewayId: 'gw-a', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })

    // Even with an attacker-controlled query string naming gw-b, the server
    // must derive the gateway from the JWT — gw-a's config comes back.
    const res = await fetch(`${baseUrl}/v1/config?gateway_id=gw-b`, {
      headers: { authorization: `Bearer ${jwtA}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.central_server.url).toBe('https://a.example.com')
  })

  it('returns 401 when the bearer JWT is signed by a different secret', async () => {
    setConfig(registry, 'gw-a', gatewayCfg())
    const wrongJwt = signJwt({ gatewayId: 'gw-a', ttlSeconds: 60, secret: 'b'.repeat(32) })
    const res = await fetch(`${baseUrl}/v1/config`, {
      headers: { authorization: `Bearer ${wrongJwt}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('CLI lifecycle wiring', () => {
  /** @type {string} */
  let tmpDir
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cp-cli-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * @param {object} cfg
   * @returns {string}
   */
  function writeConfig(cfg) {
    const p = path.join(tmpDir, 'config.json')
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
    return p
  }

  it('role: server starts the control-plane listener and exits cleanly on shutdown', async () => {
    const cfgPath = writeConfig({
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '127.0.0.1:0',
        identity_issuer: { secret: PLACEHOLDER_SECRET },
      },
    })
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('Control-plane listener bound'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stdout.value()).toMatch(/Control-plane listener bound on 127\.0\.0\.1:\d+/)
    expect(stdout.value()).toMatch(/Received SIGTERM/)
    expect(stdout.value()).toMatch(/Shutdown complete/)
  })

  it('role: server resolves identity_issuer.secret_env before binding', async () => {
    const cfgPath = writeConfig({
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '127.0.0.1:0',
        identity_issuer: { secret_env: 'COLLECTIVUS_IDENTITY_ISSUER_SECRET' },
      },
    })
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], { COLLECTIVUS_IDENTITY_ISSUER_SECRET: PLACEHOLDER_SECRET }, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('Control-plane listener bound'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stderr.value()).not.toMatch(/secret_env/)
  })

  it('role: server starts the parquet drain over the ingest sink_dir when upload is configured', async () => {
    // Server-mode upload drains the multi-tenant ingest spool — sink_dir is
    // independent of `config.sink` (which standalone uses). The catch-up tick
    // walks gateway_id/signal partitions; an empty sink_dir means no jobs and
    // no S3 traffic, which is what we want for a startup smoke test.
    const sinkDir = path.join(tmpDir, 'ingested')
    fs.mkdirSync(sinkDir, { recursive: true })
    const cfgPath = writeConfig({
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '127.0.0.1:0',
        identity_issuer: { secret: PLACEHOLDER_SECRET },
        sink_dir: sinkDir,
      },
      upload: { bucket: 'b', prefix: 'collectivus', time: '03:14' },
    })
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const env = { AWS_ACCESS_KEY_ID: 'test-id', AWS_SECRET_ACCESS_KEY: 'test-secret' }
    const result = run(['--config', cfgPath], env, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('Uploader scheduled'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    // Both listeners came up.
    expect(stdout.value()).toMatch(/Control-plane listener bound on 127\.0\.0\.1:\d+/)
    expect(stdout.value()).toMatch(/Uploader scheduled for 03:14 UTC, target s3:\/\/b\/collectivus/)
    // No "sink missing" error — server-mode upload does NOT require config.sink.
    expect(stderr.value()).not.toMatch(/upload is configured but sink is missing/)
  })

  it('role: standalone does NOT start the control-plane listener', async () => {
    const cfgPath = writeConfig({
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
    })
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('OTLP listener bound'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stdout.value()).not.toMatch(/Control-plane listener bound/)
  })

  it('role: gateway does NOT start the control-plane listener', async () => {
    // Gateway needs at least one bound listener (otel/proxy) — A.4 wires the
    // gateway-side bootstrap client. Pre-seed a healthy persisted identity so
    // `acquire()` takes the offline `loaded` path and the test never hits the
    // network; we just want to verify the control-plane is NOT bound here.
    const persistedPath = path.join(tmpDir, 'identity.json')
    fs.writeFileSync(persistedPath, JSON.stringify({
      jwt: signJwt({ gatewayId: 'gw-test', ttlSeconds: 60 * 24 * 60 * 60, secret: PLACEHOLDER_SECRET }),
      expires_at: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
      gateway_id: 'gw-test',
    }))
    const cfgPath = writeConfig({
      version: 1,
      role: 'gateway',
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
      central_server: {
        url: 'http://127.0.0.1:1',
        identity: { bootstrap_token: 'unused', persisted_path: persistedPath },
      },
    })
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('OTLP listener bound'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stdout.value()).not.toMatch(/Control-plane listener bound/)
    expect(stdout.value()).toMatch(/Identity loaded for gw-test/)
  })

  it('role: gateway bootstraps against a live control-plane on first start', async () => {
    // End-to-end: spin up a real server-mode control plane on an ephemeral
    // port, register a bootstrap token in its store, then start a gateway
    // pointed at it. The gateway must exchange the token, persist a JWT, and
    // continue past identity acquisition into normal lifecycle.
    const storePath = path.join(tmpDir, 'bootstrap.json')
    const store = new BootstrapStore({ path: storePath })
    const { token } = store.register({ gatewayId: 'gw-cli', ttlSeconds: 60 })
    const plane = new ControlPlane(
      {
        control_plane_listen: '127.0.0.1:0',
        identity_issuer: { secret: PLACEHOLDER_SECRET, bootstrap_store_path: storePath },
      },
      { bootstrapStore: store }
    )
    await plane.start()
    try {
      const addr = plane.server?.address()
      if (!addr || typeof addr === 'string') throw new Error('no address')
      const persistedPath = path.join(tmpDir, 'identity.json')
      const cfgPath = writeConfig({
        version: 1,
        role: 'gateway',
        otel: { listen: '127.0.0.1:0' },
        sink: { type: 'file', dir: path.join(tmpDir, 'data') },
        central_server: {
          url: `http://127.0.0.1:${addr.port}`,
          identity: { bootstrap_token: token, persisted_path: persistedPath },
        },
      })
      const stdout = memo()
      const stderr = memo()
      /** @type {(signal: string) => void} */
      let trigger = noop
      const result = run(['--config', cfgPath], {}, {
        stdout, stderr,
        onShutdownRequested: (handler) => { trigger = handler },
      })
      await waitFor(() => stdout.value().includes('OTLP listener bound'))
      trigger('SIGTERM')
      expect(await result).toBe(0)
      expect(stdout.value()).toMatch(/Identity bootstrapped for gw-cli/)
      // The persisted file should now exist with mode 0600.
      const stat = fs.statSync(persistedPath)
      expect(stat.mode & 0o777).toBe(0o600)
      const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf8'))
      expect(persisted.gateway_id).toBe('gw-cli')
      // Replaying the same token now must fail (it was consumed).
      const replay = await fetch(`http://127.0.0.1:${addr.port}/v1/identity/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap_token: token }),
      })
      expect(replay.status).toBe(401)
    } finally {
      await plane.stop()
    }
  })

  it('role: gateway can start from --config-endpoint using the registered config', async () => {
    const storePath = path.join(tmpDir, 'bootstrap.json')
    const store = new BootstrapStore({ path: storePath })
    const registry = createConfigRegistry({ configsDir: path.join(tmpDir, 'configs') })
    const plane = new ControlPlane(
      {
        control_plane_listen: '127.0.0.1:0',
        identity_issuer: { secret: PLACEHOLDER_SECRET, bootstrap_store_path: storePath },
      },
      { bootstrapStore: store, configRegistry: registry }
    )
    await plane.start()
    try {
      const addr = plane.server?.address()
      if (!addr || typeof addr === 'string') throw new Error('no address')
      const base = `http://127.0.0.1:${addr.port}`
      const { token } = store.register({ gatewayId: 'gw-one-line', ttlSeconds: 60 })
      setConfig(registry, 'gw-one-line', {
        version: 1,
        role: 'gateway',
        otel: { listen: '127.0.0.1:0' },
        sink: { type: 'file', dir: path.join(tmpDir, 'data') },
        central_server: { url: base, identity: {} },
      })

      const stdout = memo()
      const stderr = memo()
      /** @type {(signal: string) => void} */
      let trigger = noop
      const result = run(['--config-endpoint', `${base}/v1/bootstrap-config?token=${token}`], {}, {
        stdout,
        stderr,
        identityPersistedPath: path.join(tmpDir, 'identity-one-line.json'),
        onShutdownRequested: (handler) => { trigger = handler },
      })
      await waitFor(() => stdout.value().includes('OTLP listener bound'))
      trigger('SIGTERM')
      expect(await result).toBe(0)
      expect(stdout.value()).toMatch(/Identity bootstrapped for gw-one-line/)
      expect(stdout.value()).toMatch(/Config poll loop active/)
      expect(stderr.value()).not.toMatch(/no config registered/)
    } finally {
      await plane.stop()
    }
  })

  it('role: gateway exits 1 with a clear error when the central server is unreachable', async () => {
    // No persisted file + unreachable central server -> "failed to reach
    // central server <url>: <err>" on stderr, exit 1, no listener bound.
    const persistedPath = path.join(tmpDir, 'identity.json')
    const cfgPath = writeConfig({
      version: 1,
      role: 'gateway',
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
      central_server: {
        // Port 1 is reserved + closed — connecting fails fast.
        url: 'http://127.0.0.1:1',
        identity: { bootstrap_token: 'tok', persisted_path: persistedPath },
      },
    })
    const stdout = memo()
    const stderr = memo()
    const code = await run(['--config', cfgPath], {}, { stdout, stderr })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/error: failed to reach central server http:\/\/127\.0\.0\.1:1/)
    expect(stdout.value()).not.toMatch(/OTLP listener bound/)
    expect(fs.existsSync(persistedPath)).toBe(false)
  })

  it('role: gateway exits 1 when the central server rejects the bootstrap token', async () => {
    // Server is up but has no bootstrap store provisioned -> 503.
    const plane = new ControlPlane({
      control_plane_listen: '127.0.0.1:0',
      identity_issuer: { secret: PLACEHOLDER_SECRET },
    })
    await plane.start()
    try {
      const addr = plane.server?.address()
      if (!addr || typeof addr === 'string') throw new Error('no address')
      const persistedPath = path.join(tmpDir, 'identity.json')
      const cfgPath = writeConfig({
        version: 1,
        role: 'gateway',
        otel: { listen: '127.0.0.1:0' },
        sink: { type: 'file', dir: path.join(tmpDir, 'data') },
        central_server: {
          url: `http://127.0.0.1:${addr.port}`,
          identity: { bootstrap_token: 'whatever', persisted_path: persistedPath },
        },
      })
      const stdout = memo()
      const stderr = memo()
      const code = await run(['--config', cfgPath], {}, { stdout, stderr })
      expect(code).toBe(1)
      expect(stderr.value()).toMatch(/error: identity bootstrap failed: 503 bootstrap not provisioned/)
      expect(fs.existsSync(persistedPath)).toBe(false)
    } finally {
      await plane.stop()
    }
  })

  it('drains the control plane via stopAll within DRAIN_TIMEOUT_MS', async () => {
    const cfgPath = writeConfig({
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '127.0.0.1:0',
        identity_issuer: { secret: PLACEHOLDER_SECRET },
      },
    })
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('Control-plane listener bound'))
    const drainStart = Date.now()
    trigger('SIGTERM')
    const code = await result
    const drainMs = Date.now() - drainStart
    expect(code).toBe(0)
    expect(drainMs).toBeLessThan(5000)
    // No drain-timeout warning.
    expect(stderr.value()).not.toMatch(/drain exceeded/)
  })
})

describe('POST /v1/admin/invites (admin auth)', () => {
  const ADMIN_TOKEN = 'A'.repeat(48)
  const RDV_TOKEN = 'r'.repeat(40)
  const RDV_URL = 'https://rdv.example.com'
  const PUBLIC_URL = 'https://central.example.com'

  /** @type {string} */
  let dir
  /** @type {ControlPlane | undefined} */
  let plane
  /** @type {string} */
  let baseUrl
  /** @type {Array<{ url: string, init: RequestInit }>} */
  let fetchCalls

  /**
   * @param {{ ok?: boolean, status?: number, json?: unknown, throws?: Error, withAdmin?: boolean, withRendezvous?: boolean }} [opts]
   */
  async function bootAdminPlane(opts = {}) {
    fetchCalls = []
    /**
     * @param {string | URL | Request} url
     * @param {RequestInit} [init]
     * @returns {Promise<any>}
     */
    async function fakeFetch(url, init) {
      fetchCalls.push({ url: String(url), init: /** @type {RequestInit} */ (init) })
      if (opts.throws) throw opts.throws
      const ok = opts.ok ?? true
      const status = opts.status ?? (ok ? 200 : 500)
      return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        json: () => Promise.resolve(opts.json ?? (ok ? {} : { error: 'rdv unavailable' })),
      }
    }
    /** @type {ServerConfig} */
    const cfg = {
      control_plane_listen: '127.0.0.1:0',
      identity_issuer: { secret: PLACEHOLDER_SECRET },
    }
    if (opts.withAdmin !== false) {
      cfg.public_url = PUBLIC_URL
      cfg.admin = { token: ADMIN_TOKEN }
      cfg.enrollment = { gateway_prefix: 'team-frontend' }
      if (opts.withRendezvous !== false) {
        cfg.rendezvous = { url: RDV_URL, registration_token: RDV_TOKEN }
      }
    }
    plane = new ControlPlane(cfg, {
      enrollmentStore: createEnrollmentStore({ path: path.join(dir, 'enrollments.json') }),
      fetch: fakeFetch,
      env: {},
    })
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    baseUrl = `http://127.0.0.1:${addr.port}`
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cp-admin-'))
  })

  afterEach(async () => {
    if (plane) await plane.stop()
    plane = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns 401 when the admin Bearer token is missing', async () => {
    await bootAdminPlane()
    const res = await fetch(`${baseUrl}/v1/admin/invites`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('returns 401 with the wrong token (constant-time compare in admin_auth)', async () => {
    await bootAdminPlane()
    const res = await fetch(`${baseUrl}/v1/admin/invites`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'X'.repeat(48)}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns 200 with a valid admin token and a syntactically valid join command', async () => {
    await bootAdminPlane()
    const res = await fetch(`${baseUrl}/v1/admin/invites`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(typeof body.joinCode).toBe('string')
    expect(body.joinCode.length).toBe(10)
    expect(body.gatewayPrefix).toBe('team-frontend')
    expect(body.maxUses).toBe(1)
    expect(body.rendezvousUrl).toBe(RDV_URL)
    // expiresAt is an ISO timestamp roughly 7d from now
    const expiry = new Date(body.expiresAt).getTime()
    expect(expiry - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
    expect(expiry - Date.now()).toBeLessThan(8 * 24 * 60 * 60 * 1000)
    // command must parse as `npx collectivus join '<code>' --rendezvous '<url>'`
    expect(body.command).toMatch(
      /^npx collectivus join '[A-Z0-9]{10}' --rendezvous 'https:\/\/rdv\.example\.com'$/
    )

    // Rendezvous was contacted exactly once with the bearer token
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(`${RDV_URL}/v1/rendezvous/invites`)
    expect(/** @type {Record<string, string>} */ (fetchCalls[0].init.headers).authorization)
      .toBe(`Bearer ${RDV_TOKEN}`)
  })

  it('returns 405 on non-POST methods', async () => {
    await bootAdminPlane()
    const res = await fetch(`${baseUrl}/v1/admin/invites`, {
      method: 'GET',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.status).toBe(405)
  })

  it('returns 404 when the server is not configured for admin (route hidden)', async () => {
    await bootAdminPlane({ withAdmin: false })
    const res = await fetch(`${baseUrl}/v1/admin/invites`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.status).toBe(404)
  })

  it('returns 502 and rolls back the enrollment when rendezvous fails', async () => {
    await bootAdminPlane({ ok: false, status: 503, json: { error: 'down' } })
    const enrollPath = path.join(dir, 'enrollments.json')
    const res = await fetch(`${baseUrl}/v1/admin/invites`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/rendezvous registration failed/)
    expect(body.error).not.toContain(RDV_TOKEN)
    expect(res.headers.get('cache-control')).toBe('no-store')

    /** @type {unknown[]} */
    const stored = fs.existsSync(enrollPath) ? JSON.parse(fs.readFileSync(enrollPath, 'utf8')) : []
    expect(stored).toEqual([])
  })

  it('rate-limits POST /v1/admin/invites to 10 requests/min/IP before auth', async () => {
    await bootAdminPlane()
    // 10 unauthorized requests consume the window — each one is 401 but
    // counts because the rate limiter runs BEFORE admin auth.
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${baseUrl}/v1/admin/invites`, {
        method: 'POST',
        headers: { authorization: `Bearer ${'X'.repeat(48)}` },
      })
      expect(r.status).toBe(401)
    }
    // The 11th request in the same window must be 429 with Retry-After,
    // not 401 — the limit is checked ahead of the constant-time token
    // compare so a hostile loop can't burn that path.
    const limited = await fetch(`${baseUrl}/v1/admin/invites`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'X'.repeat(48)}` },
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
    const body = await limited.json()
    expect(body.error).toBe('rate limited')
    expect(typeof body.retry_after_seconds).toBe('number')
    // No rendezvous traffic — the request never reached the handler.
    expect(fetchCalls).toEqual([])
  })
})
