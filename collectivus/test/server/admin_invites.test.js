import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createAdminInvitesHandler } from '../../src/server/admin_invites.js'
import { createEnrollmentStore } from '../../src/server/enrollment.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { ServerConfig } from '../../src/types.js'
 * @import { EnrollmentStore } from '../../src/server/enrollment.d.ts'
 */

const RENDEZVOUS_TOKEN = 'r'.repeat(40)
const RENDEZVOUS_URL = 'https://rendezvous.example.com'
const PUBLIC_URL = 'https://central.example.com'
const FIXED_NOW = 1_700_000_000_000

/** @returns {ServerConfig} */
function baseConfig() {
  return {
    control_plane_listen: '127.0.0.1:0',
    public_url: PUBLIC_URL,
    identity_issuer: { secret: 'a'.repeat(32) },
    admin: { token: 'A'.repeat(32) },
    enrollment: { gateway_prefix: 'team-frontend' },
    rendezvous: {
      url: `${RENDEZVOUS_URL}/`,
      registration_token: RENDEZVOUS_TOKEN,
    },
  }
}

/**
 * Build a request body POST'd to the handler. Vitest's tests run on Node, so
 * the IncomingMessage we synthesize must look enough like the real thing for
 * `readJsonBody` (chunked stream + headers) to work.
 *
 * @param {object | string | undefined} body
 * @returns {IncomingMessage}
 */
function makeReq(body) {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const buf = Buffer.from(raw, 'utf8')
  const stream = Readable.from(buf.length === 0 ? [] : [buf])
  /** @type {Record<string, string>} */
  const headers = {}
  if (buf.length > 0) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(buf.length)
  }
  /** @type {any} */
  const req = stream
  req.headers = headers
  req.method = 'POST'
  return /** @type {IncomingMessage} */ req
}

/**
 * @returns {{
 *   res: ServerResponse,
 *   status: () => number,
 *   body: () => any,
 *   headers: () => Record<string, string>,
 * }}
 */
function makeRes() {
  let status = 0
  let body = ''
  /** @type {Record<string, string>} */
  const headers = {}
  let ended = false
  /** @type {any} */
  const res = {
    /**
     * @param {number} s
     * @param {Record<string, string>} [h]
     * @returns {any}
     */
    writeHead(s, h) {
      status = s
      if (h && typeof h === 'object') {
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v)
      }
      return res
    },
    /**
     * @param {string} [chunk]
     * @returns {any}
     */
    end(chunk) {
      body = chunk ?? ''
      ended = true
      return res
    },
    get writableEnded() { return ended },
  }
  return {
    res: /** @type {ServerResponse} */ res,
    status: () => status,
    body: () => body.length ? JSON.parse(body) : undefined,
    headers: () => headers,
  }
}

/**
 * Build a fake `fetch` that records calls and returns a configurable response.
 *
 * @param {{ ok?: boolean, status?: number, statusText?: string, json?: unknown, throws?: Error }} [opts]
 * @returns {{ fetchFn: typeof fetch, calls: Array<{ url: string, init: RequestInit }> }}
 */
function makeFetchStub(opts = {}) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = []
  /**
   * @param {string | URL | Request} url
   * @param {RequestInit} [init]
   * @returns {Promise<any>}
   */
  async function fetchFn(url, init) {
    calls.push({ url: String(url), init: /** @type {RequestInit} */ (init) })
    if (opts.throws) throw opts.throws
    const ok = opts.ok ?? true
    const status = opts.status ?? (ok ? 200 : 500)
    const statusText = opts.statusText ?? (ok ? 'OK' : 'Internal Server Error')
    const jsonBody = opts.json ?? (ok ? {} : { error: 'rendezvous boom' })
    return {
      ok,
      status,
      statusText,
      json: () => Promise.resolve(jsonBody),
    }
  }
  return { fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)), calls }
}

