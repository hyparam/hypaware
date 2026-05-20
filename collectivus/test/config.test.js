import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError, isConfigUrl, loadConfig, loadConfigAsync, resolveRuntimeSecrets } from '../src/config.js'

/** @type {string} */
let tmpDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-config-'))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
function writeFile(name, body) {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, body)
  return p
}

/**
 * @param {string} name
 * @param {unknown} obj
 * @returns {string}
 */
function writeJson(name, obj) {
  return writeFile(name, JSON.stringify(obj, null, 2))
}

/**
 * Tests use the no-op stderr to avoid leaking warnings into the test runner
 * output for cases where strict-mode warnings aren't the assertion target.
 *
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memoStderr() {
  let buf = ''
  return { write(s) { buf += s }, value() { return buf } }
}

describe('loadConfig - file errors', () => {
  it('throws ConfigError when the file does not exist', () => {
    const missing = path.join(tmpDir, 'does-not-exist.json')
    expect(() => loadConfig(missing)).toThrow(ConfigError)
    expect(() => loadConfig(missing)).toThrow(/config file not found/)
  })
})

describe('loadConfig - JSON errors', () => {
  it('throws ConfigError with line/column for invalid JSON', () => {
    const p = writeFile('bad.json', '{\n  "otel": {\n    "listen": 4318,\n  }\n}')
    /** @type {unknown} */
    let caught
    try {
      loadConfig(p)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    const msg = caught instanceof Error ? caught.message : String(caught)
    expect(msg).toMatch(/invalid JSON/)
    expect(msg).toMatch(/line \d+, column \d+/)
  })

  it('rejects an empty file', () => {
    const p = writeFile('empty.json', '')
    expect(() => loadConfig(p)).toThrow(ConfigError)
  })
})

