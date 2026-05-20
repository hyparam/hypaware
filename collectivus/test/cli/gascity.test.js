import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  parseAttachArgs,
  parseBackfillArgs,
  parseDetachArgs,
  parseDuration,
  parseListArgs,
  parseStatusArgs,
  runAttach,
  runBackfill,
  runDetach,
  runGascity,
  runList,
  runStatus,
} from '../../src/cli/gascity.js'

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return { write: (s) => { buf += s }, value: () => buf }
}

/** @type {string} */
let dir
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctvs-gascity-cli-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * Build the per-test path bundle the subcommands use. All tmp files live
 * under one tmpdir so afterEach can remove them in a single rm.
 *
 * @returns {{ configPath: string, pidFilePath: string, statePath: string, sinkRoot: string }}
 */
function buildPaths() {
  return {
    configPath: path.join(dir, 'collectivus.json'),
    pidFilePath: path.join(dir, 'collectivus.pid'),
    statePath: path.join(dir, 'gascity-state.json'),
    sinkRoot: path.join(dir, 'sink'),
  }
}

/**
 * Write a starter collectivus config the subcommands can read. Keeps
 * matters honest with the validator (proxy/sink are required for a
 * config-loading subcommand like backfill).
 *
 * @param {string} configPath
 * @param {Record<string, unknown>} extra
 */
async function writeConfig(configPath, extra = {}) {
  const baseConfig = {
    version: 1,
    proxy: {
      listen: '127.0.0.1:8787',
      upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
    },
    sink: { type: 'file', dir: path.join(dir, 'recordings') },
    ...extra,
  }
  await fs.writeFile(configPath, JSON.stringify(baseConfig, null, 2), 'utf8')
}

describe('argument parsers', () => {
  describe('attach', () => {
    it('requires a target', () => {
      expect(parseAttachArgs([]).error).toMatch(/requires a city/)
    })
    it('parses target + --api-url', () => {
      expect(parseAttachArgs(['hyptown', '--api-url', 'http://h'])).toMatchObject({
        target: 'hyptown',
        apiUrl: 'http://h',
        noWait: false,
        help: false,
      })
    })
    it('parses a bare target and leaves apiUrl undefined for the default', () => {
      expect(parseAttachArgs(['hyptown'])).toMatchObject({
        target: 'hyptown',
        noWait: false,
        help: false,
      })
      expect(parseAttachArgs(['hyptown']).apiUrl).toBeUndefined()
    })
    it('rejects --api-url with no value', () => {
      expect(parseAttachArgs(['hy', '--api-url']).error).toMatch(/--api-url requires a value/)
    })
    it('rejects unknown flags', () => {
      expect(parseAttachArgs(['hy', '--mystery']).error).toMatch(/unknown argument/)
    })
    it('rejects extra positional args', () => {
      expect(parseAttachArgs(['hy', 'extra']).error).toMatch(/unexpected positional/)
    })
    it('--no-wait flips noWait', () => {
      expect(parseAttachArgs(['hy', '--api-url', 'http://h', '--no-wait']).noWait).toBe(true)
    })
    it('--help short-circuits', () => {
      expect(parseAttachArgs(['--help']).help).toBe(true)
    })
  })

  describe('detach', () => {
    it('requires a city', () => {
      expect(parseDetachArgs([]).error).toMatch(/requires a city/)
    })
    it('parses --config', () => {
      expect(parseDetachArgs(['hy', '--config=/tmp/c.json']).configPath).toBe('/tmp/c.json')
    })
  })

  describe('list', () => {
    it('parses --json', () => {
      expect(parseListArgs(['--json'])).toMatchObject({ json: true, help: false })
    })
    it('rejects unknown flags', () => {
      expect(parseListArgs(['--bad']).error).toMatch(/unknown argument/)
    })
  })

  describe('backfill', () => {
    it('requires a city', () => {
      expect(parseBackfillArgs([]).error).toMatch(/requires a city/)
    })
    it('parses --since and --all', () => {
      expect(parseBackfillArgs(['hy', '--since=7d', '--all'])).toMatchObject({
        city: 'hy',
        since: '7d',
        all: true,
      })
    })
    it('rejects --since with no value', () => {
      expect(parseBackfillArgs(['hy', '--since']).error).toMatch(/--since requires a duration/)
    })
  })

  describe('status', () => {
    it('parses --json', () => {
      expect(parseStatusArgs(['--json'])).toMatchObject({ json: true, help: false })
    })
  })

  describe('parseDuration', () => {
    it('handles common shapes', () => {
      expect(parseDuration('30s')).toBe(30_000)
      expect(parseDuration('5m')).toBe(300_000)
      expect(parseDuration('2h')).toBe(7_200_000)
      expect(parseDuration('1d')).toBe(86_400_000)
    })
    it('returns undefined for malformed input', () => {
      expect(parseDuration('30')).toBeUndefined()
      expect(parseDuration('foo')).toBeUndefined()
      expect(parseDuration('-1d')).toBeUndefined()
      expect(parseDuration('')).toBeUndefined()
    })
  })
})

