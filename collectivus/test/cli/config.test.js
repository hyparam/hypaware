import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError } from '../../src/config.js'
import { parseConfigArgs, runConfig } from '../../src/cli/config.js'
import { sha256Hex } from '../../src/rendezvous/store.js'
import { createConfigRegistry, getConfig, resolveConfigsDir, setConfig } from '../../src/server/config_registry.js'
import { BootstrapStore, issueFromBootstrap } from '../../src/server/identity.js'

/**
 * @import { CollectivusConfig, ServerConfig } from '../../src/types.js'
 */

const SECRET = 'a'.repeat(32)

/**
 * Minimal in-memory stream collector matching the existing CLI test helper.
 *
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

/**
 * Build a server-mode CollectivusConfig pointed at the given filesystem dirs.
 * The actual `loadConfig` of the test config file is exercised by integration
 * tests; here we return the object directly via the loadConfig hook so unit
 * tests don't have to round-trip through disk for the server config.
 *
 * @param {{ dataDir: string, bootstrapStorePath?: string, publicUrl?: string }} opts
 * @returns {CollectivusConfig}
 */
function buildServerConfig(opts) {
  /** @type {ServerConfig['identity_issuer']} */
  const issuer = { secret: SECRET }
  if (opts.bootstrapStorePath) issuer.bootstrap_store_path = opts.bootstrapStorePath
  /** @type {ServerConfig} */
  const server = {
    control_plane_listen: '127.0.0.1:8788',
    identity_issuer: issuer,
    data_dir: opts.dataDir,
  }
  if (opts.publicUrl) server.public_url = opts.publicUrl
  return {
    version: 1,
    role: 'server',
    server,
  }
}

/**
 * Build a gateway-shaped CollectivusConfig that the registry will accept.
 *
 * @returns {CollectivusConfig}
 */