describe('createAdminInvitesHandler', () => {
  /** @type {string} */
  let dir
  /** @type {EnrollmentStore} */
  let enrollmentStore
  /** @type {string[]} */
  let logLines

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-admin-invites-'))
    enrollmentStore = createEnrollmentStore({
      path: path.join(dir, 'enrollments.json'),
      now: () => FIXED_NOW,
    })
    logLines = []
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('throws at construction when required opts are missing', () => {
    expect(() => createAdminInvitesHandler(/** @type {any} */ (undefined))).toThrow()
    expect(() => createAdminInvitesHandler(/** @type {any} */ ({}))).toThrow(/config is required/)
    expect(() =>
      createAdminInvitesHandler(/** @type {any} */ ({ config: baseConfig() }))
    ).toThrow(/enrollmentStore is required/)
  })

  it('returns 200 with the spec response shape and registers locally + with rendezvous', async () => {
    const { fetchFn, calls } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config: baseConfig(),
      enrollmentStore,
      fetchFn,
      generateCode: () => 'CODECODE12',
      now: () => FIXED_NOW,
      logger: (l) => logLines.push(l),
      env: {},
    })
    const { res, status, body, headers } = makeRes()
    await handler(makeReq({}), res)
    expect(status()).toBe(200)
    const out = body()
    expect(out.joinCode).toBe('CODECODE12')
    expect(out.maxUses).toBe(1)
    expect(out.gatewayPrefix).toBe('team-frontend')
    expect(out.rendezvousUrl).toBe(RENDEZVOUS_URL)
    expect(out.command).toBe(`npx collectivus join 'CODECODE12' --rendezvous '${RENDEZVOUS_URL}'`)
    // expiresAt is FIXED_NOW + 7d, formatted ISO
    const expectedExpiry = new Date(Math.floor(FIXED_NOW / 1000) * 1000 + 7 * 24 * 60 * 60 * 1000).toISOString()
    expect(out.expiresAt).toBe(expectedExpiry)
    expect(headers()['cache-control']).toBe('no-store')

    // Rendezvous called once with the correct shape
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${RENDEZVOUS_URL}/v1/rendezvous/invites`)
    const sent = JSON.parse(/** @type {string} */ (calls[0].init.body))
    expect(sent.kind).toBe('enterprise_enrollment')
    expect(sent.connect_url).toBe(PUBLIC_URL)
    expect(sent.gateway_id).toBe('team-frontend')
    expect(sent.expires_at).toBe(expectedExpiry)
    expect(sent.max_uses).toBe(1)
    expect(sent.join_code_hash).toBe(sha256Hex('CODECODE12'))

    // Local enrollment row exists
    const stored = JSON.parse(fs.readFileSync(enrollmentStore.path, 'utf8'))
    expect(stored).toHaveLength(1)
    expect(stored[0].joinCodeHash).toBe(sha256Hex('CODECODE12'))

    // Success log redacts code and token
    expect(logLines).toEqual(['admin invite created gateway=team-frontend max_uses=1 ttl_seconds=604800'])
    expect(logLines.join('\n')).not.toContain('CODECODE12')
    expect(logLines.join('\n')).not.toContain(RENDEZVOUS_TOKEN)
  })

  it('uses defaults for optional fields and accepts an empty body', async () => {
    const { fetchFn, calls } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config: baseConfig(),
      enrollmentStore,
      fetchFn,
      generateCode: () => 'EMPTYBODY1',
      now: () => FIXED_NOW,
      logger: (l) => logLines.push(l),
      env: {},
    })
    const { res, status, body } = makeRes()
    await handler(makeReq(undefined), res)
    expect(status()).toBe(200)
    expect(body().maxUses).toBe(1)
    // ttlSeconds default surfaces only via expiresAt = now + 7d.
    const sent = JSON.parse(/** @type {string} */ (calls[0].init.body))
    const ttlSec = (new Date(sent.expires_at).getTime() - FIXED_NOW) / 1000
    expect(ttlSec).toBe(604800)
  })

  it('honors caller-supplied gatewayPrefix, maxUses, ttlSeconds, displayName', async () => {
    const { fetchFn, calls } = makeFetchStub()
    const config = baseConfig()
    delete config.enrollment // force body prefix to be the source
    const handler = createAdminInvitesHandler({
      config,
      enrollmentStore,
      fetchFn,
      generateCode: () => 'OVERRIDE12',
      now: () => FIXED_NOW,
      logger: (l) => logLines.push(l),
      env: {},
    })
    const { res, status, body } = makeRes()
    await handler(
      makeReq({ gatewayPrefix: 'team-platform', maxUses: 5, ttlSeconds: 3600, displayName: 'Friday open house' }),
      res
    )
    expect(status()).toBe(200)
    const out = body()
    expect(out.gatewayPrefix).toBe('team-platform')
    expect(out.maxUses).toBe(5)
    const ttlSec = (new Date(out.expiresAt).getTime() - FIXED_NOW) / 1000
    expect(ttlSec).toBe(3600)

    const sent = JSON.parse(/** @type {string} */ (calls[0].init.body))
    expect(sent.gateway_id).toBe('team-platform')
    expect(sent.max_uses).toBe(5)
    expect(sent.display_name).toBe('Friday open house')

    expect(logLines).toEqual(['admin invite created gateway=team-platform max_uses=5 ttl_seconds=3600'])
  })

  it('returns 400 with the spec wording when no prefix is configured or supplied', async () => {
    const config = baseConfig()
    delete config.enrollment
    const { fetchFn, calls } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config,
      enrollmentStore,
      fetchFn,
      now: () => FIXED_NOW,
      logger: (l) => logLines.push(l),
      env: {},
    })
    const { res, status, body, headers } = makeRes()
    await handler(makeReq({}), res)
    expect(status()).toBe(400)
    expect(body().error).toBe(
      'gateway prefix required: configure server.enrollment.gateway_prefix or pass gatewayPrefix in the request'
    )
    expect(headers()['cache-control']).toBe('no-store')
    expect(calls).toHaveLength(0)
    // No enrollment row written when validation fails before registration
    expect(fs.existsSync(enrollmentStore.path)).toBe(false)
  })

  it('returns 400 for invalid gatewayPrefix', async () => {
    const { fetchFn } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config: baseConfig(),
      enrollmentStore,
      fetchFn,
      now: () => FIXED_NOW,
      env: {},
    })
    const { res, status, body, headers } = makeRes()
    await handler(makeReq({ gatewayPrefix: 'bad/prefix' }), res)
    expect(status()).toBe(400)
    expect(body().error).toMatch(/gatewayPrefix is not a valid gateway id/)
    expect(headers()['cache-control']).toBe('no-store')
  })

  it.each([
    ['maxUses', { maxUses: 0 }, /maxUses must be a positive integer/],
    ['maxUses (non-integer)', { maxUses: 1.5 }, /maxUses must be a positive integer/],
    ['maxUses (string)', { maxUses: '3' }, /maxUses must be a positive integer/],
    ['ttlSeconds', { ttlSeconds: -1 }, /ttlSeconds must be a positive integer/],
    ['ttlSeconds (zero)', { ttlSeconds: 0 }, /ttlSeconds must be a positive integer/],
    ['displayName (empty)', { displayName: '' }, /displayName must be a non-empty string/],
    ['displayName (number)', { displayName: 5 }, /displayName must be a non-empty string/],
  ])('returns 400 for invalid %s', async (_name, body, pattern) => {
    const { fetchFn } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config: baseConfig(),
      enrollmentStore,
      fetchFn,
      now: () => FIXED_NOW,
      env: {},
    })
    const { res, status, body: respBody, headers } = makeRes()
    await handler(makeReq(body), res)
    expect(status()).toBe(400)
    expect(respBody().error).toMatch(pattern)
    expect(headers()['cache-control']).toBe('no-store')
  })

  it('returns 400 with cache-control no-store on malformed JSON', async () => {
    const { fetchFn } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config: baseConfig(),
      enrollmentStore,
      fetchFn,
      now: () => FIXED_NOW,
      env: {},
    })
    const { res, status, body, headers } = makeRes()
    await handler(makeReq('not-json'), res)
    expect(status()).toBe(400)
    expect(body().error).toBe('invalid JSON body')
    expect(headers()['cache-control']).toBe('no-store')
  })

  it('returns 502 and removes the enrollment row when rendezvous fails', async () => {
    const { fetchFn } = makeFetchStub({ ok: false, status: 503, json: { error: 'unavailable' } })
    const handler = createAdminInvitesHandler({
      config: baseConfig(),
      enrollmentStore,
      fetchFn,
      generateCode: () => 'ROLLBACK12',
      now: () => FIXED_NOW,
      logger: (l) => logLines.push(l),
      env: {},
    })
    const { res, status, body, headers } = makeRes()
    await handler(makeReq({}), res)
    expect(status()).toBe(502)
    expect(body().error).toMatch(/rendezvous registration failed/)
    expect(body().error).toContain('unavailable')
    // Token must NEVER appear in the surfaced error
    expect(body().error).not.toContain(RENDEZVOUS_TOKEN)
    expect(headers()['cache-control']).toBe('no-store')

    // Enrollment row was rolled back: file may exist but contain no records
    /** @type {unknown[]} */
    const stored = fs.existsSync(enrollmentStore.path)
      ? JSON.parse(fs.readFileSync(enrollmentStore.path, 'utf8'))
      : []
    expect(stored).toEqual([])

    // Failure path must NOT log the success line
    expect(logLines).toEqual([])
  })

  it('returns 502 and rolls back when the rendezvous fetch throws (network error)', async () => {
    const { fetchFn } = makeFetchStub({ throws: new Error('ECONNREFUSED') })
    const handler = createAdminInvitesHandler({
      config: baseConfig(),
      enrollmentStore,
      fetchFn,
      generateCode: () => 'NETERROR12',
      now: () => FIXED_NOW,
      env: {},
    })
    const { res, status, body, headers } = makeRes()
    await handler(makeReq({}), res)
    expect(status()).toBe(502)
    expect(body().error).toMatch(/ECONNREFUSED/)
    expect(headers()['cache-control']).toBe('no-store')

    /** @type {unknown[]} */
    const stored = fs.existsSync(enrollmentStore.path)
      ? JSON.parse(fs.readFileSync(enrollmentStore.path, 'utf8'))
      : []
    expect(stored).toEqual([])
  })

  it('returns 500 when server.rendezvous is not configured', async () => {
    const config = baseConfig()
    delete config.rendezvous
    const { fetchFn, calls } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config,
      enrollmentStore,
      fetchFn,
      now: () => FIXED_NOW,
      env: {},
    })
    const { res, status, body, headers } = makeRes()
    await handler(makeReq({}), res)
    expect(status()).toBe(500)
    expect(body().error).toMatch(/rendezvous not configured/)
    expect(headers()['cache-control']).toBe('no-store')
    expect(calls).toHaveLength(0)
  })

  it('resolves rendezvous URL and token from environment variables', async () => {
    const config = baseConfig()
    config.rendezvous = {
      url_env: 'TEST_RDV_URL',
      registration_token_env: 'TEST_RDV_TOKEN',
    }
    const { fetchFn, calls } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config,
      enrollmentStore,
      fetchFn,
      generateCode: () => 'ENVRESOLV12',
      now: () => FIXED_NOW,
      env: {
        TEST_RDV_URL: 'https://rdv-from-env.example/',
        TEST_RDV_TOKEN: 'token-from-env-' + 'x'.repeat(20),
      },
    })
    const { res, status, body } = makeRes()
    await handler(makeReq({}), res)
    expect(status()).toBe(200)
    expect(body().rendezvousUrl).toBe('https://rdv-from-env.example')
    expect(calls[0].url).toBe('https://rdv-from-env.example/v1/rendezvous/invites')
    expect(calls[0].init.headers).toMatchObject({
      authorization: 'Bearer token-from-env-' + 'x'.repeat(20),
    })
  })

  it('returns 500 when the configured env var for rendezvous is unset', async () => {
    const config = baseConfig()
    config.rendezvous = {
      url_env: 'MISSING_URL',
      registration_token_env: 'MISSING_TOKEN',
    }
    const { fetchFn } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config,
      enrollmentStore,
      fetchFn,
      now: () => FIXED_NOW,
      env: {},
    })
    const { res, status, body, headers } = makeRes()
    await handler(makeReq({}), res)
    expect(status()).toBe(500)
    expect(body().error).toMatch(/rendezvous not configured/)
    expect(headers()['cache-control']).toBe('no-store')
  })

  it('returns 413 when the body exceeds 1 KiB', async () => {
    const { fetchFn, calls } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config: baseConfig(),
      enrollmentStore,
      fetchFn,
      now: () => FIXED_NOW,
      env: {},
    })
    const big = { displayName: 'x'.repeat(2000) }
    const { res, status, body, headers } = makeRes()
    await handler(makeReq(big), res)
    expect(status()).toBe(413)
    expect(body().error).toMatch(/too large/)
    expect(headers()['cache-control']).toBe('no-store')
    expect(calls).toHaveLength(0)
  })

  it('renders the join command with shell-safe quoting around the code and url', async () => {
    const config = baseConfig()
    // Force a rendezvous URL containing a single quote, which is unrealistic
    // but exercises the shellSingleQuote escape path on the URL field.
    config.rendezvous = {
      url: 'https://has\'quote.example/',
      registration_token: RENDEZVOUS_TOKEN,
    }
    const { fetchFn } = makeFetchStub()
    const handler = createAdminInvitesHandler({
      config,
      enrollmentStore,
      fetchFn,
      generateCode: () => 'QUOT\'CODE1',
      now: () => FIXED_NOW,
      env: {},
    })
    const { res, status, body } = makeRes()
    await handler(makeReq({}), res)
    expect(status()).toBe(200)
    // shellSingleQuote: `'a'b'` becomes `'a'\''b'`
    expect(body().command).toBe(
      'npx collectivus join \'QUOT\'\\\'\'CODE1\' --rendezvous \'https://has\'\\\'\'quote.example\''
    )
  })
})

/**
 * @param {string} value
 * @returns {string}
 */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

// Silence the "unused" warning when vi is conditionally absent in narrow tests.
void vi