describe('runGascity dispatch', () => {
  it('prints USAGE and exits 2 when no subcommand is given', async () => {
    const stdout = memo()
    const code = await runGascity([], { stdout, stderr: memo() })
    expect(code).toBe(2)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('prints USAGE and exits 0 for --help', async () => {
    const stdout = memo()
    const code = await runGascity(['--help'], { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('errors on unknown subcommands', async () => {
    const stderr = memo()
    const code = await runGascity(['nope'], { stdout: memo(), stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown gascity subcommand/)
  })
})

describe('runAttach', () => {
  it('appends a [[gascity]] entry by name + --api-url', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath)
    const stdout = memo()
    const code = await runAttach(
      ['hyptown', '--api-url', 'http://127.0.0.1:8372', '--no-wait', '--config', paths.configPath],
      { stdout, stderr: memo(), pidFilePath: paths.pidFilePath, statePath: paths.statePath }
    )
    expect(code).toBe(0)
    const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'))
    expect(config.gascity).toEqual([{ name: 'hyptown', api_url: 'http://127.0.0.1:8372' }])
    expect(stdout.value()).toMatch(/attached: hyptown/)
  })

  it('defaults a city-name attach to the local supervisor api url', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath)
    const code = await runAttach(
      ['hyptown', '--no-wait', '--config', paths.configPath],
      { stdout: memo(), stderr: memo(), pidFilePath: paths.pidFilePath, statePath: paths.statePath }
    )
    expect(code).toBe(0)
    const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'))
    expect(config.gascity).toEqual([{ name: 'hyptown', api_url: 'http://127.0.0.1:8372' }])
  })

  it('replaces an existing entry instead of duplicating it', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath, {
      gascity: [{ name: 'hyptown', api_url: 'http://old' }],
    })
    const code = await runAttach(
      ['hyptown', '--api-url', 'http://new', '--no-wait', '--config', paths.configPath],
      { stdout: memo(), stderr: memo(), pidFilePath: paths.pidFilePath, statePath: paths.statePath }
    )
    expect(code).toBe(0)
    const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'))
    expect(config.gascity).toEqual([{ name: 'hyptown', api_url: 'http://new' }])
  })

  it('signals the running daemon when a PID file is present', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath)
    await fs.writeFile(paths.pidFilePath, '12345\n', 'utf8')
    const signaled = vi.fn()
    const code = await runAttach(
      ['hyptown', '--api-url', 'http://h', '--no-wait', '--config', paths.configPath],
      {
        stdout: memo(), stderr: memo(),
        pidFilePath: paths.pidFilePath,
        statePath: paths.statePath,
        readPid: async () => 12345,
        signalDaemon: signaled,
      }
    )
    expect(code).toBe(0)
    expect(signaled).toHaveBeenCalledWith(12345, 'SIGHUP')
  })

  it('reports "no daemon" when the PID file is absent', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath)
    const stdout = memo()
    await runAttach(
      ['hyptown', '--api-url', 'http://h', '--no-wait', '--config', paths.configPath],
      { stdout, stderr: memo(), pidFilePath: paths.pidFilePath, statePath: paths.statePath }
    )
    expect(stdout.value()).toMatch(/No running daemon/)
  })

  it('infers name + api from a city.toml when given a directory', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath)
    const cityDir = path.join(dir, 'mycity')
    await fs.mkdir(cityDir, { recursive: true })
    await fs.writeFile(
      path.join(cityDir, 'city.toml'),
      'name = "mycity"\napi = "http://1.2.3.4:9999"\n',
      'utf8'
    )
    const code = await runAttach(
      [cityDir, '--no-wait', '--config', paths.configPath],
      { stdout: memo(), stderr: memo(), pidFilePath: paths.pidFilePath, statePath: paths.statePath }
    )
    expect(code).toBe(0)
    const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'))
    expect(config.gascity).toEqual([{ name: 'mycity', api_url: 'http://1.2.3.4:9999' }])
  })

  it('uses the local supervisor default when a city directory has no api hint', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath)
    const cityDir = path.join(dir, 'default-api-city')
    await fs.mkdir(cityDir, { recursive: true })
    await fs.writeFile(
      path.join(cityDir, 'city.toml'),
      'name = "default-api-city"\n',
      'utf8'
    )
    const code = await runAttach(
      [cityDir, '--no-wait', '--config', paths.configPath],
      { stdout: memo(), stderr: memo(), pidFilePath: paths.pidFilePath, statePath: paths.statePath }
    )
    expect(code).toBe(0)
    const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'))
    expect(config.gascity).toEqual([{ name: 'default-api-city', api_url: 'http://127.0.0.1:8372' }])
  })
})

