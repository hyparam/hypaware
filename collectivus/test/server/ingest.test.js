import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ControlPlane } from '../../src/server/control_plane.js'
import { createConfigRegistry, deleteConfig, setConfig } from '../../src/server/config_registry.js'
import { Ingest, defaultSinkDir } from '../../src/server/ingest.js'
import { signJwt } from '../../src/server/identity.js'

/**
 * @import { ServerConfig } from '../../src/types.js'
 */

const SECRET = 'a'.repeat(32)

/**
 * @param {{ sinkDir: string }} opts
 * @returns {ServerConfig}
 */
function serverConfig(opts) {
  return {
    control_plane_listen: '127.0.0.1:0',
    identity_issuer: { secret: SECRET },
    sink_dir: opts.sinkDir,
  }
}

/**
 * @param {number} initialMs
 * @returns {{ now: () => number, advance: (ms: number) => void, set: (ms: number) => void }}
 */
function fakeClock(initialMs) {
  let t = initialMs
  return {
    now: () => t,
    advance: (ms) => { t += ms },
    set: (ms) => { t = ms },
  }
}

/**
 * Build NDJSON from row objects, terminator newline included.
 *
 * @param {object[]} rows
 * @returns {string}
 */
function ndjson(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

/**
 * @returns {object}
 */
function gatewayConfig() {
  return {
    version: 1,
    role: 'gateway',
    central_server: { url: 'https://central.example.com', identity: {} },
  }
}

describe('Ingest endpoint', () => {
  /** @type {string} */
  let dir
  /** @type {ControlPlane | undefined} */
  let plane
  /** @type {string} */
  let baseUrl

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-ingest-'))
  })
  afterEach(async () => {
    if (plane) await plane.stop()
    plane = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Boot a control plane backed by a fake clock so the daily-rolled file
   * name is deterministic. Returns the JWT for the named gateway.
   *
   * @param {{ gatewayId?: string, clockMs?: number }} [opts]
   * @returns {Promise<{ jwt: string, day: string, sinkDir: string, clock: ReturnType<typeof fakeClock>, registry: ReturnType<typeof createConfigRegistry> }>}
   */
  async function boot(opts = {}) {
    const gatewayId = opts.gatewayId ?? 'gw-1'
    const clock = fakeClock(opts.clockMs ?? Date.UTC(2026, 4, 8, 12, 0, 0))
    const registry = createConfigRegistry({ configsDir: path.join(dir, 'configs') })
    setConfig(registry, gatewayId, gatewayConfig())
    plane = new ControlPlane(serverConfig({ sinkDir: dir }), { now: clock.now, configRegistry: registry })
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    baseUrl = `http://127.0.0.1:${addr.port}`
    const jwt = signJwt({ gatewayId, ttlSeconds: 3600, secret: SECRET, now: clock.now })
    const day = new Date(clock.now()).toISOString().slice(0, 10)
    return { jwt, day, sinkDir: dir, clock, registry }
  }

  it('persists 100 NDJSON rows and tags each with `_ingest`', async () => {
    const { jwt, day } = await boot({ gatewayId: 'gw-prod-1' })
    const rows = Array.from({ length: 100 }, (_, i) => ({ i, body: `row-${i}` }))
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/x-ndjson',
      },
      body: ndjson(rows),
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: 100 })

    const file = path.join(dir, 'gw-prod-1', 'logs', `${day}.jsonl`)
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
    expect(lines.length).toBe(100)
    for (let i = 0; i < 100; i++) {
      const parsed = JSON.parse(lines[i])
      expect(parsed.i).toBe(i)
      expect(parsed.body).toBe(`row-${i}`)
      expect(parsed._ingest.gateway_id).toBe('gw-prod-1')
      expect(typeof parsed._ingest.received_at).toBe('string')
      // received_at is the same wall-clock for an entire batch.
      expect(parsed._ingest.received_at).toBe(lines.map((l) => JSON.parse(l)._ingest.received_at)[0])
    }
  })

  it('routes concurrent posts from two gateways into separate directories', async () => {
    const { jwt: jwtA, day, registry } = await boot({ gatewayId: 'gw-a' })
    const planeA = plane
    if (!planeA) throw new Error('unreachable')

    // Mint a second JWT for a different gatewayId on the same plane — both
    // posts hit the same listener but write to disjoint paths.
    setConfig(registry, 'gw-b', gatewayConfig())
    const jwtB = signJwt({ gatewayId: 'gw-b', ttlSeconds: 3600, secret: SECRET, now: planeA.now })

    /**
     * @param {string} jwt
     * @param {string} tag
     * @returns {Promise<Response>}
     */
    function post(jwt, tag) {
      return fetch(`${baseUrl}/v1/ingest/traces`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
        body: ndjson([{ tag, n: 1 }, { tag, n: 2 }]),
      })
    }

    const [resA, resB] = await Promise.all([post(jwtA, 'a'), post(jwtB, 'b')])
    expect(resA.status).toBe(202)
    expect(resB.status).toBe(202)

    const fileA = path.join(dir, 'gw-a', 'traces', `${day}.jsonl`)
    const fileB = path.join(dir, 'gw-b', 'traces', `${day}.jsonl`)
    const linesA = fs.readFileSync(fileA, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    const linesB = fs.readFileSync(fileB, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(linesA.length).toBe(2)
    expect(linesB.length).toBe(2)
    expect(linesA.every((r) => r._ingest.gateway_id === 'gw-a' && r.tag === 'a')).toBe(true)
    expect(linesB.every((r) => r._ingest.gateway_id === 'gw-b' && r.tag === 'b')).toBe(true)
  })

  it('serializes concurrent batches from one gateway to the same file without interleaving', async () => {
    const { jwt, day } = await boot({ gatewayId: 'gw-conc' })
    // Each batch sends 50 rows uniquely tagged so we can detect interleave.
    const batchA = Array.from({ length: 50 }, (_, i) => ({ batch: 'a', i }))
    const batchB = Array.from({ length: 50 }, (_, i) => ({ batch: 'b', i }))

    /**
     * @param {object[]} rows
     * @returns {Promise<Response>}
     */
    function post(rows) {
      return fetch(`${baseUrl}/v1/ingest/logs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
        body: ndjson(rows),
      })
    }

    const [resA, resB] = await Promise.all([post(batchA), post(batchB)])
    expect(resA.status).toBe(202)
    expect(resB.status).toBe(202)

    const file = path.join(dir, 'gw-conc', 'logs', `${day}.jsonl`)
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines.length).toBe(100)
    // First 50 lines must all share one batch tag, last 50 the other —
    // either order is valid, but a batch must appear contiguously.
    const firstBatch = lines[0].batch
    const split = lines.findIndex((r) => r.batch !== firstBatch)
    expect(split).toBe(50)
    expect(lines.slice(0, 50).every((r) => r.batch === firstBatch)).toBe(true)
    expect(lines.slice(50).every((r) => r.batch !== firstBatch)).toBe(true)
  })

  it('accepts email-shaped gateway_ids and writes under that literal directory name', async () => {
    const { jwt, day } = await boot({ gatewayId: 'james.smith@acme.com' })
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ msg: 'hello' }]),
    })
    expect(res.status).toBe(202)

    const file = path.join(dir, 'james.smith@acme.com', 'logs', `${day}.jsonl`)
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]._ingest.gateway_id).toBe('james.smith@acme.com')
  })

  it('rejects ingest after the gateway config is deleted', async () => {
    const { jwt, registry } = await boot({ gatewayId: 'gw-offboarded' })
    expect(deleteConfig(registry, 'gw-offboarded')).toBe(true)

    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ msg: 'hello' }]),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: 'unauthorized',
      reason: 'no config registered for this gateway',
    })
  })

  it('rejects gateway_ids containing path-traversal characters', async () => {
    // Mint a JWT whose `sub` claim has a `/`. The control-plane minter would
    // never produce this, but a leaked secret could — defense-in-depth.
    const clock = fakeClock(Date.UTC(2026, 4, 8, 12, 0, 0))
    plane = new ControlPlane(serverConfig({ sinkDir: dir }), { now: clock.now })
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    baseUrl = `http://127.0.0.1:${addr.port}`
    const jwt = signJwt({ gatewayId: 'gw/../escape', ttlSeconds: 3600, secret: SECRET, now: clock.now })

    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ msg: 'hello' }]),
    })
    expect(res.status).toBe(500)
  })

  it('returns 400 with `accepted: 49, rejected_at_line: 50` on a malformed line', async () => {
    const { jwt, day } = await boot({ gatewayId: 'gw-1' })
    // 49 valid rows, then a non-JSON line, then more valid rows we expect
    // never reach disk because parsing stops at the first failure.
    const goodRows = Array.from({ length: 49 }, (_, i) => JSON.stringify({ i }))
    const trailing = Array.from({ length: 5 }, (_, i) => JSON.stringify({ trailing: i }))
    const body = goodRows.join('\n') + '\nthis-is-not-json\n' + trailing.join('\n') + '\n'

    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body,
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.accepted).toBe(49)
    expect(data.rejected_at_line).toBe(50)
    expect(typeof data.error).toBe('string')

    // The 49 valid rows that came first must be persisted.
    const file = path.join(dir, 'gw-1', 'logs', `${day}.jsonl`)
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines.length).toBe(49)
    expect(lines.every((r, i) => r.i === i)).toBe(true)
  })

  it('returns 400 with `accepted: 0` when the very first line is malformed', async () => {
    const { jwt } = await boot()
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: 'not-json\n',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ accepted: 0, rejected_at_line: 1 })
    // No file should have been created on this 0-row path.
    const dirExists = fs.existsSync(path.join(dir, 'gw-1', 'logs'))
    expect(dirExists).toBe(false)
  })

  it('returns 400 when a row parses but is not an object', async () => {
    const { jwt } = await boot()
    const body = JSON.stringify({ ok: true }) + '\n["not","an","object"]\n'
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body,
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.accepted).toBe(1)
    expect(data.rejected_at_line).toBe(2)
    expect(data.error).toMatch(/not a JSON object/)
  })

  it('returns 401 when no Authorization header is sent', async () => {
    await boot()
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(401)
    // No file should have been created — the auth check runs before any
    // ingest path resolution.
    expect(fs.existsSync(path.join(dir, 'gw-1'))).toBe(false)
  })

  it('returns 401 when the JWT is invalid', async () => {
    await boot()
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-real-jwt', 'content-type': 'application/x-ndjson' },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(401)
  })

  it('derives gateway_id from the JWT — request body fields cannot override it', async () => {
    const { jwt, day } = await boot({ gatewayId: 'gw-real' })
    // Try to spoof a different gateway by stuffing both `_ingest` on the
    // row and a sibling field that LOOKS like an attribution. Neither
    // should change the on-disk path or the persisted `_ingest.gateway_id`.
    const row = {
      hijack: 'yes',
      _ingest: { gateway_id: 'gw-victim', received_at: '1970-01-01T00:00:00Z' },
      gateway_id: 'gw-victim',
    }
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([row]),
    })
    expect(res.status).toBe(202)

    // Victim directory must not exist.
    expect(fs.existsSync(path.join(dir, 'gw-victim'))).toBe(false)

    // Real directory has the row and the persisted `_ingest.gateway_id`
    // is the JWT-derived one, not the spoofed one.
    const file = path.join(dir, 'gw-real', 'logs', `${day}.jsonl`)
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines.length).toBe(1)
    expect(lines[0]._ingest.gateway_id).toBe('gw-real')
    // received_at must be a fresh ISO timestamp (Z-suffixed UTC), not the
    // 1970 string we tried to inject.
    expect(lines[0]._ingest.received_at).not.toBe('1970-01-01T00:00:00Z')
    expect(lines[0]._ingest.received_at.endsWith('Z')).toBe(true)
    // Other fields on the row are preserved as-is.
    expect(lines[0].hijack).toBe('yes')
    expect(lines[0].gateway_id).toBe('gw-victim')
  })

  it('returns 404 for an unknown signal', async () => {
    const { jwt } = await boot()
    const res = await fetch(`${baseUrl}/v1/ingest/unknown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('unknown signal')
  })

  it('returns 405 on non-POST methods', async () => {
    const { jwt } = await boot()
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'GET',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(405)
  })

  it('returns 415 when Content-Type is not NDJSON', async () => {
    const { jwt } = await boot()
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(415)
  })

  it('also accepts application/jsonl (alias for application/x-ndjson)', async () => {
    const { jwt, day } = await boot()
    const res = await fetch(`${baseUrl}/v1/ingest/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/jsonl' },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(202)
    const file = path.join(dir, 'gw-1', 'metrics', `${day}.jsonl`)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('tolerates Content-Type parameters (e.g. charset=utf-8)', async () => {
    const { jwt } = await boot()
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/x-ndjson; charset=utf-8',
      },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(202)
  })

  it('returns 400 on empty body', async () => {
    const { jwt } = await boot()
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: '',
    })
    expect(res.status).toBe(400)
  })

  it('writes proxy-signal rows to the proxy subdir', async () => {
    const { jwt, day } = await boot()
    const res = await fetch(`${baseUrl}/v1/ingest/proxy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ recorded: true }]),
    })
    expect(res.status).toBe(202)
    const file = path.join(dir, 'gw-1', 'proxy', `${day}.jsonl`)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('persists the same UTC date across timezones (uses received_at, not local)', async () => {
    // Pick a wall-clock that's UTC midnight so the tested behavior is
    // unambiguous — the file name is the UTC date regardless of the host
    // running this test.
    const utcMidnight = Date.UTC(2026, 4, 8, 0, 0, 0)
    const { jwt } = await boot({ clockMs: utcMidnight })
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ x: 1 }]),
    })
    expect(res.status).toBe(202)
    const file = path.join(dir, 'gw-1', 'logs', '2026-05-08.jsonl')
    expect(fs.existsSync(file)).toBe(true)
  })

  it('appends to an existing daily file across calls', async () => {
    const { jwt, day } = await boot()
    for (const x of [1, 2, 3]) {
      const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
        body: ndjson([{ x }]),
      })
      expect(res.status).toBe(202)
    }
    const file = path.join(dir, 'gw-1', 'logs', `${day}.jsonl`)
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((r) => r.x)).toEqual([1, 2, 3])
  })

  it('rolls to a new file when the day changes', async () => {
    const day1 = Date.UTC(2026, 4, 8, 23, 59, 0)
    const { jwt, clock } = await boot({ clockMs: day1 })
    let res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ on: 'day1' }]),
    })
    expect(res.status).toBe(202)
    clock.advance(2 * 60 * 1000) // cross midnight UTC
    res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body: ndjson([{ on: 'day2' }]),
    })
    expect(res.status).toBe(202)
    const day1File = path.join(dir, 'gw-1', 'logs', '2026-05-08.jsonl')
    const day2File = path.join(dir, 'gw-1', 'logs', '2026-05-09.jsonl')
    expect(fs.existsSync(day1File)).toBe(true)
    expect(fs.existsSync(day2File)).toBe(true)
    expect(JSON.parse(fs.readFileSync(day1File, 'utf8').trim()).on).toBe('day1')
    expect(JSON.parse(fs.readFileSync(day2File, 'utf8').trim()).on).toBe('day2')
  })

  it('returns 413 when Content-Length exceeds the cap', async () => {
    const { jwt } = await boot()
    // 17 MB — over the 16 MB cap. Fetch will set the actual length too,
    // but the explicit header path is the one that short-circuits before
    // reading any body.
    const big = 'x'.repeat(17 * 1024 * 1024)
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/x-ndjson',
        'content-length': String(big.length),
      },
      body: big,
    })
    expect(res.status).toBe(413)
  })

  it('skips blank NDJSON lines without rejecting', async () => {
    const { jwt, day } = await boot()
    const body = '\n' + JSON.stringify({ a: 1 }) + '\n\n' + JSON.stringify({ a: 2 }) + '\n\n'
    const res = await fetch(`${baseUrl}/v1/ingest/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/x-ndjson' },
      body,
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: 2 })
    const file = path.join(dir, 'gw-1', 'logs', `${day}.jsonl`)
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((r) => r.a)).toEqual([1, 2])
  })
})

describe('Ingest class direct API', () => {
  /** @type {string} */
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-ingest-direct-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rejects construction without a sinkDir', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => new Ingest({})).toThrow(/sinkDir is required/)
    expect(() => new Ingest({ sinkDir: '' })).toThrow(/sinkDir is required/)
  })

  it('appendBatch creates the directory tree on first call (idempotent on subsequent)', async () => {
    const ingest = new Ingest({ sinkDir: dir })
    await ingest.appendBatch({
      gatewayId: 'gw-x',
      signal: 'logs',
      day: '2026-05-08',
      lines: [JSON.stringify({ a: 1 })],
    })
    await ingest.appendBatch({
      gatewayId: 'gw-x',
      signal: 'logs',
      day: '2026-05-08',
      lines: [JSON.stringify({ a: 2 })],
    })
    const file = path.join(dir, 'gw-x', 'logs', '2026-05-08.jsonl')
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((r) => r.a)).toEqual([1, 2])
  })

  it('defaultSinkDir returns a path under the user home directory', () => {
    const d = defaultSinkDir()
    expect(d.startsWith(os.homedir())).toBe(true)
    expect(d).toMatch(/collectivus[\\/]server-data[\\/]ingested$/)
  })
})