describe('loadConfig - version', () => {
  it('hard-fails a v0 config (no version field) with the documented error', () => {
    const p = writeJson('v0.json', { otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp' } })
    expect(() => loadConfig(p)).toThrow(/missing "version" field/)
    expect(() => loadConfig(p)).toThrow(/requires version: 1/)
  })

  it('rejects an unsupported version value', () => {
    const p = writeJson('v2.json', { version: 2 })
    expect(() => loadConfig(p)).toThrow(/unsupported version/)
  })

  it('rejects a string version', () => {
    const p = writeJson('vstr.json', { version: '1' })
    expect(() => loadConfig(p)).toThrow(/unsupported version/)
  })

  it('accepts version: 1', () => {
    const p = writeJson('v1.json', { version: 1 })
    expect(loadConfig(p)).toEqual({ version: 1 })
  })
})

describe('loadConfig - schema errors', () => {
  it('rejects a non-object root', () => {
    const p = writeJson('arr.json', ['otel'])
    expect(() => loadConfig(p)).toThrow(/must be an object/)
  })

  it('warns on unknown top-level keys without --strict', () => {
    const p = writeJson('extra.json', {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      sink: { type: 'file', dir: '/tmp' },
      mystery: 1,
    })
    const stderr = memoStderr()
    const cfg = loadConfig(p, { stderr })
    // Unknown key is ignored, not stripped (validator does not mutate).
    expect(cfg).toEqual({
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      sink: { type: 'file', dir: '/tmp' },
      mystery: 1,
    })
    expect(stderr.value()).toMatch(/unknown config key "mystery" ignored/)
    expect(stderr.value()).toMatch(/recognizes:.*"version".*"otel".*"proxy".*"sink".*"upload"/)
  })

  it('rejects unknown top-level keys with --strict', () => {
    const p = writeJson('extra.json', {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      sink: { type: 'file', dir: '/tmp' },
      mystery: 1,
    })
    expect(() => loadConfig(p, { strict: true })).toThrow(/unknown key "mystery"/)
  })

  it('rejects per-section unknown keys regardless of strict', () => {
    const p = writeJson('typo.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        // typo: upsteams instead of upstreams
        upsteams: [],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    // Without --strict, per-section unknown keys still fail.
    expect(() => loadConfig(p, { stderr: memoStderr() })).toThrow(/unknown key "upsteams"/)
  })

  it('accepts optional query.cache config', () => {
    const p = writeJson('query.json', {
      version: 1,
      query: { cache: { enabled: true, dir: '/tmp/collectivus-query' } },
    })
    expect(loadConfig(p)).toEqual({
      version: 1,
      query: { cache: { enabled: true, dir: '/tmp/collectivus-query' } },
    })
  })

  it('rejects unknown query keys and invalid query.cache types', () => {
    const unknown = writeJson('query-unknown.json', {
      version: 1,
      query: { mystery: true },
    })
    expect(() => loadConfig(unknown)).toThrow(/\/query\/mystery.*unknown key/)

    const oldParquetKey = writeJson('query-parquet.json', {
      version: 1,
      query: { parquet: { enabled: true } },
    })
    expect(() => loadConfig(oldParquetKey)).toThrow(/\/query\/parquet.*unknown key/)

    const badEnabled = writeJson('query-enabled.json', {
      version: 1,
      query: { cache: { enabled: 'yes' } },
    })
    expect(() => loadConfig(badEnabled)).toThrow(/\/query\/cache\/enabled.*boolean/)

    const badDir = writeJson('query-dir.json', {
      version: 1,
      query: { cache: { dir: '' } },
    })
    expect(() => loadConfig(badDir)).toThrow(/\/query\/cache\/dir.*non-empty string/)
  })

  it('requires sink when proxy is present', () => {
    const p = writeJson('no-sink.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [
          { name: 'a', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } },
        ],
      },
    })
    expect(() => loadConfig(p)).toThrow(/sink is required when otel or proxy is configured/)
  })

  it('requires sink when otel is present', () => {
    const p = writeJson('otel-no-sink.json', {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
    })
    expect(() => loadConfig(p)).toThrow(/sink is required when otel or proxy is configured/)
  })

  it('rejects proxy without upstreams', () => {
    const p = writeJson('no-upstreams.json', {
      version: 1,
      proxy: { listen: '0.0.0.0:8080' },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/upstreams is required/)
  })

  it('rejects upstreams that is not an array', () => {
    const p = writeJson('object-upstreams.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        // The v0 object-map shape is no longer valid.
        upstreams: { a: { base_url: 'https://x.test', match: { path_prefix: '/' } } },
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/\/proxy\/upstreams.*must be an array/)
  })

  it('rejects empty upstreams array', () => {
    const p = writeJson('empty-upstreams.json', {
      version: 1,
      proxy: { listen: '0.0.0.0:8080', upstreams: [] },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/at least one upstream is required/)
  })

  it('rejects upstream missing name', () => {
    const p = writeJson('no-name.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [{ base_url: 'https://x.test', match: { path_prefix: '/x' } }],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/\/proxy\/upstreams\/0\/name/)
  })

  it('rejects upstream missing base_url', () => {
    const p = writeJson('bad-upstream.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [{ name: 'a', match: { path_prefix: '/x' } }],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/\/proxy\/upstreams\/0\/base_url/)
  })

  it('rejects upstream missing match.path_prefix', () => {
    const p = writeJson('bad-match.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [{ name: 'a', base_url: 'https://x.test', match: {} }],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/path_prefix/)
  })

  it('rejects duplicate upstream names', () => {
    const p = writeJson('dup-name.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [
          { name: 'dup', base_url: 'https://a.test', match: { path_prefix: '/a' } },
          { name: 'dup', base_url: 'https://b.test', match: { path_prefix: '/b' } },
        ],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/duplicate upstream name "dup"/)
  })

  it('rejects sink type other than "file"', () => {
    const p = writeJson('bad-sink.json', {
      version: 1,
      sink: { type: 's3', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/only sink type "file" is supported in v0/)
  })

  it('rejects otel.listen that is not a string', () => {
    const p = writeJson('bad-otel.json', {
      version: 1,
      otel: { listen: 4318 },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/\/otel\/listen/)
  })

  it('rejects redact_headers that is not an array', () => {
    const p = writeJson('bad-redact.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        redact_headers: 'authorization',
        upstreams: [
          { name: 'a', base_url: 'https://x.test', match: { path_prefix: '/x' } },
        ],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/redact_headers/)
  })
})

describe('loadConfig - upload section', () => {
  it('accepts a minimal upload block (only bucket)', () => {
    const cfg = { version: 1, upload: { bucket: 'my-bucket' } }
    const p = writeJson('upload-min.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('accepts a fully populated upload block', () => {
    const cfg = {
      version: 1,
      upload: {
        bucket: 'my-bucket',
        prefix: 'logs',
        region: 'us-west-2',
        time: '02:30',
        signals: ['logs', 'traces', 'proxy'],
        catchupDays: 7,
        endpoint: 'http://minio:9000',
      },
    }
    const p = writeJson('upload-full.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('does not inject defaults, so print-config round-trips unchanged', () => {
    // The validator must not mutate the parsed object; defaults are applied
    // later by createUploader. This guarantees `--print-config` shows what
    // the user wrote, not what the binary will run with.
    const cfg = { version: 1, upload: { bucket: 'b' } }
    const p = writeJson('upload-no-defaults.json', cfg)
    const loaded = loadConfig(p)
    expect(loaded.upload).toEqual({ bucket: 'b' })
    expect(loaded.upload.prefix).toBeUndefined()
    expect(loaded.upload.time).toBeUndefined()
  })

  it('rejects upload missing bucket', () => {
    const p = writeJson('no-bucket.json', { version: 1, upload: { prefix: 'logs' } })
    expect(() => loadConfig(p)).toThrow(/\/upload\/bucket/)
  })

  it('rejects empty bucket', () => {
    const p = writeJson('empty-bucket.json', { version: 1, upload: { bucket: '' } })
    expect(() => loadConfig(p)).toThrow(/\/upload\/bucket/)
  })

  it('rejects malformed time', () => {
    const p = writeJson('bad-time.json', {
      version: 1,
      upload: { bucket: 'b', time: '24:00' },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/time.*HH:MM/)
  })

  it('rejects time without colon', () => {
    const p = writeJson('bad-time2.json', {
      version: 1,
      upload: { bucket: 'b', time: '0010' },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/time/)
  })

  it('rejects unknown signal value', () => {
    const p = writeJson('bad-signal.json', {
      version: 1,
      upload: { bucket: 'b', signals: ['logs', 'profiles'] },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/signals\/1/)
  })

  it('rejects negative catchupDays', () => {
    const p = writeJson('neg-catchup.json', {
      version: 1,
      upload: { bucket: 'b', catchupDays: -1 },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/catchupDays.*non-negative/)
  })

  it('rejects non-integer catchupDays', () => {
    const p = writeJson('frac-catchup.json', {
      version: 1,
      upload: { bucket: 'b', catchupDays: 1.5 },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/catchupDays/)
  })

  it('rejects unknown keys inside upload', () => {
    const p = writeJson('upload-typo.json', {
      version: 1,
      upload: { bucket: 'b', mistery: true },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/mistery/)
  })
})

describe('loadConfig - role / server / central_server', () => {
  // Long enough to satisfy the 32-char minimum on the issuer secret.
  const SECRET = 'a'.repeat(40)

  it('treats a missing role as standalone (existing v1 configs unchanged)', () => {
    const cfg = { version: 1, otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp' } }
    const p = writeJson('no-role.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('accepts an explicit role of "standalone"', () => {
    const cfg = { version: 1, role: 'standalone' }
    const p = writeJson('role-standalone.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('rejects an unknown role value', () => {
    const p = writeJson('bad-role.json', { version: 1, role: 'master' })
    expect(() => loadConfig(p)).toThrow(/\/role.*server.*gateway.*standalone/)
  })

  it('rejects a non-string role', () => {
    const p = writeJson('numeric-role.json', { version: 1, role: 1 })
    expect(() => loadConfig(p)).toThrow(/\/role/)
  })

  it('accepts role: server with a valid server block', () => {
    const cfg = {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        public_url: 'https://collectivus.example.com',
        identity_issuer: { secret: SECRET },
      },
    }
    const p = writeJson('role-server-ok.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('accepts role: gateway with a valid central_server block', () => {
    const cfg = {
      version: 1,
      role: 'gateway',
      central_server: {
        url: 'https://central.example.com',
        identity: { bootstrap_token: 'op-issued-token' },
      },
    }
    const p = writeJson('role-gateway-ok.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('accepts role: gateway proxy/otel configs without sink', () => {
    const cfg = {
      version: 1,
      role: 'gateway',
      otel: { listen: '127.0.0.1:4318' },
      proxy: {
        listen: '127.0.0.1:8787',
        upstreams: [
          { name: 'api', base_url: 'https://api.example.com', match: { path_prefix: '/' } },
        ],
      },
      central_server: {
        url: 'https://central.example.com',
        identity: { persisted_path: '/var/lib/collectivus/identity.json' },
      },
    }
    const p = writeJson('role-gateway-no-sink.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('rejects role: server without a server block', () => {
    const p = writeJson('server-missing.json', { version: 1, role: 'server' })
    expect(() => loadConfig(p)).toThrow(/server block is required when role is "server"/)
  })

  it('rejects role: gateway without a central_server block', () => {
    const p = writeJson('gateway-missing.json', { version: 1, role: 'gateway' })
    expect(() => loadConfig(p)).toThrow(/central_server block is required when role is "gateway"/)
  })

  it('rejects role: server with a central_server block (cross-mode contamination)', () => {
    const p = writeJson('server-with-cs.json', {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret: SECRET },
      },
      central_server: { url: 'https://x.test', identity: {} },
    })
    expect(() => loadConfig(p)).toThrow(/central_server is not permitted when role is "server"/)
  })

  it('rejects role: gateway with a server block (cross-mode contamination)', () => {
    const p = writeJson('gateway-with-server.json', {
      version: 1,
      role: 'gateway',
      central_server: { url: 'https://x.test', identity: {} },
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret: SECRET },
      },
    })
    expect(() => loadConfig(p)).toThrow(/server is not permitted when role is "gateway"/)
  })

  it('rejects a server block when role is standalone (default)', () => {
    const p = writeJson('standalone-with-server.json', {
      version: 1,
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret: SECRET },
      },
    })
    expect(() => loadConfig(p)).toThrow(/server is only permitted when role is "server"/)
  })

  it('rejects a central_server block when role is standalone (default)', () => {
    const p = writeJson('standalone-with-cs.json', {
      version: 1,
      central_server: { url: 'https://x.test', identity: {} },
    })
    expect(() => loadConfig(p)).toThrow(/central_server is only permitted when role is "gateway"/)
  })

  it('rejects server.control_plane_listen that is missing', () => {
    const p = writeJson('no-listen.json', {
      version: 1,
      role: 'server',
      server: { identity_issuer: { secret: SECRET } },
    })
    expect(() => loadConfig(p)).toThrow(/control_plane_listen is required/)
  })

  it('rejects server.control_plane_listen without a port', () => {
    const p = writeJson('no-port.json', {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: 'localhost',
        identity_issuer: { secret: SECRET },
      },
    })
    expect(() => loadConfig(p)).toThrow(/control_plane_listen.*host:port/)
  })

  it('rejects server.control_plane_listen with an out-of-range port', () => {
    const p = writeJson('bad-port.json', {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:70000',
        identity_issuer: { secret: SECRET },
      },
    })
    expect(() => loadConfig(p)).toThrow(/invalid port in host:port/)
  })

  it('rejects server.public_url that is not a URL', () => {
    const p = writeJson('bad-public-url.json', {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        public_url: 'not a url',
        identity_issuer: { secret: SECRET },
      },
    })
    expect(() => loadConfig(p)).toThrow(/\/server\/public_url.*http\(s\) URL/)
  })

  it('accepts an IPv6 host:port literal in control_plane_listen', () => {
    const cfg = {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '[::1]:9090',
        identity_issuer: { secret: SECRET },
      },
    }
    const p = writeJson('ipv6-listen.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('rejects identity_issuer.secret shorter than 32 chars', () => {
    const p = writeJson('short-secret.json', {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret: 'short' },
      },
    })
    expect(() => loadConfig(p)).toThrow(/identity_issuer\/secret.*at least 32/)
  })

  it('rejects identity_issuer missing secret', () => {
    const p = writeJson('no-secret.json', {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: {},
      },
    })
    expect(() => loadConfig(p)).toThrow(/identity_issuer.*secret or secret_env/)
  })

  it('accepts identity_issuer.secret_env for runtime secret injection', () => {
    const cfg = {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret_env: 'COLLECTIVUS_IDENTITY_ISSUER_SECRET' },
      },
    }
    const p = writeJson('issuer-secret-env.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('rejects identity_issuer with both secret and secret_env', () => {
    const p = writeJson('issuer-secret-both.json', {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret: SECRET, secret_env: 'COLLECTIVUS_IDENTITY_ISSUER_SECRET' },
      },
    })
    expect(() => loadConfig(p)).toThrow(/identity_issuer.*exactly one/)
  })

  it('resolves identity_issuer.secret_env from runtime env', () => {
    /** @type {import('../src/types.js').CollectivusConfig} */
    const cfg = {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret_env: 'COLLECTIVUS_IDENTITY_ISSUER_SECRET' },
      },
    }
    expect(resolveRuntimeSecrets(cfg, { COLLECTIVUS_IDENTITY_ISSUER_SECRET: SECRET })).toEqual({
      ...cfg,
      server: {
        ...cfg.server,
        identity_issuer: {
          ...cfg.server.identity_issuer,
          secret: SECRET,
        },
      },
    })
  })

  it('rejects unresolved identity_issuer.secret_env at runtime', () => {
    /** @type {import('../src/types.js').CollectivusConfig} */
    const cfg = {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret_env: 'COLLECTIVUS_IDENTITY_ISSUER_SECRET' },
      },
    }
    expect(() => resolveRuntimeSecrets(cfg, {})).toThrow(/COLLECTIVUS_IDENTITY_ISSUER_SECRET is not set/)
  })

  it('accepts optional jwt_ttl_seconds and bootstrap_ttl_seconds', () => {
    const cfg = {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: {
          secret: SECRET,
          jwt_ttl_seconds: 2_592_000,
          bootstrap_ttl_seconds: 600,
        },
      },
    }
    const p = writeJson('issuer-ttls.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('rejects non-positive jwt_ttl_seconds', () => {
    const p = writeJson('bad-jwt-ttl.json', {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret: SECRET, jwt_ttl_seconds: 0 },
      },
    })
    expect(() => loadConfig(p)).toThrow(/jwt_ttl_seconds.*positive integer/)
  })

  it('rejects unknown keys inside server', () => {
    const p = writeJson('server-typo.json', {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret: SECRET },
        oops: true,
      },
    })
    expect(() => loadConfig(p)).toThrow(/\/server\/oops/)
  })

  it('rejects unknown keys inside identity_issuer', () => {
    const p = writeJson('issuer-typo.json', {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        identity_issuer: { secret: SECRET, alg: 'HS256' },
      },
    })
    expect(() => loadConfig(p)).toThrow(/identity_issuer\/alg/)
  })

  it('rejects central_server.url that is not a parseable URL', () => {
    const p = writeJson('bad-url.json', {
      version: 1,
      role: 'gateway',
      central_server: { url: 'not a url', identity: {} },
    })
    expect(() => loadConfig(p)).toThrow(/central_server\/url.*parseable/)
  })

  it('rejects central_server missing url', () => {
    const p = writeJson('cs-no-url.json', {
      version: 1,
      role: 'gateway',
      central_server: { identity: {} },
    })
    expect(() => loadConfig(p)).toThrow(/central_server\/url/)
  })

  it('rejects central_server missing identity', () => {
    const p = writeJson('cs-no-id.json', {
      version: 1,
      role: 'gateway',
      central_server: { url: 'https://x.test' },
    })
    expect(() => loadConfig(p)).toThrow(/central_server\/identity/)
  })

  it('accepts an empty central_server.identity (fields are optional, runtime checks later)', () => {
    const cfg = {
      version: 1,
      role: 'gateway',
      central_server: { url: 'https://x.test', identity: {} },
    }
    const p = writeJson('cs-empty-id.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('accepts central_server.identity with persisted_path only', () => {
    const cfg = {
      version: 1,
      role: 'gateway',
      central_server: {
        url: 'https://x.test',
        identity: { persisted_path: '/var/lib/collectivus/identity.json' },
      },
    }
    const p = writeJson('cs-persisted.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('accepts central_server.outbox_dir and rejects an empty value', () => {
    const cfg = {
      version: 1,
      role: 'gateway',
      central_server: {
        url: 'https://x.test',
        identity: {},
        outbox_dir: '/var/lib/collectivus/outbox',
      },
    }
    const p = writeJson('cs-outbox.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)

    const bad = writeJson('cs-empty-outbox.json', {
      version: 1,
      role: 'gateway',
      central_server: { url: 'https://x.test', identity: {}, outbox_dir: '' },
    })
    expect(() => loadConfig(bad)).toThrow(/central_server\/outbox_dir.*non-empty string/)
  })

  it('rejects unknown keys inside central_server', () => {
    const p = writeJson('cs-typo.json', {
      version: 1,
      role: 'gateway',
      central_server: { url: 'https://x.test', identity: {}, oops: 1 },
    })
    expect(() => loadConfig(p)).toThrow(/\/central_server\/oops/)
  })

  it('rejects unknown keys inside central_server.identity', () => {
    const p = writeJson('cs-id-typo.json', {
      version: 1,
      role: 'gateway',
      central_server: { url: 'https://x.test', identity: { mtls: true } },
    })
    expect(() => loadConfig(p)).toThrow(/central_server\/identity\/mtls/)
  })

  it('keeps a v1 config from co-zdn.7 (proxy + sink + upload + no role) loading unchanged', () => {
    const cfg = {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [
          {
            name: 'anthropic',
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          },
        ],
      },
      sink: { type: 'file', dir: '/var/log/collectivus' },
      upload: { bucket: 'my-bucket' },
    }
    const p = writeJson('co-zdn7.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })
})

describe('loadConfig - server.admin / enrollment / rendezvous', () => {
  // 32+ chars to satisfy issuer-secret and admin-token minimums.
  const SECRET = 'a'.repeat(40)
  const ADMIN_TOKEN = 'A'.repeat(40)
  const RENDEZVOUS_TOKEN = 'r'.repeat(48)

  /**
   * @param {Record<string, unknown>} [serverOverrides]
   * @returns {{
   *   version: 1,
   *   role: 'server',
   *   server: {
   *     control_plane_listen: string,
   *     public_url?: string,
   *     identity_issuer: { secret: string },
   *     admin?: Record<string, unknown>,
   *     enrollment?: Record<string, unknown>,
   *     rendezvous?: Record<string, unknown>,
   *   },
   * }}
   */
  function serverConfig(serverOverrides = {}) {
    return {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '0.0.0.0:9090',
        public_url: 'https://collectivus.example.com',
        identity_issuer: { secret: SECRET },
        ...serverOverrides,
      },
    }
  }

  it('accepts server.admin with an inline token', () => {
    const cfg = serverConfig({ admin: { token: ADMIN_TOKEN } })
    const p = writeJson('admin-inline.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('accepts server.admin with token_env (env var resolved at runtime)', () => {
    const cfg = serverConfig({ admin: { token_env: 'COLLECTIVUS_ADMIN_TOKEN' } })
    const p = writeJson('admin-env.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('rejects server.admin with both token and token_env', () => {
    const cfg = serverConfig({
      admin: { token: ADMIN_TOKEN, token_env: 'COLLECTIVUS_ADMIN_TOKEN' },
    })
    const p = writeJson('admin-both.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/admin.*exactly one of token or token_env/)
  })

  it('rejects server.admin missing both token and token_env', () => {
    const cfg = serverConfig({ admin: {} })
    const p = writeJson('admin-neither.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/admin.*exactly one of token or token_env/)
  })

  it('rejects server.admin.token shorter than 32 chars', () => {
    const cfg = serverConfig({ admin: { token: 'a'.repeat(31) } })
    const p = writeJson('admin-short.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/admin\/token.*at least 32/)
  })

  it('rejects server.admin without server.public_url', () => {
    const cfg = serverConfig({ admin: { token: ADMIN_TOKEN } })
    delete cfg.server.public_url
    const p = writeJson('admin-no-public-url.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/public_url.*required when server\.admin/)
  })

  it('rejects unknown keys inside server.admin', () => {
    const cfg = serverConfig({ admin: { token: ADMIN_TOKEN, scope: 'rw' } })
    const p = writeJson('admin-typo.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/admin\/scope/)
  })

  it('accepts server.enrollment.gateway_prefix when it matches the gateway-id pattern', () => {
    const cfg = serverConfig({ enrollment: { gateway_prefix: 'acme.eng-' } })
    const p = writeJson('enrollment-ok.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('rejects server.enrollment.gateway_prefix containing forbidden characters', () => {
    const cfg = serverConfig({ enrollment: { gateway_prefix: 'bad/prefix' } })
    const p = writeJson('enrollment-bad.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/enrollment\/gateway_prefix/)
  })

  it('rejects server.enrollment.gateway_prefix that starts with a dot', () => {
    const cfg = serverConfig({ enrollment: { gateway_prefix: '.hidden' } })
    const p = writeJson('enrollment-leading-dot.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/enrollment\/gateway_prefix/)
  })

  it('accepts an empty server.enrollment block', () => {
    const cfg = serverConfig({ enrollment: {} })
    const p = writeJson('enrollment-empty.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('rejects unknown keys inside server.enrollment', () => {
    const cfg = serverConfig({ enrollment: { gateway_prefix: 'acme', extra: true } })
    const p = writeJson('enrollment-typo.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/enrollment\/extra/)
  })

  it('accepts server.rendezvous with inline url and inline token', () => {
    const cfg = serverConfig({
      rendezvous: {
        url: 'https://rendezvous.example.com',
        registration_token: RENDEZVOUS_TOKEN,
      },
    })
    const p = writeJson('rdv-inline.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('accepts server.rendezvous with env-based url and token', () => {
    const cfg = serverConfig({
      rendezvous: {
        url_env: 'COLLECTIVUS_RENDEZVOUS_URL',
        registration_token_env: 'COLLECTIVUS_RENDEZVOUS_TOKEN',
      },
    })
    const p = writeJson('rdv-env.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('rejects server.rendezvous missing both url and url_env', () => {
    const cfg = serverConfig({
      rendezvous: { registration_token: RENDEZVOUS_TOKEN },
    })
    const p = writeJson('rdv-no-url.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/rendezvous.*exactly one of url or url_env/)
  })

  it('rejects server.rendezvous missing both registration_token and registration_token_env', () => {
    const cfg = serverConfig({
      rendezvous: { url: 'https://rendezvous.example.com' },
    })
    const p = writeJson('rdv-no-token.json', cfg)
    expect(() => loadConfig(p)).toThrow(
      /\/server\/rendezvous.*exactly one of registration_token or registration_token_env/
    )
  })

  it('rejects server.rendezvous with both url and url_env', () => {
    const cfg = serverConfig({
      rendezvous: {
        url: 'https://rendezvous.example.com',
        url_env: 'COLLECTIVUS_RENDEZVOUS_URL',
        registration_token: RENDEZVOUS_TOKEN,
      },
    })
    const p = writeJson('rdv-both-url.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/rendezvous.*exactly one of url or url_env/)
  })

  it('rejects server.rendezvous.url that is not http(s)', () => {
    const cfg = serverConfig({
      rendezvous: {
        url: 'ftp://rendezvous.example.com',
        registration_token: RENDEZVOUS_TOKEN,
      },
    })
    const p = writeJson('rdv-bad-url.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/rendezvous\/url.*http\(s\) URL/)
  })

  it('rejects unknown keys inside server.rendezvous', () => {
    const cfg = serverConfig({
      rendezvous: {
        url: 'https://rendezvous.example.com',
        registration_token: RENDEZVOUS_TOKEN,
        strategy: 'rotate',
      },
    })
    const p = writeJson('rdv-typo.json', cfg)
    expect(() => loadConfig(p)).toThrow(/\/server\/rendezvous\/strategy/)
  })

  it('keeps existing server configs without admin/enrollment/rendezvous loading unchanged', () => {
    const cfg = serverConfig()
    const p = writeJson('server-no-admin.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })
})

describe('loadConfig - valid configs', () => {
  it('loads a version-only config (every section is optional)', () => {
    const cfg = { version: 1 }
    const p = writeJson('v1-only.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('loads an otel-only config (with required sink)', () => {
    const cfg = { version: 1, otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp' } }
    const p = writeJson('otel.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('loads a proxy-only config (with required sink)', () => {
    const cfg = {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [
          {
            name: 'anthropic',
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          },
        ],
      },
      sink: { type: 'file', dir: '/var/log/collectivus' },
    }
    const p = writeJson('proxy.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('loads a config with both otel and proxy', () => {
    const cfg = {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      proxy: {
        listen: '0.0.0.0:8080',
        redact_headers: ['authorization', 'x-api-key'],
        upstreams: [
          {
            name: 'anthropic',
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          },
          {
            name: 'openai',
            base_url: 'https://api.openai.com',
            match: { path_prefix: '/v1/chat' },
          },
        ],
      },
      sink: { type: 'file', dir: '/var/log/collectivus' },
    }
    const p = writeJson('both.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })
})

describe('isConfigUrl', () => {
  it('matches http and https URLs', () => {
    expect(isConfigUrl('http://example.com/c.json')).toBe(true)
    expect(isConfigUrl('https://example.com/c.json')).toBe(true)
    expect(isConfigUrl('HTTPS://EXAMPLE.COM/c.json')).toBe(true)
  })

  it('rejects non-URL paths', () => {
    expect(isConfigUrl('/tmp/c.json')).toBe(false)
    expect(isConfigUrl('./c.json')).toBe(false)
    expect(isConfigUrl('c.json')).toBe(false)
    expect(isConfigUrl('file:///tmp/c.json')).toBe(false)
    expect(isConfigUrl('s3://bucket/c.json')).toBe(false)
  })
})

describe('loadConfigAsync', () => {
  /**
   * @param {{ ok: boolean, status?: number, statusText?: string, body?: string }} resp
   * @returns {typeof fetch}
   */
  function stubFetch(resp) {
    function fetchFn() {
      return Promise.resolve({
        ok: resp.ok,
        status: resp.status ?? (resp.ok ? 200 : 500),
        statusText: resp.statusText ?? (resp.ok ? 'OK' : 'Server Error'),
        text() { return Promise.resolve(resp.body ?? '') },
      })
    }
    return /** @type {any} */ (fetchFn)
  }

  it('delegates to sync loadConfig for filesystem paths', async () => {
    const cfg = { version: 1 }
    const p = writeJson('async-path.json', cfg)
    await expect(loadConfigAsync(p)).resolves.toEqual(cfg)
  })

  it('fetches and validates a URL config', async () => {
    const cfg = { version: 1, otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp' } }
    const fetchFn = stubFetch({ ok: true, body: JSON.stringify(cfg) })
    await expect(
      loadConfigAsync('https://example.com/c.json', { fetch: fetchFn })
    ).resolves.toEqual(cfg)
  })

  it('reports HTTP errors as ConfigError', async () => {
    const fetchFn = stubFetch({ ok: false, status: 404, statusText: 'Not Found' })
    await expect(
      loadConfigAsync('https://example.com/missing.json', { fetch: fetchFn })
    ).rejects.toThrow(/HTTP 404 Not Found/)
  })

  it('wraps fetch failures as ConfigError', async () => {
    function fetchFn() { return Promise.reject(new Error('ECONNREFUSED')) }
    /** @type {unknown} */
    let caught
    try {
      await loadConfigAsync('https://example.com/c.json', { fetch: /** @type {any} */ (fetchFn) })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect(/** @type {Error} */ (caught).message).toMatch(/failed to fetch.*ECONNREFUSED/)
  })

  it('reports JSON parse errors with the URL as source', async () => {
    const fetchFn = stubFetch({ ok: true, body: '{not json' })
    await expect(
      loadConfigAsync('https://example.com/c.json', { fetch: fetchFn })
    ).rejects.toThrow(/invalid JSON in https:\/\/example.com\/c.json/)
  })

  it('runs schema validation on URL-fetched configs', async () => {
    const fetchFn = stubFetch({ ok: true, body: JSON.stringify({ version: 2 }) })
    await expect(
      loadConfigAsync('https://example.com/c.json', { fetch: fetchFn })
    ).rejects.toThrow(/unsupported version/)
  })
})

describe('loadConfig - gascity section', () => {
  it('accepts an empty gascity array', () => {
    const p = writeJson('gascity-empty.json', { version: 1, gascity: [] })
    expect(loadConfig(p)).toEqual({ version: 1, gascity: [] })
  })

  it('accepts a fully specified city entry', () => {
    const cfg = {
      version: 1,
      gascity: [
        {
          name: 'hyptown',
          api_url: 'http://127.0.0.1:8372',
          include_templates: ['desktop/*'],
          exclude_templates: ['desktop/witness'],
        },
      ],
    }
    const p = writeJson('gascity-ok.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('rejects a non-array gascity', () => {
    const p = writeJson('gascity-obj.json', { version: 1, gascity: { name: 'h' } })
    expect(() => loadConfig(p)).toThrow(/\/gascity.*must be an array/)
  })

  it('rejects a missing name', () => {
    const p = writeJson('gascity-no-name.json', {
      version: 1,
      gascity: [{ api_url: 'http://h' }],
    })
    expect(() => loadConfig(p)).toThrow(/\/gascity\/0\/name.*non-empty string/)
  })

  it('rejects a missing api_url', () => {
    const p = writeJson('gascity-no-url.json', {
      version: 1,
      gascity: [{ name: 'h' }],
    })
    expect(() => loadConfig(p)).toThrow(/\/gascity\/0\/api_url.*non-empty string/)
  })

  it('rejects a non-http api_url', () => {
    const p = writeJson('gascity-bad-url.json', {
      version: 1,
      gascity: [{ name: 'h', api_url: 'ftp://example' }],
    })
    expect(() => loadConfig(p)).toThrow(/\/gascity\/0\/api_url.*http\(s\) URL/)
  })

  it('rejects duplicate city names', () => {
    const p = writeJson('gascity-dup.json', {
      version: 1,
      gascity: [
        { name: 'h', api_url: 'http://a' },
        { name: 'h', api_url: 'http://b' },
      ],
    })
    expect(() => loadConfig(p)).toThrow(/duplicate gascity name "h"/)
  })

  it('rejects unknown keys inside a city entry', () => {
    const p = writeJson('gascity-unknown.json', {
      version: 1,
      gascity: [{ name: 'h', api_url: 'http://h', surprise: true }],
    })
    expect(() => loadConfig(p)).toThrow(/\/gascity\/0\/surprise.*unknown key/)
  })

  it('rejects non-string entries in include_templates', () => {
    const p = writeJson('gascity-bad-include.json', {
      version: 1,
      gascity: [{ name: 'h', api_url: 'http://h', include_templates: ['ok', 5] }],
    })
    expect(() => loadConfig(p)).toThrow(/\/gascity\/0\/include_templates\/1.*non-empty string/)
  })

  it('rejects a non-array exclude_templates', () => {
    const p = writeJson('gascity-bad-exclude.json', {
      version: 1,
      gascity: [{ name: 'h', api_url: 'http://h', exclude_templates: 'desktop/x' }],
    })
    expect(() => loadConfig(p)).toThrow(/\/gascity\/0\/exclude_templates.*array of strings/)
  })
})