describe('runDetach', () => {
  it('removes a matching [[gascity]] entry and signals the daemon', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath, {
      gascity: [
        { name: 'hyptown', api_url: 'http://h' },
        { name: 'other', api_url: 'http://o' },
      ],
    })
    const signaled = vi.fn()
    const stdout = memo()
    const code = await runDetach(
      ['hyptown', '--config', paths.configPath],
      {
        stdout, stderr: memo(),
        pidFilePath: paths.pidFilePath,
        readPid: async () => 12345,
        signalDaemon: signaled,
      }
    )
    expect(code).toBe(0)
    const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'))
    expect(config.gascity).toEqual([{ name: 'other', api_url: 'http://o' }])
    expect(signaled).toHaveBeenCalledWith(12345, 'SIGHUP')
    expect(stdout.value()).toMatch(/detached: hyptown/)
  })

  it('removes the gascity key entirely when last entry is detached', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath, {
      gascity: [{ name: 'hyptown', api_url: 'http://h' }],
    })
    await runDetach(
      ['hyptown', '--config', paths.configPath],
      { stdout: memo(), stderr: memo(), pidFilePath: paths.pidFilePath }
    )
    const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'))
    expect(config.gascity).toBeUndefined()
  })

  it('warns when the named city is not present', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath, {
      gascity: [{ name: 'other', api_url: 'http://o' }],
    })
    const stderr = memo()
    const code = await runDetach(
      ['ghost', '--config', paths.configPath],
      { stdout: memo(), stderr, pidFilePath: paths.pidFilePath }
    )
    expect(code).toBe(0)
    expect(stderr.value()).toMatch(/no \[\[gascity\]\] entry named "ghost"/)
  })
})

describe('runList', () => {
  it('reports an empty state when no daemon is running', async () => {
    const paths = buildPaths()
    const stdout = memo()
    const code = await runList([], { stdout, stderr: memo(), statePath: paths.statePath })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/No gascity cities attached/)
  })

  it('renders --json with default skeleton when state is missing', async () => {
    const paths = buildPaths()
    const stdout = memo()
    await runList(['--json'], { stdout, stderr: memo(), statePath: paths.statePath })
    const out = JSON.parse(stdout.value())
    expect(out).toMatchObject({ schema_version: 0, cities: [] })
  })

  it('renders the per-session table when state has cities', async () => {
    const paths = buildPaths()
    const snap = {
      schema_version: 1,
      updated_at: '2026-05-14T10:00:00Z',
      cities: [
        {
          name: 'hyptown',
          api_url: 'http://127.0.0.1:8372',
          lifecycle_connected: true,
          frames_total: 10,
          sessions: [
            {
              sessionId: 'hy-jw8sm',
              template: 'desktop/hypcity.refinery',
              state: 'active',
              frames: 7,
              started_at: '2026-05-14T09:55:00Z',
              last_frame_at: '2026-05-14T09:59:55Z',
            },
          ],
        },
      ],
    }
    await fs.writeFile(paths.statePath, JSON.stringify(snap), 'utf8')
    const stdout = memo()
    await runList([], {
      stdout, stderr: memo(),
      statePath: paths.statePath,
      now: () => new Date('2026-05-14T10:00:00Z'),
    })
    const out = stdout.value()
    expect(out).toMatch(/CITY\s+SESSION/)
    expect(out).toMatch(/hyptown\s+hy-jw8sm/)
    expect(out).toMatch(/active\s+7/)
  })
})

