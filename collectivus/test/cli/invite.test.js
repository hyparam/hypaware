import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adminConfigPath } from '../../src/cli/common.js'
import {
  parseDurationSeconds,
  parseInviteArgs,
  runInvite,
  validateInviteResponse,
} from '../../src/cli/invite.js'

/**
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
 * @param {{
 *   status: number,
 *   body?: unknown,
 *   headers?: Record<string, string>,
 *   rawBody?: string,
 * }} init
 * @returns {Response}
 */
function makeResponse(init) {
  const headers = new Headers(init.headers ?? {})
  if (!headers.has('content-type') && (init.body !== undefined || init.rawBody !== undefined)) {
    headers.set('content-type', 'application/json')
  }
  const body = init.rawBody !== undefined ? init.rawBody : init.body !== undefined ? JSON.stringify(init.body) : null
  return new Response(body, { status: init.status, headers })
}

const SAMPLE_INVITE = {
  joinCode: 'ABCDEFGHJK',
  expiresAt: '2030-01-01T00:00:00.000Z',
  maxUses: 5,
  gatewayPrefix: 'acme',
  rendezvousUrl: 'https://rendezvous.example',
  command: 'npx collectivus join \'ABCDEFGHJK\' --rendezvous \'https://rendezvous.example\'',
}

/** @type {string} */
let tmpDir
beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-invite-cli-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseDurationSeconds', function() {
  it('parses seconds, minutes, hours, days, weeks', function() {
    expect(parseDurationSeconds('30s')).toBe(30)
    expect(parseDurationSeconds('5m')).toBe(5 * 60)
    expect(parseDurationSeconds('2h')).toBe(2 * 60 * 60)
    expect(parseDurationSeconds('14d')).toBe(14 * 24 * 60 * 60)
    expect(parseDurationSeconds('2w')).toBe(2 * 7 * 24 * 60 * 60)
  })

  it('rejects bad shapes', function() {
    expect(parseDurationSeconds('')).toBeUndefined()
    expect(parseDurationSeconds('abc')).toBeUndefined()
    expect(parseDurationSeconds('5')).toBeUndefined()
    expect(parseDurationSeconds('5x')).toBeUndefined()
    expect(parseDurationSeconds('0d')).toBeUndefined()
    expect(parseDurationSeconds('-5d')).toBeUndefined()
    expect(parseDurationSeconds('5 d')).toBeUndefined()
    expect(parseDurationSeconds('5dd')).toBeUndefined()
  })
})