function gatewayConfig() {
  return {
    version: 1,
    proxy: {
      listen: '127.0.0.1:8787',
      upstreams: [
        { name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/' } },
      ],
    },
    sink: { type: 'file', dir: '/tmp/x' },
  }
}

describe('parseConfigArgs', () => {
  it('returns help for empty argv', () => {
    expect(parseConfigArgs([]).kind).toBe('error')
  })

  it('returns help on --help', () => {
    expect(parseConfigArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseConfigArgs(['-h'])).toEqual({ kind: 'help' })
  })

  it('rejects unknown subcommand', () => {
    const r = parseConfigArgs(['mystery'])
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toMatch(/unknown subcommand/)
  })

  describe('set', () => {
    it('parses positional gateway-id, --server-config, --file', () => {
      const r = parseConfigArgs(['set', 'gw-1', '--server-config', '/etc/c.json', '--file', '/tmp/g.json'])
      expect(r).toEqual({ kind: 'set', gatewayId: 'gw-1', serverConfig: '/etc/c.json', file: '/tmp/g.json' })
    })

    it('accepts --flag=value form', () => {
      const r = parseConfigArgs(['set', 'gw-1', '--server-config=/etc/c.json', '--file=/tmp/g.json'])
      expect(r).toEqual({ kind: 'set', gatewayId: 'gw-1', serverConfig: '/etc/c.json', file: '/tmp/g.json' })
    })

    it('errors when gateway-id is missing', () => {
      const r = parseConfigArgs(['set', '--server-config', '/etc/c.json', '--file', '/tmp/g.json'])
      expect(r.kind).toBe('error')
      if (r.kind === 'error') expect(r.message).toMatch(/gateway-id is required/)
    })

    it('errors when --server-config is missing', () => {
      const r = parseConfigArgs(['set', 'gw-1', '--file', '/tmp/g.json'])
      expect(r.kind).toBe('error')
      if (r.kind === 'error') expect(r.message).toMatch(/--server-config or --server-config-env is required/)
    })

    it('errors when --file is missing', () => {
      const r = parseConfigArgs(['set', 'gw-1', '--server-config', '/etc/c.json'])
      expect(r.kind).toBe('error')
      if (r.kind === 'error') expect(r.message).toMatch(/--file is required/)
    })

    it('rejects invalid gateway-id (path traversal)', () => {
      const r = parseConfigArgs(['set', '../evil', '--server-config', '/etc/c.json', '--file', '/tmp/g.json'])
      expect(r.kind).toBe('error')
      if (r.kind === 'error') expect(r.message).toMatch(/invalid gateway-id/)
    })

    it('rejects "." and ".." as gateway-id', () => {
      expect(parseConfigArgs(['set', '.', '--server-config', 'x', '--file', 'y']).kind).toBe('error')
      expect(parseConfigArgs(['set', '..', '--server-config', 'x', '--file', 'y']).kind).toBe('error')
    })

    it('accepts email-shaped gateway-id', () => {
      const r = parseConfigArgs([
        'set', 'james.smith@acme.com',
        '--server-config', '/etc/c.json',
        '--file', '/tmp/g.json',
      ])
      expect(r.kind).toBe('set')
      if (r.kind === 'set') expect(r.gatewayId).toBe('james.smith@acme.com')
    })

    it('rejects extra positionals', () => {
      const r = parseConfigArgs(['set', 'gw-1', 'gw-2', '--server-config', 'x', '--file', 'y'])
      expect(r.kind).toBe('error')
      if (r.kind === 'error') expect(r.message).toMatch(/unexpected positional/)
    })
  })

  describe('get', () => {
    it('parses gateway-id + --server-config', () => {
      const r = parseConfigArgs(['get', 'gw-1', '--server-config', '/etc/c.json'])
      expect(r).toEqual({ kind: 'get', gatewayId: 'gw-1', serverConfig: '/etc/c.json' })
    })

    it('errors without --server-config', () => {
      expect(parseConfigArgs(['get', 'gw-1']).kind).toBe('error')
    })

    it('errors without gateway-id', () => {
      expect(parseConfigArgs(['get', '--server-config', '/etc/c.json']).kind).toBe('error')
    })
  })

  describe('list', () => {
    it('parses --server-config', () => {
      expect(parseConfigArgs(['list', '--server-config', '/etc/c.json']))
        .toEqual({ kind: 'list', serverConfig: '/etc/c.json' })
    })

    it('parses --server-config-env', () => {
      expect(parseConfigArgs(['list', '--server-config-env', 'COLLECTIVUS_SERVER_CONFIG']))
        .toEqual({ kind: 'list', serverConfigEnv: 'COLLECTIVUS_SERVER_CONFIG' })
    })

    it('rejects both server config source flags', () => {
      const r = parseConfigArgs([
        'list',
        '--server-config', '/etc/c.json',
        '--server-config-env', 'COLLECTIVUS_SERVER_CONFIG',
      ])
      expect(r.kind).toBe('error')
      if (r.kind === 'error') expect(r.message).toMatch(/mutually exclusive/)
    })

    it('errors on extra positional', () => {
      expect(parseConfigArgs(['list', 'unexpected', '--server-config', 'x']).kind).toBe('error')
    })

    it('errors without --server-config', () => {
      expect(parseConfigArgs(['list']).kind).toBe('error')
    })
  })

  describe('delete', () => {
    it('parses gateway-id + --server-config + --yes', () => {
      const r = parseConfigArgs(['delete', 'gw-1', '--server-config', '/etc/c.json', '--yes'])
      expect(r).toEqual({ kind: 'delete', gatewayId: 'gw-1', serverConfig: '/etc/c.json', yes: true })
    })

    it('defaults yes=false', () => {
      const r = parseConfigArgs(['delete', 'gw-1', '--server-config', '/etc/c.json'])
      expect(r).toEqual({ kind: 'delete', gatewayId: 'gw-1', serverConfig: '/etc/c.json', yes: false })
    })

    it('accepts -y as shorthand for --yes', () => {
      const r = parseConfigArgs(['delete', 'gw-1', '--server-config', '/etc/c.json', '-y'])
      expect(r.kind).toBe('delete')
      if (r.kind === 'delete') expect(r.yes).toBe(true)
    })
  })

  describe('bootstrap-token', () => {
    it('errors when neither issue nor revoke given', () => {
      expect(parseConfigArgs(['bootstrap-token']).kind).toBe('error')
    })

    it('errors on unknown action', () => {
      expect(parseConfigArgs(['bootstrap-token', 'mystery']).kind).toBe('error')
    })

    it('parses issue without --ttl-seconds', () => {
      const r = parseConfigArgs(['bootstrap-token', 'issue', 'gw-1', '--server-config', '/etc/c.json'])
      expect(r).toEqual({ kind: 'token-issue', gatewayId: 'gw-1', serverConfig: '/etc/c.json' })
    })

    it('parses issue with --ttl-seconds', () => {
      const r = parseConfigArgs(['bootstrap-token', 'issue', 'gw-1', '--server-config', '/etc/c.json', '--ttl-seconds', '300'])
      expect(r).toEqual({ kind: 'token-issue', gatewayId: 'gw-1', serverConfig: '/etc/c.json', ttlSeconds: 300 })
    })

    it('parses issue with rendezvous registration options', () => {
      const r = parseConfigArgs([
        'bootstrap-token', 'issue', 'gw-1',
        '--server-config', '/etc/c.json',
        '--rendezvous', 'https://join.example',
        '--rendezvous-token', 'admin-token',
      ])
      expect(r).toEqual({
        kind: 'token-issue',
        gatewayId: 'gw-1',
        serverConfig: '/etc/c.json',
        rendezvous: 'https://join.example',
        rendezvousToken: 'admin-token',
      })
    })

    it('rejects invalid rendezvous options', () => {
      expect(parseConfigArgs([
        'bootstrap-token', 'issue', 'gw-1',
        '--server-config', 'x',
        '--rendezvous', 'file:///tmp/nope',
      ]).kind).toBe('error')
      expect(parseConfigArgs([
        'bootstrap-token', 'issue', 'gw-1',
        '--server-config', 'x',
        '--rendezvous-token', 'admin-token',
      ]).kind).toBe('error')
    })

    it('rejects non-positive --ttl-seconds', () => {
      expect(parseConfigArgs(['bootstrap-token', 'issue', 'gw-1', '--server-config', 'x', '--ttl-seconds', '0']).kind).toBe('error')
      expect(parseConfigArgs(['bootstrap-token', 'issue', 'gw-1', '--server-config', 'x', '--ttl-seconds', 'abc']).kind).toBe('error')
      expect(parseConfigArgs(['bootstrap-token', 'issue', 'gw-1', '--server-config', 'x', '--ttl-seconds', '-5']).kind).toBe('error')
    })

    it('parses revoke', () => {
      const r = parseConfigArgs(['bootstrap-token', 'revoke', 'gw-1', '--server-config', '/etc/c.json'])
      expect(r).toEqual({ kind: 'token-revoke', gatewayId: 'gw-1', serverConfig: '/etc/c.json' })
    })

    it('errors when issue is missing gateway-id', () => {
      expect(parseConfigArgs(['bootstrap-token', 'issue', '--server-config', '/etc/c.json']).kind).toBe('error')
    })
  })
})

describe('runConfig', () => {
  /** @type {string} */
  let tmpDir
  /** @type {string} */
  let dataDir
  /** @type {string} */
  let bootstrapStorePath

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-config-cli-'))
    dataDir = path.join(tmpDir, 'server-data')
    bootstrapStorePath = path.join(tmpDir, 'bootstrap.json')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * Build the hook bundle that wires real registry/store implementations to
   * the temporary directories so each test runs against actual files on disk.
   *
   * @param {{ withBootstrapStore?: boolean, publicUrl?: string }} [opts]
   * @returns {{ stdout: ReturnType<typeof memo>, stderr: ReturnType<typeof memo>, hooks: Parameters<typeof runConfig>[1], serverConfigPath: string }}
   */
  function makeHooks(opts = {}) {
    const stdout = memo()
    const stderr = memo()
    const cfg = buildServerConfig({
      dataDir,
      publicUrl: opts.publicUrl,
      ...opts.withBootstrapStore !== false ? { bootstrapStorePath } : {},
    })
    const serverConfigPath = path.join(tmpDir, 'server.json')
    return {
      stdout,
      stderr,
      serverConfigPath,
      hooks: {
        stdout,
        stderr,
        isTTY: false,
        loadConfig() { return cfg },
      },
    }
  }

  it('prints help and exits 0 on --help', async () => {
    const stdout = memo()
    const stderr = memo()
    const code = await runConfig(['--help'], { stdout, stderr })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('exits 2 on unknown subcommand', async () => {
    const stdout = memo()
    const stderr = memo()
    const code = await runConfig(['mystery'], { stdout, stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown subcommand/)
  })

  it('exits 2 with usage on missing required flags', async () => {
    const stdout = memo()
    const stderr = memo()
    const code = await runConfig(['set', 'gw-1'], { stdout, stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/--server-config or --server-config-env is required/)
    expect(stderr.value()).toMatch(/Usage:/)
  })

  it('exits 1 when server-config fails to load', async () => {
    const stdout = memo()
    const stderr = memo()
    const code = await runConfig(['list', '--server-config', '/nope.json'], {
      stdout, stderr,
      loadConfig() { throw new ConfigError('config file not found: /nope.json') },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/server config:/)
  })

  it('exits 1 when server-config is not role: server', async () => {
    const stdout = memo()
    const stderr = memo()
    const code = await runConfig(['list', '--server-config', '/etc/c.json'], {
      stdout, stderr,
      loadConfig() { return /** @type {CollectivusConfig} */ ({ version: 1 }) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/role: "server"/)
  })

  it('loads server config JSON from --server-config-env', async () => {
    const stdout = memo()
    const stderr = memo()
    const cfg = buildServerConfig({ dataDir, bootstrapStorePath })
    const registry = createConfigRegistry({ configsDir: resolveConfigsDir(/** @type {ServerConfig} */ ({ data_dir: dataDir })) })
    setConfig(registry, 'gw-env', gatewayConfig())
    const code = await runConfig(['list', '--server-config-env', 'COLLECTIVUS_SERVER_CONFIG'], {
      stdout,
      stderr,
      env: { COLLECTIVUS_SERVER_CONFIG: JSON.stringify(cfg) },
    })
    expect(code).toBe(0)
    expect(stdout.value()).toBe('gw-env\n')
  })

  describe('set + get round-trip (acceptance #1)', () => {
    it('writes a config and reads it back exactly', async () => {
      const m = makeHooks()
      const filePath = path.join(tmpDir, 'gw-prod-1.json')
      const cfg = gatewayConfig()
      fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2))

      const setCode = await runConfig(
        ['set', 'gw-prod-1', '--server-config', m.serverConfigPath, '--file', filePath],
        m.hooks
      )
      expect(setCode).toBe(0)
      expect(m.stdout.value()).toMatch(/Wrote config for gw-prod-1/)

      // Reset stdout to verify get's output independently.
      const getStdout = memo()
      const getCode = await runConfig(
        ['get', 'gw-prod-1', '--server-config', m.serverConfigPath],
        { ...m.hooks, stdout: getStdout }
      )
      expect(getCode).toBe(0)
      expect(JSON.parse(getStdout.value())).toEqual(cfg)
    })

    it('rejects --file with invalid JSON', async () => {
      const m = makeHooks()
      const filePath = path.join(tmpDir, 'broken.json')
      fs.writeFileSync(filePath, '{ not valid json')
      const code = await runConfig(
        ['set', 'gw-1', '--server-config', m.serverConfigPath, '--file', filePath],
        m.hooks
      )
      expect(code).toBe(1)
      expect(m.stderr.value()).toMatch(/invalid JSON/)
    })

    it('rejects --file that fails the gateway validator', async () => {
      const m = makeHooks()
      const filePath = path.join(tmpDir, 'bad.json')
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, proxy: { listen: 'no-colon' } }))
      const code = await runConfig(
        ['set', 'gw-1', '--server-config', m.serverConfigPath, '--file', filePath],
        m.hooks
      )
      expect(code).toBe(1)
      expect(m.stderr.value()).toMatch(/invalid config/)
    })

    it('rejects --file ENOENT with a friendly message', async () => {
      const m = makeHooks()
      const code = await runConfig(
        ['set', 'gw-1', '--server-config', m.serverConfigPath, '--file', path.join(tmpDir, 'missing.json')],
        m.hooks
      )
      expect(code).toBe(1)
      expect(m.stderr.value()).toMatch(/file not found/)
    })

    it('get returns 1 with a friendly message when no config registered', async () => {
      const m = makeHooks()
      const code = await runConfig(['get', 'gw-unknown', '--server-config', m.serverConfigPath], m.hooks)
      expect(code).toBe(1)
      expect(m.stderr.value()).toMatch(/no config found for gw-unknown/)
    })
  })

  describe('list (acceptance #2)', () => {
    it('lists registered gateway IDs sorted, one per line', async () => {
      const m = makeHooks()
      const registry = createConfigRegistry({ configsDir: resolveConfigsDir(/** @type {ServerConfig} */ ({ data_dir: dataDir })) })
      setConfig(registry, 'gw-z', gatewayConfig())
      setConfig(registry, 'gw-a', gatewayConfig())
      setConfig(registry, 'gw-m', gatewayConfig())

      const code = await runConfig(['list', '--server-config', m.serverConfigPath], m.hooks)
      expect(code).toBe(0)
      expect(m.stdout.value()).toBe('gw-a\ngw-m\ngw-z\n')
    })

    it('prints nothing when no gateways are registered', async () => {
      const m = makeHooks()
      const code = await runConfig(['list', '--server-config', m.serverConfigPath], m.hooks)
      expect(code).toBe(0)
      expect(m.stdout.value()).toBe('')
    })
  })

  describe('delete (acceptance #4)', () => {
    it('--yes deletes the file; subsequent get reports "no config found"', async () => {
      const m = makeHooks()
      const registry = createConfigRegistry({ configsDir: resolveConfigsDir(/** @type {ServerConfig} */ ({ data_dir: dataDir })) })
      setConfig(registry, 'gw-prod-1', gatewayConfig())

      const delCode = await runConfig(
        ['delete', 'gw-prod-1', '--server-config', m.serverConfigPath, '--yes'],
        m.hooks
      )
      expect(delCode).toBe(0)
      expect(m.stdout.value()).toMatch(/Deleted config for gw-prod-1/)

      const getStderr = memo()
      const getCode = await runConfig(
        ['get', 'gw-prod-1', '--server-config', m.serverConfigPath],
        { ...m.hooks, stderr: getStderr }
      )
      expect(getCode).toBe(1)
      expect(getStderr.value()).toMatch(/no config found/)
    })

    it('reports nothing-to-delete when the gateway has no registered config', async () => {
      const m = makeHooks()
      const code = await runConfig(
        ['delete', 'gw-missing', '--server-config', m.serverConfigPath, '--yes'],
        m.hooks
      )
      expect(code).toBe(0)
      expect(m.stdout.value()).toMatch(/No config registered for gw-missing/)
    })

    it('refuses to delete without --yes when not a TTY', async () => {
      const m = makeHooks()
      const registry = createConfigRegistry({ configsDir: resolveConfigsDir(/** @type {ServerConfig} */ ({ data_dir: dataDir })) })
      setConfig(registry, 'gw-1', gatewayConfig())

      const code = await runConfig(
        ['delete', 'gw-1', '--server-config', m.serverConfigPath],
        m.hooks
      )
      expect(code).toBe(1)
      expect(m.stderr.value()).toMatch(/refusing to delete without --yes/)
      // File survives the refused delete.
      expect(getConfig(registry, 'gw-1')).toBeDefined()
    })

    it('TTY without --yes prompts and deletes on confirm', async () => {
      const m = makeHooks()
      const registry = createConfigRegistry({ configsDir: resolveConfigsDir(/** @type {ServerConfig} */ ({ data_dir: dataDir })) })
      setConfig(registry, 'gw-1', gatewayConfig())

      /** @type {string[]} */
      const prompts = []
      const code = await runConfig(
        ['delete', 'gw-1', '--server-config', m.serverConfigPath],
        {
          ...m.hooks,
          isTTY: true,
          prompt(q) { prompts.push(q); return Promise.resolve('y') },
        }
      )
      expect(code).toBe(0)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatch(/Delete config for gw-1\?/)
      expect(getConfig(registry, 'gw-1')).toBeUndefined()
    })

    it('TTY without --yes cancels on negative answer', async () => {
      const m = makeHooks()
      const registry = createConfigRegistry({ configsDir: resolveConfigsDir(/** @type {ServerConfig} */ ({ data_dir: dataDir })) })
      setConfig(registry, 'gw-1', gatewayConfig())

      const code = await runConfig(
        ['delete', 'gw-1', '--server-config', m.serverConfigPath],
        {
          ...m.hooks,
          isTTY: true,
          prompt() { return Promise.resolve('n') },
        }
      )
      expect(code).toBe(0)
      expect(m.stdout.value()).toMatch(/Cancelled/)
      expect(getConfig(registry, 'gw-1')).toBeDefined()
    })
  })

  describe('bootstrap-token issue (acceptance #3)', () => {
    it('issues a token that issueFromBootstrap can redeem for a JWT', async () => {
      const m = makeHooks()
      const code = await runConfig(
        ['bootstrap-token', 'issue', 'gw-prod-1', '--server-config', m.serverConfigPath],
        m.hooks
      )
      expect(code).toBe(0)

      // Token printed on stdout (one line, the plaintext token).
      const token = m.stdout.value().trim()
      expect(token).toMatch(/^[0-9a-f]{64}$/)
      // Operator-facing context lands on stderr.
      expect(m.stderr.value()).toMatch(/Token issued for gw-prod-1/)

      // The same token redeems via issueFromBootstrap (the same code path the
      // running server's POST /v1/identity/bootstrap uses).
      const store = new BootstrapStore({ path: bootstrapStorePath })
      const issued = issueFromBootstrap(token, store, { secret: SECRET })
      if (issued.ok !== true) throw new Error(`expected issue, got reason=${issued.reason}`)
      expect(issued.gatewayId).toBe('gw-prod-1')
      expect(issued.jwt.split('.')).toHaveLength(3)
    })

    it('honors --ttl-seconds override', async () => {
      const m = makeHooks()
      const code = await runConfig(
        ['bootstrap-token', 'issue', 'gw-1', '--server-config', m.serverConfigPath, '--ttl-seconds', '120'],
        m.hooks
      )
      expect(code).toBe(0)
      const token = m.stdout.value().trim()
      const store = new BootstrapStore({ path: bootstrapStorePath })
      // Pull the record by hashing the token — the store doesn't expose lookup
      // but we can re-register the same token to inspect expiry; instead,
      // verify by waiting + fail-on-expired semantics.
      // Simplest: confirm that the persisted record's expiresAt is roughly
      // (now + 120) seconds.
      /** @type {Array<{ gatewayId: string, expiresAt: number, used: boolean }>} */
      const records = JSON.parse(fs.readFileSync(bootstrapStorePath, 'utf8'))
      const record = records.find((r) => r.gatewayId === 'gw-1')
      expect(record).toBeDefined()
      if (!record) return
      const expectedExpiry = Math.floor(Date.now() / 1000) + 120
      // Allow 5s slack for slow CI.
      expect(record.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 5)
      expect(record.expiresAt).toBeLessThanOrEqual(expectedExpiry + 5)
      void token
      void store
    })

    it('prints a one-line npx setup command when server.public_url is configured', async () => {
      const m = makeHooks({ publicUrl: 'https://collectivus.example.com' })
      const code = await runConfig(
        ['bootstrap-token', 'issue', 'gw-setup', '--server-config', m.serverConfigPath],
        m.hooks
      )
      expect(code).toBe(0)
      const token = m.stdout.value().trim()
      expect(m.stderr.value()).toContain(
        `npx collectivus --config-endpoint='https://collectivus.example.com/v1/bootstrap-config?token=${token}'`
      )
    })

    it('registers rendezvous invites with a short join key, max uses, and env auth fallback', async () => {
      const m = makeHooks({ publicUrl: 'https://collectivus.internal:8788' })
      /** @type {Array<{ url: string, init: RequestInit | undefined }>} */
      const calls = []
      const code = await runConfig(
        [
          'bootstrap-token', 'issue', 'gw-rv',
          '--server-config', m.serverConfigPath,
          '--rendezvous', 'https://join.example',
          '--max-uses', '3',
        ],
        {
          ...m.hooks,
          env: { COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN: 'admin-token' },
          fetch: /** @type {typeof fetch} */ (async (url, init) => {
            calls.push({ url: String(url), init })
            return new Response(JSON.stringify({ ok: true, expires_at: '2999-01-01T00:00:00.000Z' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }),
        }
      )
      expect(code).toBe(0)
      const joinCode = m.stdout.value().trim()
      expect(joinCode).toMatch(/^[A-Z2-9]{10}$/)
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://join.example/v1/rendezvous/invites')
      expect(calls[0].init?.method).toBe('POST')
      expect(calls[0].init?.headers).toMatchObject({
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      })
      const body = JSON.parse(String(calls[0].init?.body))
      expect(body).toEqual({
        kind: 'enterprise_enrollment',
        join_code_hash: sha256Hex(joinCode),
        connect_url: 'https://collectivus.internal:8788',
        gateway_id: 'gw-rv',
        expires_at: expect.any(String),
        max_uses: 3,
      })
      expect(JSON.stringify(body)).not.toContain(joinCode)
      const enrollmentRows = JSON.parse(fs.readFileSync(path.join(dataDir, 'enrollments.json'), 'utf8'))
      expect(enrollmentRows).toMatchObject([{
        joinCodeHash: sha256Hex(joinCode),
        gatewayId: 'gw-rv',
        maxUses: 3,
        usedCount: 0,
      }])
      expect(m.stderr.value()).toContain(`npx collectivus join '${joinCode}' --rendezvous 'https://join.example'`)
    })

    it('requires server.public_url when issuing with rendezvous', async () => {
      const m = makeHooks()
      const code = await runConfig(
        [
          'bootstrap-token', 'issue', 'gw-rv',
          '--server-config', m.serverConfigPath,
          '--rendezvous', 'https://join.example',
          '--rendezvous-token', 'admin-token',
        ],
        m.hooks
      )
      expect(code).toBe(1)
      expect(m.stdout.value()).toBe('')
      expect(m.stderr.value()).toMatch(/server\.public_url is required/)
    })

    it('errors when bootstrap_store_path is not configured', async () => {
      const m = makeHooks({ withBootstrapStore: false })
      const code = await runConfig(
        ['bootstrap-token', 'issue', 'gw-1', '--server-config', m.serverConfigPath],
        m.hooks
      )
      expect(code).toBe(1)
      expect(m.stderr.value()).toMatch(/bootstrap_store_path is not set/)
    })
  })

  describe('bootstrap-token revoke', () => {
    it('drops unused tokens for the target gateway', async () => {
      const m = makeHooks()
      const store = new BootstrapStore({ path: bootstrapStorePath })
      store.register({ gatewayId: 'gw-A', ttlSeconds: 60 })
      store.register({ gatewayId: 'gw-A', ttlSeconds: 60 })
      store.register({ gatewayId: 'gw-B', ttlSeconds: 60 })
      expect(store.size()).toBe(3)

      const code = await runConfig(
        ['bootstrap-token', 'revoke', 'gw-A', '--server-config', m.serverConfigPath],
        m.hooks
      )
      expect(code).toBe(0)
      expect(m.stdout.value()).toMatch(/Revoked 2 unused bootstrap tokens for gw-A/)

      const reloaded = new BootstrapStore({ path: bootstrapStorePath })
      expect(reloaded.size()).toBe(1)
    })

    it('reports 0 when no unused tokens exist', async () => {
      const m = makeHooks()
      const code = await runConfig(
        ['bootstrap-token', 'revoke', 'gw-none', '--server-config', m.serverConfigPath],
        m.hooks
      )
      expect(code).toBe(0)
      expect(m.stdout.value()).toMatch(/Revoked 0 unused bootstrap tokens for gw-none/)
    })

    it('treats a missing bootstrap store as a no-op', async () => {
      const m = makeHooks({ withBootstrapStore: false })
      const code = await runConfig(
        ['bootstrap-token', 'revoke', 'gw-1', '--server-config', m.serverConfigPath],
        m.hooks
      )
      expect(code).toBe(0)
      expect(m.stdout.value()).toMatch(/No bootstrap store configured/)
    })
  })
})