describe('runBackfill', () => {
  it('errors when the named city is not in the config', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath, {
      gascity: [{ name: 'other', api_url: 'http://o' }],
    })
    const stderr = memo()
    const code = await runBackfill(['hyptown', '--config', paths.configPath], {
      stdout: memo(), stderr,
      sinkRoot: paths.sinkRoot,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/no \[\[gascity\]\] entry named "hyptown"/)
  })

  it('exits cleanly when no cursor files exist', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath, {
      gascity: [{ name: 'hyptown', api_url: 'http://127.0.0.1:8372' }],
    })
    const stdout = memo()
    const code = await runBackfill(['hyptown', '--config', paths.configPath], {
      stdout, stderr: memo(),
      sinkRoot: paths.sinkRoot,
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/0 attempted, 0 frames, 0 failed, 0 skipped/)
  })

  it('walks each non-retired cursor with a transcript fetch', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath, {
      gascity: [{ name: 'hyptown', api_url: 'http://127.0.0.1:8372' }],
    })
    const cursorsDir = path.join(paths.sinkRoot, '.cursors', 'hyptown')
    await fs.mkdir(cursorsDir, { recursive: true })
    await fs.writeFile(
      path.join(cursorsDir, 'session-a.json'),
      JSON.stringify({ last_uuid: 'u1', retired: false })
    )
    await fs.writeFile(
      path.join(cursorsDir, 'session-b.json'),
      JSON.stringify({ last_uuid: 'u2', retired: true })
    )
    /** @type {string[]} */
    const seenUrls = []
    const fetchFn = vi.fn(async (/** @type {string} */ url) => {
      seenUrls.push(url)
      return new Response(JSON.stringify([
        { uuid: 'frame-1', provider: 'claude' },
      ]), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const stdout = memo()
    const stderr = memo()
    const code = await runBackfill(['hyptown', '--config', paths.configPath], {
      stdout, stderr,
      sinkRoot: paths.sinkRoot,
      fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)),
    })
    expect(code, `stdout: ${stdout.value()}\nstderr: ${stderr.value()}`).toBe(0)
    // Only session-a is non-retired
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(seenUrls[0]).toMatch(/session-a/)
    expect(stdout.value()).toMatch(/1 attempted/)
  })

  it('with --all discovers supervisor sessions and replays full transcripts', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath, {
      gascity: [{ name: 'hyptown', api_url: 'http://127.0.0.1:8372' }],
    })
    /** @type {string[]} */
    const seenUrls = []
    const fetchFn = vi.fn(async (/** @type {string} */ url) => {
      seenUrls.push(url)
      if (url.includes('/sessions?state=all')) {
        return new Response(JSON.stringify({
          items: [
            { id: 'session-a', state: 'stopped' },
            { id: 'te-b', alias: 'rig/gastown.worker', template: 'rig/gastown.worker', state: 'active' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('[]', {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    const stdout = memo()
    await runBackfill(['hyptown', '--all', '--config', paths.configPath], {
      stdout, stderr: memo(),
      sinkRoot: paths.sinkRoot,
      fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)),
    })
    expect(seenUrls[0]).toBe('http://127.0.0.1:8372/v0/city/hyptown/sessions?state=all')
    expect(seenUrls.some((u) => /session\/session-a\/transcript\?format=raw$/.test(u))).toBe(true)
    expect(seenUrls.some((u) => u.includes(`/session/${encodeURIComponent('rig/gastown.worker')}/transcript?format=raw`))).toBe(true)
    expect(seenUrls.some((u) => u.includes('after='))).toBe(false)
    expect(stdout.value()).toMatch(/can take a while/)
    expect(stdout.value()).toMatch(/Discovered 2 sessions/)
  })

  it('skips sessions whose cursor is older than --since', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath, {
      gascity: [{ name: 'hyptown', api_url: 'http://127.0.0.1:8372' }],
    })
    const cursorsDir = path.join(paths.sinkRoot, '.cursors', 'hyptown')
    await fs.mkdir(cursorsDir, { recursive: true })
    const oldTs = new Date(Date.now() - 86_400_000 * 10).toISOString()
    const newTs = new Date().toISOString()
    await fs.writeFile(
      path.join(cursorsDir, 'session-old.json'),
      JSON.stringify({ last_uuid: 'u1', last_timestamp: oldTs, retired: false })
    )
    await fs.writeFile(
      path.join(cursorsDir, 'session-new.json'),
      JSON.stringify({ last_uuid: 'u2', last_timestamp: newTs, retired: false })
    )
    const fetchFn = vi.fn(async () => new Response('[]', {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const stdout = memo()
    await runBackfill(['hyptown', '--since', '1d', '--config', paths.configPath], {
      stdout, stderr: memo(),
      sinkRoot: paths.sinkRoot,
      fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)),
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(stdout.value()).toMatch(/1 attempted, 0 frames, 0 failed, 1 skipped/)
  })

  it('idempotency: a second run produces the same dispatch counts', async () => {
    const paths = buildPaths()
    await writeConfig(paths.configPath, {
      gascity: [{ name: 'hyptown', api_url: 'http://127.0.0.1:8372' }],
    })
    const cursorsDir = path.join(paths.sinkRoot, '.cursors', 'hyptown')
    await fs.mkdir(cursorsDir, { recursive: true })
    await fs.writeFile(
      path.join(cursorsDir, 'session-a.json'),
      JSON.stringify({ last_uuid: 'u1', retired: false })
    )
    /** @returns {Response} */
    function newResponse() {
      return new Response(JSON.stringify([{ uuid: 'frame-1' }]), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    const fetchFn = vi.fn(async () => newResponse())
    /** @type {string[]} */
    const outputs = []
    for (let i = 0; i < 2; i++) {
      const stdout = memo()
      await runBackfill(['hyptown', '--config', paths.configPath], {
        stdout, stderr: memo(),
        sinkRoot: paths.sinkRoot,
        fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)),
      })
      outputs.push(stdout.value())
    }
    expect(outputs[0]).toEqual(outputs[1])
  })
})

describe('runStatus', () => {
  it('reports daemon not running when state file is missing', async () => {
    const paths = buildPaths()
    const stdout = memo()
    const code = await runStatus([], { stdout, stderr: memo(), statePath: paths.statePath })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Daemon: not running/)
  })

  it('emits parseable JSON with --json', async () => {
    const paths = buildPaths()
    const snap = {
      schema_version: 1,
      updated_at: '2026-05-14T10:00:00Z',
      cities: [{
        name: 'hyptown', api_url: 'http://127.0.0.1:8372',
        lifecycle_connected: true, frames_total: 10,
        sessions: [{ sessionId: 'hy-jw8sm', state: 'active', frames: 10, started_at: '2026-05-14T09:00:00Z' }],
      }],
    }
    await fs.writeFile(paths.statePath, JSON.stringify(snap), 'utf8')
    const fetchFn = vi.fn(async () => new Response('ok', { status: 200 }))
    const stdout = memo()
    await runStatus(['--json'], {
      stdout, stderr: memo(),
      statePath: paths.statePath,
      fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)),
    })
    const parsed = JSON.parse(stdout.value())
    expect(parsed).toMatchObject({
      daemon_running: true,
      cities: [
        {
          name: 'hyptown',
          reachable: true,
          lifecycle_connected: true,
          active_sessions: 1,
          frames_total: 10,
        },
      ],
    })
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:8372/v0/city/hyptown/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('falls back to generic health probes when per-city status is absent', async () => {
    const paths = buildPaths()
    const snap = {
      schema_version: 1,
      updated_at: '2026-05-14T10:00:00Z',
      cities: [{
        name: 'hyptown', api_url: 'http://127.0.0.1:8372',
        lifecycle_connected: true, frames_total: 0, sessions: /** @type {never[]} */ ([]),
      }],
    }
    await fs.writeFile(paths.statePath, JSON.stringify(snap), 'utf8')
    const fetchFn = vi.fn(async (/** @type {string} */ url) => {
      if (url.endsWith('/v0/health')) return new Response('ok', { status: 200 })
      return new Response('not found', { status: 404 })
    })
    const stdout = memo()
    await runStatus(['--json'], {
      stdout, stderr: memo(),
      statePath: paths.statePath,
      fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)),
    })
    const parsed = JSON.parse(stdout.value())
    expect(parsed.cities[0].reachable).toBe(true)
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      'http://127.0.0.1:8372/v0/city/hyptown/status',
      'http://127.0.0.1:8372/v0/health',
    ])
  })

  it('marks unreachable cities when health probe fails', async () => {
    const paths = buildPaths()
    const snap = {
      schema_version: 1,
      updated_at: '2026-05-14T10:00:00Z',
      cities: [{
        name: 'gone', api_url: 'http://127.0.0.1:7777',
        lifecycle_connected: false, frames_total: 0, sessions: /** @type {never[]} */ ([]),
      }],
    }
    await fs.writeFile(paths.statePath, JSON.stringify(snap), 'utf8')
    const fetchFn = vi.fn(async () => { throw new Error('connect refused') })
    const stdout = memo()
    await runStatus(['--json'], {
      stdout, stderr: memo(),
      statePath: paths.statePath,
      fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchFn)),
    })
    const parsed = JSON.parse(stdout.value())
    expect(parsed.cities[0].reachable).toBe(false)
  })
})

describe('help text', () => {
  it.each([['attach'], ['detach'], ['list'], ['backfill'], ['status']])(
    'subcommand "%s" --help renders cleanly',
    async (sub) => {
      const stdout = memo()
      const code = await runGascity([sub, '--help'], { stdout, stderr: memo() })
      expect(code).toBe(0)
      expect(stdout.value()).toMatch(/Usage:/)
    }
  )
})
