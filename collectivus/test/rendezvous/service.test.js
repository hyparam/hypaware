import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RendezvousService } from '../../src/rendezvous/service.js'
import { sha256Hex } from '../../src/rendezvous/store.js'

const REGISTRATION_TOKEN = 'shared-registration-token'

describe('RendezvousService HTTP API', () => {
  /** @type {string} */
  let tmpDir
  /** @type {RendezvousService | undefined} */
  let service
  /** @type {string} */
  let baseUrl
  /** @type {number} */
  let nowMs

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-rendezvous-http-'))
    nowMs = Date.parse('2026-05-11T12:00:00.000Z')
    service = new RendezvousService({
      listen: '127.0.0.1:0',
      dataDir: tmpDir,
      registrationToken: REGISTRATION_TOKEN,
      cleanupIntervalMs: 0,
    }, { now: () => nowMs })
    await service.start()
    const addr = service.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    if (service) await service.stop()
    service = undefined
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * @param {{ joinCode?: string, auth?: string, expiresAt?: string }} [opts]
   * @returns {Promise<Response>}
   */
  function register(opts = {}) {
    const joinCode = opts.joinCode ?? 'gateway-secret-token-123'
    return fetch(`${baseUrl}/v1/rendezvous/invites`, {
      method: 'POST',
      headers: {
        authorization: opts.auth ?? `Bearer ${REGISTRATION_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'enterprise_enrollment',
        join_code_hash: sha256Hex(joinCode),
        connect_url: 'https://collectivus.internal:8788',
        gateway_id: 'gw-prod-1',
        expires_at: opts.expiresAt ?? '2999-01-01T00:00:00.000Z',
        max_uses: 5,
        display_name: 'Acme prod',
      }),
    })
  }

  it('GET /health returns status, version, and no-store', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(typeof body.version).toBe('string')
  })

  it('requires bearer auth for invite registration', async () => {
    const missing = await fetch(`${baseUrl}/v1/rendezvous/invites`, { method: 'POST' })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('cache-control')).toBe('no-store')

    const wrong = await register({ auth: 'Bearer wrong-token' })
    expect(wrong.status).toBe(401)
  })

  it('registers an invite and resolves the plaintext join code without auth', async () => {
    const joinCode = 'join-code-post-body-only'
    const registered = await register({ joinCode })
    expect(registered.status).toBe(200)
    expect(registered.headers.get('cache-control')).toBe('no-store')
    const registeredBody = await registered.json()
    expect(registeredBody).toMatchObject({ ok: true, expires_at: '2999-01-01T00:00:00.000Z' })

    const resolved = await fetch(`${baseUrl}/v1/rendezvous/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ join_code: joinCode }),
    })
    expect(resolved.status).toBe(200)
    expect(resolved.headers.get('cache-control')).toBe('no-store')
    const resolvedBody = await resolved.json()
    expect(resolvedBody).toEqual({
      kind: 'enterprise_enrollment',
      connect_url: 'https://collectivus.internal:8788',
      gateway_id: 'gw-prod-1',
      expires_at: '2999-01-01T00:00:00.000Z',
      max_uses: 5,
      display_name: 'Acme prod',
    })
  })

  it('rejects duplicate active hashes', async () => {
    expect((await register()).status).toBe(200)
    const duplicate = await register()
    expect(duplicate.status).toBe(409)
  })

  it('rejects malformed resolve bodies and does not accept GET query tokens', async () => {
    const bad = await fetch(`${baseUrl}/v1/rendezvous/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wrong: 'shape' }),
    })
    expect(bad.status).toBe(400)

    const query = await fetch(`${baseUrl}/v1/rendezvous/resolve?join_code=secret`)
    expect(query.status).toBe(405)
  })

  it('returns 410 for join codes that expire before resolve', async () => {
    const joinCode = 'expires-before-resolve'
    const registered = await register({ joinCode, expiresAt: '2026-05-11T12:01:00.000Z' })
    expect(registered.status).toBe(200)
    nowMs += 61_000

    const resolved = await fetch(`${baseUrl}/v1/rendezvous/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ join_code: joinCode }),
    })
    expect(resolved.status).toBe(410)
  })
})
