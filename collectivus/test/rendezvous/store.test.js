import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  RendezvousStoreError,
  cleanupExpiredInvites,
  createRendezvousStore,
  registerInvite,
  resolveInvite,
  sha256Hex,
} from '../../src/rendezvous/store.js'

/**
 * @param {number} initialMs
 * @returns {{ now: () => number, advance: (ms: number) => void }}
 */
function fakeClock(initialMs) {
  let t = initialMs
  return {
    now: () => t,
    advance(ms) { t += ms },
  }
}

describe('rendezvous file store', () => {
  /** @type {string} */
  let tmpDir
  /** @type {ReturnType<typeof fakeClock>} */
  let clock

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-rendezvous-store-'))
    clock = fakeClock(Date.parse('2026-05-11T12:00:00.000Z'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * @param {{ joinCode?: string, expiresAt?: string }} [opts]
   * @returns {ReturnType<typeof registerInvite>}
   */
  function register(opts = {}) {
    const joinCode = opts.joinCode ?? 'join-secret-'.repeat(4)
    return registerInvite(createRendezvousStore({ dataDir: tmpDir, now: clock.now }), {
      join_code_hash: sha256Hex(joinCode),
      connect_url: 'https://collectivus.internal:8788/',
      gateway_id: 'gw-prod-1',
      expires_at: opts.expiresAt ?? '2026-05-11T13:00:00.000Z',
      display_name: 'Acme prod',
    })
  }

  it('registers and resolves an invite without storing the plaintext join code', () => {
    const joinCode = 'secret-token-value-with-entropy-123'
    const record = register({ joinCode })
    expect(record.connect_url).toBe('https://collectivus.internal:8788')
    expect(record.gateway_id).toBe('gw-prod-1')

    const resolved = resolveInvite(createRendezvousStore({ dataDir: tmpDir, now: clock.now }), joinCode)
    expect(resolved).toMatchObject({
      connect_url: 'https://collectivus.internal:8788',
      gateway_id: 'gw-prod-1',
      display_name: 'Acme prod',
    })

    const files = fs.readdirSync(path.join(tmpDir, 'invites'))
    expect(files).toEqual([`${sha256Hex(joinCode)}.json`])
    const raw = fs.readFileSync(path.join(tmpDir, 'invites', files[0]), 'utf8')
    expect(raw).not.toContain(joinCode)
  })

  it('rejects duplicate active hashes', () => {
    register()
    expect(() => register()).toThrow(RendezvousStoreError)
    expect(() => register()).toThrow(/active invite already exists/)
  })

  it('allows an expired hash to be replaced', () => {
    const joinCode = 'replaceable-secret-token'
    register({ joinCode, expiresAt: '2026-05-11T12:01:00.000Z' })
    clock.advance(61_000)
    const replacement = register({ joinCode, expiresAt: '2026-05-11T13:00:00.000Z' })
    expect(replacement.expires_at).toBe('2026-05-11T13:00:00.000Z')
  })

  it('rejects expired invites on resolve', () => {
    const joinCode = 'expiring-secret-token'
    register({ joinCode, expiresAt: '2026-05-11T12:01:00.000Z' })
    clock.advance(61_000)
    expect(() => resolveInvite(createRendezvousStore({ dataDir: tmpDir, now: clock.now }), joinCode))
      .toThrow(/expired/)
  })

  it('cleans up expired invite files', () => {
    register({ joinCode: 'expired-token', expiresAt: '2026-05-11T12:01:00.000Z' })
    register({ joinCode: 'active-token', expiresAt: '2026-05-11T13:00:00.000Z' })
    clock.advance(61_000)
    const removed = cleanupExpiredInvites(createRendezvousStore({ dataDir: tmpDir, now: clock.now }))
    expect(removed).toBe(1)
    const names = fs.readdirSync(path.join(tmpDir, 'invites'))
    expect(names).toEqual([`${sha256Hex('active-token')}.json`])
  })

  it('validates connect_url as http(s)', () => {
    expect(() => registerInvite(createRendezvousStore({ dataDir: tmpDir, now: clock.now }), {
      join_code_hash: sha256Hex('secret'),
      connect_url: 'file:///tmp/nope',
      gateway_id: 'gw-prod-1',
      expires_at: '2026-05-11T13:00:00.000Z',
    })).toThrow(/http\(s\)/)
  })
})
