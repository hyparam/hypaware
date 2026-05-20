import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseJoinArgs, resolveJoinCode, runJoin } from '../../src/cli/join.js'

function memo() {
  let buf = ''
  return {
    write(/** @type {string} */ s) { buf += s },
    value() { return buf },
  }
}

function fakeJwt(/** @type {string} */ gatewayId) {
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: gatewayId, iat: 1, exp: 4102444800 })}.sig`
}

function enc(/** @type {unknown} */ value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

describe('join CLI', () => {
  it('prints help', async () => {
    const stdout = memo()
    const code = await runJoin(['--help'], {}, { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:\s+ctvs join/)
  })

  it('parses join-code and rendezvous URL', () => {
    expect(parseJoinArgs(['secret-code', '--rendezvous', 'https://join.example']))
      .toEqual({ help: false, joinCode: 'secret-code', rendezvous: 'https://join.example' })
  })

  it('requires --rendezvous and validates it as http(s)', () => {
    const missing = parseJoinArgs(['secret-code'])
    expect(missing.help).toBe(false)
    if (!missing.help) expect(missing.error).toMatch(/--rendezvous is required/)

    const invalid = parseJoinArgs(['secret-code', '--rendezvous', 'file:///tmp/nope'])
    expect(invalid.help).toBe(false)
    if (!invalid.help) expect(invalid.error).toMatch(/http\(s\)/)
  })

  it('resolves a join code using POST body, not query params', async () => {
    /** @type {string | undefined} */
    let seenUrl
    /** @type {RequestInit | undefined} */
    let seenInit
    const resolved = await resolveJoinCode(
      'secret-code',
      'https://join.example/base',
      /** @type {typeof fetch} */ (async (url, init) => {
        seenUrl = String(url)
        seenInit = init
        return new Response(JSON.stringify({
          connect_url: 'https://central.example:8788/',
          gateway_id: 'gw-prod-1',
          expires_at: '2999-01-01T00:00:00.000Z',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      })
    )

    expect(seenUrl).toBe('https://join.example/base/v1/rendezvous/resolve')
    expect(seenUrl).not.toContain('secret-code')
    expect(seenInit?.method).toBe('POST')
    expect(JSON.parse(String(seenInit?.body))).toEqual({ join_code: 'secret-code' })
    expect(resolved.connect_url).toBe('https://central.example:8788')
  })

  it('surfaces rendezvous resolve failures', async () => {
    const stderr = memo()
    const code = await runJoin(['secret', '--rendezvous', 'https://join.example'], {}, {
      stdout: memo(),
      stderr,
      fetchFn: /** @type {typeof fetch} */ (async () => new Response(
        JSON.stringify({ error: 'join code not found' }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )),
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/join code not found/)
  })

  it('npx join installs globally, writes authenticated gateway config, attaches Claude, and installs the daemon from the global bin', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-join-npx-'))
    try {
      const stdout = memo()
      const stderr = memo()
      const configPath = path.join(tmpDir, 'collectivus.json')
      const identityPersistedPath = path.join(tmpDir, 'identity.json')
      const logDir = path.join(tmpDir, 'logs')
      const settingsPath = path.join(tmpDir, '.claude', 'settings.json')
      const globalBinPath = '/usr/local/lib/node_modules/collectivus/bin/cli.js'
      /** @type {Array<Record<string, unknown>>} */
      const daemonInstalls = []
      /** @type {Array<Record<string, unknown>>} */
      const attachCalls = []
      /** @type {Array<{ url: string, method?: string, body?: unknown }>} */
      const fetchCalls = []
      let globalInstallCount = 0

      const code = await runJoin(['secret-code', '--rendezvous', 'https://join.example'], {}, {
        stdout,
        stderr,
        binPath: '/Users/u/.npm/_npx/abc/node_modules/collectivus/bin/cli.js',
        configPath,
        identityPersistedPath,
        logDir,
        settingsPath,
        fetchFn: /** @type {typeof fetch} */ (async (url, init) => {
          const requestUrl = String(url)
          fetchCalls.push({ url: requestUrl, method: init?.method, body: init?.body })
          if (requestUrl === 'https://join.example/v1/rendezvous/resolve') {
            return new Response(JSON.stringify({
              connect_url: 'https://central.example:8788/',
              gateway_id: 'gw-prod-1',
              expires_at: '2999-01-01T00:00:00.000Z',
              display_name: 'Production gateway',
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (requestUrl === 'https://central.example:8788/v1/bootstrap-config?token=secret-code') {
            return new Response(JSON.stringify({
              version: 1,
              role: 'gateway',
              central_server: {
                url: 'https://central.example:8788',
                identity: {},
              },
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (requestUrl === 'https://central.example:8788/v1/identity/bootstrap') {
            return new Response(JSON.stringify({
              jwt: fakeJwt('gw-prod-1'),
              expires_at: 4102444800,
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (requestUrl === 'https://central.example:8788/v1/config') {
            return new Response(JSON.stringify({
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
                url: 'https://central.example:8788',
                identity: {},
              },
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          return new Response(JSON.stringify({ error: 'unexpected URL' }), { status: 404 })
        }),
        installGlobal() {
          globalInstallCount += 1
          return Promise.resolve(true)
        },
        resolveGlobalBinPath() {
          return Promise.resolve(globalBinPath)
        },
        installLaunchAgent(opts) {
          daemonInstalls.push({ ...opts })
          return Promise.resolve()
        },
        attach(opts) {
          attachCalls.push({ ...opts })
          return Promise.resolve({ changed: true })
        },
      })

      expect(code).toBe(0)
      expect(globalInstallCount).toBe(1)
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
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
          url: 'https://central.example:8788',
          identity: {},
        },
      })
      expect(JSON.parse(fs.readFileSync(identityPersistedPath, 'utf8'))).toMatchObject({
        gateway_id: 'gw-prod-1',
        expires_at: 4102444800,
      })
      expect(daemonInstalls).toHaveLength(1)
      expect(daemonInstalls[0]).toMatchObject({
        binPath: globalBinPath,
        configPath,
        label: 'com.hyparam.collectivus',
        logDir,
      })
      expect(attachCalls).toHaveLength(1)
      expect(attachCalls[0]).toMatchObject({ port: 8787, settingsPath })
      expect(stdout.value()).toMatch(/Installing collectivus globally/)
      expect(stdout.value()).toMatch(/Identity bootstrapped/)
      expect(stdout.value()).toMatch(/Gateway config fetched/)
      expect(stdout.value()).toMatch(/Gateway config written/)
      expect(stdout.value()).toMatch(/Claude Code attached/)
      expect(stdout.value()).toMatch(/Daemon installed/)
      expect(stderr.value()).toBe('')
      expect(fetchCalls.map((call) => call.url)).toEqual([
        'https://join.example/v1/rendezvous/resolve',
        'https://central.example:8788/v1/bootstrap-config?token=secret-code',
        'https://central.example:8788/v1/identity/bootstrap',
        'https://central.example:8788/v1/config',
      ])
      expect(fetchCalls[0].body).toBe(JSON.stringify({ join_code: 'secret-code' }))
      expect(fetchCalls[2].body).toBe(JSON.stringify({ bootstrap_token: 'secret-code' }))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('npx join stops before writing config when global install fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-join-npx-fail-'))
    try {
      const stdout = memo()
      const stderr = memo()
      const configPath = path.join(tmpDir, 'collectivus.json')
      let resolveGlobalBinCalled = false

      const code = await runJoin(['secret-code', '--rendezvous', 'https://join.example'], {}, {
        stdout,
        stderr,
        binPath: '/Users/u/.npm/_npx/abc/node_modules/collectivus/bin/cli.js',
        configPath,
        fetchFn: /** @type {typeof fetch} */ (async (url) => {
          const requestUrl = String(url)
          if (requestUrl === 'https://join.example/v1/rendezvous/resolve') {
            return new Response(JSON.stringify({
              connect_url: 'https://central.example:8788',
              gateway_id: 'gw-prod-1',
              expires_at: '2999-01-01T00:00:00.000Z',
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (requestUrl === 'https://central.example:8788/v1/bootstrap-config?token=secret-code') {
            return new Response(JSON.stringify({
              version: 1,
              role: 'gateway',
              central_server: {
                url: 'https://central.example:8788',
                identity: {},
              },
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          return new Response(JSON.stringify({ error: 'unexpected URL' }), { status: 404 })
        }),
        installGlobal() {
          return Promise.resolve(false)
        },
        resolveGlobalBinPath() {
          resolveGlobalBinCalled = true
          return Promise.resolve('/usr/local/lib/node_modules/collectivus/bin/cli.js')
        },
      })

      expect(code).toBe(1)
      expect(resolveGlobalBinCalled).toBe(false)
      expect(fs.existsSync(configPath)).toBe(false)
      expect(stderr.value()).toMatch(/npm install -g collectivus failed/)
      expect(stdout.value()).toMatch(/Installing collectivus globally/)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