describe('parseInviteArgs', function() {
  it('shows help for top-level --help / -h', function() {
    expect(parseInviteArgs(['--help']).kind).toBe('help')
    expect(parseInviteArgs(['-h']).kind).toBe('help')
  })

  it('errors when no subcommand is given', function() {
    expect(parseInviteArgs([])).toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('rejects unknown subcommands', function() {
    expect(parseInviteArgs(['rotate'])).toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('parses bare create', function() {
    expect(parseInviteArgs(['create'])).toMatchObject({
      kind: 'create',
      adminUrl: undefined,
      adminToken: undefined,
      gatewayPrefix: undefined,
      maxUses: undefined,
      ttlSeconds: undefined,
      displayName: undefined,
      json: false,
    })
  })

  it('parses every flag in long form', function() {
    expect(parseInviteArgs([
      'create',
      '--admin-url', 'https://central.example',
      '--admin-token', 'TOK',
      '--gateway-prefix', 'acme',
      '--max-uses', '5',
      '--ttl-seconds', '60',
      '--display-name', 'Team',
      '--json',
    ])).toMatchObject({
      kind: 'create',
      adminUrl: 'https://central.example',
      adminToken: 'TOK',
      gatewayPrefix: 'acme',
      maxUses: 5,
      ttlSeconds: 60,
      displayName: 'Team',
      json: true,
    })
  })

  it('supports --flag=value form', function() {
    expect(parseInviteArgs([
      'create',
      '--admin-url=https://central.example',
      '--admin-token=TOK',
      '--max-uses=3',
    ])).toMatchObject({
      kind: 'create',
      adminUrl: 'https://central.example',
      adminToken: 'TOK',
      maxUses: 3,
    })
  })

  it('--expires-in converts to ttlSeconds', function() {
    expect(parseInviteArgs(['create', '--expires-in', '14d'])).toMatchObject({
      kind: 'create',
      ttlSeconds: 14 * 24 * 60 * 60,
    })
  })

  it('--expires-in and --ttl-seconds are mutually exclusive', function() {
    expect(parseInviteArgs(['create', '--expires-in', '1d', '--ttl-seconds', '60']))
      .toMatchObject({ kind: 'error', exitCode: 2, message: expect.stringMatching(/mutually exclusive/) })
  })

  it('rejects an invalid --gateway-prefix', function() {
    expect(parseInviteArgs(['create', '--gateway-prefix', 'has/slash']))
      .toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseInviteArgs(['create', '--gateway-prefix', '.hidden']))
      .toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('rejects non-positive --max-uses', function() {
    expect(parseInviteArgs(['create', '--max-uses', '0'])).toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseInviteArgs(['create', '--max-uses', '-1'])).toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseInviteArgs(['create', '--max-uses', 'abc'])).toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('rejects non-positive --ttl-seconds', function() {
    expect(parseInviteArgs(['create', '--ttl-seconds', '0'])).toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseInviteArgs(['create', '--ttl-seconds', 'abc'])).toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('rejects malformed --expires-in', function() {
    expect(parseInviteArgs(['create', '--expires-in', '5'])).toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseInviteArgs(['create', '--expires-in', 'next-week'])).toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('rejects empty values for flag args', function() {
    expect(parseInviteArgs(['create', '--admin-url'])).toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseInviteArgs(['create', '--admin-token'])).toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseInviteArgs(['create', '--display-name', ''])).toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('rejects unknown arguments', function() {
    expect(parseInviteArgs(['create', '--mystery'])).toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseInviteArgs(['create', 'positional'])).toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('shows per-verb help', function() {
    expect(parseInviteArgs(['create', '--help']).kind).toBe('create-help')
    expect(parseInviteArgs(['create', '-h']).kind).toBe('create-help')
  })

  describe('legacy flags', function() {
    it.each(['--aws-stack', '--function-name', '--region', '--profile'])(
      'rejects legacy flag %s with a migration hint',
      function(flag) {
        const result = parseInviteArgs(['create', flag, 'value'])
        expect(result).toMatchObject({ kind: 'error', exitCode: 2 })
        if (result.kind !== 'error') throw new Error('expected error')
        expect(result.message).toContain(flag)
        expect(result.message).toContain('ctvs admin configure')
        expect(result.message).toMatch(/no longer supported/)
      }
    )

    it('rejects legacy flags in --flag=value form too', function() {
      const result = parseInviteArgs(['create', '--aws-stack=collectivus'])
      expect(result).toMatchObject({ kind: 'error', exitCode: 2 })
      if (result.kind !== 'error') throw new Error('expected error')
      expect(result.message).toContain('--aws-stack')
    })
  })
})

describe('validateInviteResponse', function() {
  it('accepts the spec shape', function() {
    expect(validateInviteResponse(SAMPLE_INVITE)).toEqual(SAMPLE_INVITE)
  })

  it('rejects non-object bodies', function() {
    expect(() => validateInviteResponse(null)).toThrow(/not a JSON object/)
    expect(() => validateInviteResponse('string')).toThrow(/not a JSON object/)
    expect(() => validateInviteResponse(42)).toThrow(/not a JSON object/)
  })

  it('rejects missing or empty fields', function() {
    expect(() => validateInviteResponse({ ...SAMPLE_INVITE, joinCode: '' })).toThrow(/joinCode/)
    expect(() => validateInviteResponse({ ...SAMPLE_INVITE, joinCode: 7 })).toThrow(/joinCode/)
    expect(() => validateInviteResponse({ ...SAMPLE_INVITE, expiresAt: '' })).toThrow(/expiresAt/)
    expect(() => validateInviteResponse({ ...SAMPLE_INVITE, expiresAt: 'not-a-date' })).toThrow(/expiresAt/)
    expect(() => validateInviteResponse({ ...SAMPLE_INVITE, maxUses: '5' })).toThrow(/maxUses/)
    expect(() => validateInviteResponse({ ...SAMPLE_INVITE, maxUses: 0 })).toThrow(/maxUses/)
    expect(() => validateInviteResponse({ ...SAMPLE_INVITE, gatewayPrefix: 'has/slash' })).toThrow(/gatewayPrefix/)
    expect(() => validateInviteResponse({ ...SAMPLE_INVITE, rendezvousUrl: 'ftp://nope' })).toThrow(/rendezvousUrl/)
    expect(() => validateInviteResponse({ ...SAMPLE_INVITE, command: '' })).toThrow(/command/)
  })
})

describe('runInvite: happy path', function() {
  it('prints human output, includes only set fields in the request, and stamps the auth header', async function() {
    const stdout = memo()
    const stderr = memo()
    /** @type {{ url: string, init?: RequestInit }[]} */
    const calls = []
    const code = await runInvite(['create', '--max-uses', '3', '--expires-in', '1h'], {
      stdout,
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => ({ central_url: 'https://central.example/', admin_token: 'super-secret-token' }),
      fetchFn: /** @type {typeof fetch} */ async (url, init) => {
        calls.push({ url: String(url), init })
        return makeResponse({ status: 200, body: SAMPLE_INVITE })
      },
    })
    expect(code).toBe(0)
    expect(stderr.value()).toBe('')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://central.example/v1/admin/invites')
    expect(calls[0].init?.method).toBe('POST')
    const headers = new Headers(/** @type {HeadersInit} */ calls[0].init?.headers)
    expect(headers.get('authorization')).toBe('Bearer super-secret-token')
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ maxUses: 3, ttlSeconds: 60 * 60 })

    const out = stdout.value()
    expect(out).toContain(SAMPLE_INVITE.joinCode)
    expect(out).toContain(SAMPLE_INVITE.expiresAt)
    expect(out).toContain(SAMPLE_INVITE.command)
    // The token must never reach stdout.
    expect(out).not.toContain('super-secret-token')
  })

  it('emits JSON output with --json and never leaks the token', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runInvite(['create', '--json'], {
      stdout,
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => ({ central_url: 'https://central.example', admin_token: 'super-secret-token' }),
      fetchFn: /** @type {typeof fetch} */ async () => makeResponse({ status: 200, body: SAMPLE_INVITE }),
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.value())
    expect(parsed).toEqual(SAMPLE_INVITE)
    expect(stdout.value()).not.toContain('super-secret-token')
  })

  it('strips trailing slashes from --admin-url before composing the endpoint', async function() {
    /** @type {string[]} */
    const urls = []
    const code = await runInvite(['create', '--admin-url', 'https://central.example///', '--admin-token', 'tok'], {
      stdout: memo(),
      stderr: memo(),
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async (url) => {
        urls.push(String(url))
        return makeResponse({ status: 200, body: SAMPLE_INVITE })
      },
    })
    expect(code).toBe(0)
    expect(urls).toEqual(['https://central.example/v1/admin/invites'])
  })

  it('sends gatewayPrefix and displayName when provided', async function() {
    /** @type {Record<string, unknown> | undefined} */
    let sent
    const code = await runInvite([
      'create',
      '--admin-url', 'https://central.example',
      '--admin-token', 'tok',
      '--gateway-prefix', 'acme',
      '--display-name', 'team-2',
    ], {
      stdout: memo(),
      stderr: memo(),
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async (_url, init) => {
        sent = JSON.parse(String(init?.body))
        return makeResponse({ status: 200, body: SAMPLE_INVITE })
      },
    })
    expect(code).toBe(0)
    expect(sent).toEqual({ gatewayPrefix: 'acme', displayName: 'team-2' })
  })
})

describe('runInvite: configuration precedence', function() {
  it('flags override env, env overrides file', async function() {
    /** @type {Headers | undefined} */
    let headers
    /** @type {string | undefined} */
    let endpoint
    const code = await runInvite([
      'create',
      '--admin-url', 'https://from-flag.example',
      '--admin-token', 'flag-token',
    ], {
      stdout: memo(),
      stderr: memo(),
      env: { COLLECTIVUS_ADMIN_URL: 'https://from-env.example', COLLECTIVUS_ADMIN_TOKEN: 'env-token' },
      homeDir: tmpDir,
      readAdminConfig: () => ({ central_url: 'https://from-file.example', admin_token: 'file-token' }),
      fetchFn: /** @type {typeof fetch} */ async (url, init) => {
        endpoint = String(url)
        headers = new Headers(/** @type {HeadersInit} */ init?.headers)
        return makeResponse({ status: 200, body: SAMPLE_INVITE })
      },
    })
    expect(code).toBe(0)
    expect(endpoint).toBe('https://from-flag.example/v1/admin/invites')
    expect(headers?.get('authorization')).toBe('Bearer flag-token')
  })

  it('env beats file when no flag is given', async function() {
    /** @type {Headers | undefined} */
    let headers
    /** @type {string | undefined} */
    let endpoint
    const code = await runInvite(['create'], {
      stdout: memo(),
      stderr: memo(),
      env: { COLLECTIVUS_ADMIN_URL: 'https://from-env.example', COLLECTIVUS_ADMIN_TOKEN: 'env-token' },
      homeDir: tmpDir,
      readAdminConfig: () => ({ central_url: 'https://from-file.example', admin_token: 'file-token' }),
      fetchFn: /** @type {typeof fetch} */ async (url, init) => {
        endpoint = String(url)
        headers = new Headers(/** @type {HeadersInit} */ init?.headers)
        return makeResponse({ status: 200, body: SAMPLE_INVITE })
      },
    })
    expect(code).toBe(0)
    expect(endpoint).toBe('https://from-env.example/v1/admin/invites')
    expect(headers?.get('authorization')).toBe('Bearer env-token')
  })

  it('falls back to the saved admin config file when nothing else is set', async function() {
    /** @type {Headers | undefined} */
    let headers
    /** @type {string | undefined} */
    let endpoint
    const code = await runInvite(['create'], {
      stdout: memo(),
      stderr: memo(),
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => ({ central_url: 'https://from-file.example', admin_token: 'file-token' }),
      fetchFn: /** @type {typeof fetch} */ async (url, init) => {
        endpoint = String(url)
        headers = new Headers(/** @type {HeadersInit} */ init?.headers)
        return makeResponse({ status: 200, body: SAMPLE_INVITE })
      },
    })
    expect(code).toBe(0)
    expect(endpoint).toBe('https://from-file.example/v1/admin/invites')
    expect(headers?.get('authorization')).toBe('Bearer file-token')
  })

  it('resolves the admin config path via homeDir when no override is given', async function() {
    // The default helper reads ~/.hyp/collectivus/admin.json under hooks.homeDir;
    // we expose that path here to confirm the wiring without faking the helper.
    expect(adminConfigPath(tmpDir).endsWith(path.join('.hyp', 'collectivus', 'admin.json'))).toBe(true)
  })

  it('reports a clear error when nothing supplies the admin URL', async function() {
    const stderr = memo()
    const code = await runInvite(['create'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => {
        throw new Error('fetch should not be called when admin config is missing')
      },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/no central admin URL/)
    expect(stderr.value()).toMatch(/ctvs admin configure/)
  })

  it('reports a clear error when only the URL is configured but no token', async function() {
    const stderr = memo()
    const code = await runInvite(['create'], {
      stdout: memo(),
      stderr,
      env: { COLLECTIVUS_ADMIN_URL: 'https://central.example' },
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => {
        throw new Error('fetch should not be called when token is missing')
      },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/no admin token/)
  })

  it('rejects non-http admin URLs without making a request', async function() {
    const stderr = memo()
    const code = await runInvite(['create', '--admin-url', 'file:///etc/passwd', '--admin-token', 'tok'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => {
        throw new Error('fetch should not be called')
      },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/http or https/)
  })

  it('surfaces an error reading a malformed admin config file', async function() {
    const stderr = memo()
    const code = await runInvite(['create'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => { throw new Error('admin config is not valid JSON: unexpected token') },
      fetchFn: /** @type {typeof fetch} */ async () => {
        throw new Error('fetch should not be called when config read fails')
      },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/not valid JSON/)
  })
})

describe('runInvite: HTTP error status handling', function() {
  it('401 surfaces a clear unauthorized message that points at admin status / env var', async function() {
    const stderr = memo()
    const code = await runInvite(['create', '--admin-url', 'https://central.example', '--admin-token', 'tok'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => makeResponse({ status: 401, body: { error: 'bad token' } }),
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/unauthorized/)
    expect(stderr.value()).toMatch(/ctvs admin status/)
    expect(stderr.value()).toMatch(/COLLECTIVUS_ADMIN_TOKEN/)
  })

  it('400 prints the server-supplied error message', async function() {
    const stderr = memo()
    const code = await runInvite(['create', '--admin-url', 'https://central.example', '--admin-token', 'tok'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => makeResponse({
        status: 400,
        body: { error: 'gateway prefix required: configure server.enrollment.gateway_prefix' },
      }),
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/gateway prefix required/)
  })

  it('429 reports the retry-after seconds when provided', async function() {
    const stderr = memo()
    const code = await runInvite(['create', '--admin-url', 'https://central.example', '--admin-token', 'tok'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => makeResponse({
        status: 429,
        headers: { 'retry-after': '30' },
        body: { error: 'too many invites' },
      }),
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/rate limited; retry in 30 seconds/)
  })

  it('429 without retry-after still produces a rate-limited message', async function() {
    const stderr = memo()
    const code = await runInvite(['create', '--admin-url', 'https://central.example', '--admin-token', 'tok'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => makeResponse({ status: 429 }),
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/rate limited/)
  })

  it('5xx prints status code and any error body', async function() {
    const stderr = memo()
    const code = await runInvite(['create', '--admin-url', 'https://central.example', '--admin-token', 'tok'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => makeResponse({
        status: 503,
        body: { error: 'rendezvous unavailable' },
      }),
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/503/)
    expect(stderr.value()).toMatch(/rendezvous unavailable/)
  })

  it('200 with invalid JSON body fails loudly', async function() {
    const stderr = memo()
    const code = await runInvite(['create', '--admin-url', 'https://central.example', '--admin-token', 'tok'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => makeResponse({ status: 200, rawBody: 'not-json' }),
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/invalid JSON/)
  })

  it('200 with malformed invite shape fails loudly', async function() {
    const stderr = memo()
    const code = await runInvite(['create', '--admin-url', 'https://central.example', '--admin-token', 'tok'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => makeResponse({
        status: 200,
        body: { joinCode: 'X', maxUses: 1, gatewayPrefix: 'acme', rendezvousUrl: 'https://r', command: 'cmd' },
      }),
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/invalid invite response/)
  })

  it('network errors surface but never include the token', async function() {
    const stderr = memo()
    const code = await runInvite(['create', '--admin-url', 'https://central.example', '--admin-token', 'super-secret-token'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => { throw new Error('connect ECONNREFUSED') },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to reach admin API/)
    expect(stderr.value()).toMatch(/ECONNREFUSED/)
    expect(stderr.value()).not.toContain('super-secret-token')
  })
})

describe('runInvite: top-level concerns', function() {
  it('--help prints usage and exits 0', async function() {
    const stdout = memo()
    const code = await runInvite(['--help'], { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:\s+ctvs invite create/)
  })

  it('legacy --aws-stack flag is rejected at the CLI level with a migration hint', async function() {
    const stderr = memo()
    const code = await runInvite(['create', '--aws-stack', 'collectivus'], {
      stdout: memo(),
      stderr,
      env: {},
      homeDir: tmpDir,
      readAdminConfig: () => undefined,
      fetchFn: /** @type {typeof fetch} */ async () => {
        throw new Error('fetch should not be called for a legacy-flag rejection')
      },
    })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/--aws-stack/)
    expect(stderr.value()).toMatch(/ctvs admin configure/)
  })
})
