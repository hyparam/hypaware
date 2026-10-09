// @ts-check

// The team graph replica sync loop (LLP 0481 T5) against a loopback server
// built from the pinned hypaware.graph-snapshot/1 fixtures: first sync, the
// conditional check, replacement, every row of LLP 0480#sync's
// interpretation table, and the failures that must leave the previous
// generation active (corrupt, truncated, interrupted, disk full, crash
// between staging and activation).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'

import { MAX_POLL_SECONDS, createReplicaSync, manifestProblem, pollDelayMs } from '../../hypaware-core/plugins-workspace/fastask/src/replica_sync.js'
import { replicaKey, replicaPaths, replicasRoot } from '../../hypaware-core/plugins-workspace/fastask/src/replica_store.js'
import { deriveSnapshotEndpoint } from '../../hypaware-core/plugins-workspace/fastask/src/snapshot_client.js'
import { generatedGeneration, pinnedGeneration, startSnapshotServer } from '../helpers/fastask_snapshot_server.js'

/**
 * @import { TestContext } from 'node:test'
 */

const T0 = Date.parse('2026-10-09T04:00:00.000Z')
const LEASE_MS = 259200 * 1000

/**
 * A fresh state dir, a fake server publishing the pinned generation, and a
 * sync instance on a fake clock. `random` 0 makes the poll delay exact.
 *
 * @param {TestContext} t
 * @param {{ org?: string | null, publish?: boolean, syncOpts?: Record<string, unknown> }} [opts]
 */
async function setup(t, opts = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastask-replica-'))
  const server = await startSnapshotServer()
  if (opts.publish !== false) server.publish(pinnedGeneration())
  const clock = { now: T0 }
  const tokens = { calls: 0, forced: 0, value: 'tok' }
  const target = {
    target: 'team',
    url: server.url,
    org: opts.org === undefined ? 'acme' : opts.org,
    /** @param {boolean} [force] */
    async token(force = false) {
      tokens.calls++
      if (force) tokens.forced++
      return /** @type {const} */ ({ ok: true, token: tokens.value, source: 'file', kind: 'oidc' })
    },
  }
  const targetRef = { current: /** @type {typeof target | null} */ (target) }
  /** @type {string[]} */
  const events = []
  const sync = createReplicaSync({
    stateDir,
    resolveTarget: async () => targetRef.current,
    now: () => clock.now,
    random: () => 0,
    hooks: {
      async beforeActivate(dir, manifest) { events.push(`before:${manifest.generation}:${fs.existsSync(path.join(dir, 'nodes.ndjson.gz'))}`) },
      async afterActivate(dir, manifest) { events.push(`after:${manifest.generation}`) },
      onDelete(reason) { events.push(`delete:${reason}`) },
    },
    budget: { duty: 1 },
    ...opts.syncOpts,
  })
  t.after(async () => {
    await sync.close()
    await server.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  })
  const paths = () => replicaPaths(stateDir, replicaKey(server.url, target.org))
  return { stateDir, server, clock, tokens, target, targetRef, events, sync, paths }
}

/** @param {string} dir */
function list(dir) {
  try { return fs.readdirSync(dir).sort() } catch { return [] }
}

test('first sync downloads, verifies and activates the pinned generation', async (t) => {
  const { sync, server, paths, events } = await setup(t)
  const { status, delayMs } = await sync.syncOnce()
  const pinned = pinnedGeneration().manifest
  assert.equal(status.state, 'synced')
  assert.equal(status.servable, true)
  assert.equal(status.generation, pinned.generation)
  assert.equal(status.watermark, pinned.projection.watermark)
  assert.deepEqual(status.rows, { nodes: pinned.files.nodes.rows, edges: pinned.files.edges.rows })
  assert.equal(status.lease_expires_at, new Date(T0 + LEASE_MS).toISOString())
  assert.equal(delayMs, 900_000, 'the manifest poll interval, jitter drawn as 0')
  assert.deepEqual(list(status.generation_dir ?? ''), ['edges.ndjson.gz', 'manifest.json', 'nodes.ndjson.gz'])
  assert.deepEqual(list(paths().staging), [])
  assert.deepEqual(events, [`before:${pinned.generation}:true`, `after:${pinned.generation}`])
  assert.equal(server.requests[0].ifNoneMatch, null, 'nothing held yet, so the first check is unconditional')
  assert.equal(server.requests[0].url, '/v1/graph/snapshot?protocol=1')
  const record = JSON.parse(fs.readFileSync(paths().record, 'utf8'))
  assert.equal(record.generation, pinned.generation)
  assert.equal(record.org, 'acme')
})

test('an unchanged generation answers 304: no download, lease renewed from the header', async (t) => {
  const { sync, server, clock } = await setup(t)
  await sync.syncOnce()
  const downloads = server.dataRequests().length
  clock.now += 3600_000
  const { status } = await sync.syncOnce()
  const check = server.requests.at(-1)
  assert.equal(check?.ifNoneMatch, `"${pinnedGeneration().manifest.generation}"`)
  assert.equal(server.dataRequests().length, downloads, 'a 304 downloads nothing')
  assert.equal(status.state, 'synced')
  assert.equal(status.lease_expires_at, new Date(clock.now + LEASE_MS).toISOString())
})

test('a 304 without the lease header keeps the last announced lease length; the client never invents one', async (t) => {
  const { sync, server, clock } = await setup(t)
  server.state.leaseHeader = '3600'
  await sync.syncOnce()
  server.state.leaseHeader = null
  clock.now += 600_000
  const { status } = await sync.syncOnce()
  assert.equal(status.lease_expires_at, new Date(clock.now + 3600_000).toISOString())
})

test('a new generation replaces the old one, which is deleted after activation', async (t) => {
  const { sync, server, events } = await setup(t)
  await sync.syncOnce()
  const next = await generatedGeneration({ generation: '1760000100000-8' })
  server.publish(next)
  const { status } = await sync.syncOnce()
  assert.equal(status.generation, '1760000100000-8')
  assert.equal(status.watermark, next.manifest.projection.watermark)
  assert.deepEqual(list(path.dirname(status.generation_dir ?? '')), ['1760000100000-8'])
  assert.deepEqual(events.slice(-2), ['before:1760000100000-8:true', 'after:1760000100000-8'])
})

test('a corrupt download fails verification and keeps the previous generation', async (t) => {
  const { sync, server, paths } = await setup(t)
  await sync.syncOnce()
  const next = await generatedGeneration({ generation: '1760000100000-8' })
  server.publish(next)
  server.state.onData = (req, res, info) => {
    if (info.name !== 'edges') return false
    const corrupt = Buffer.from(info.bytes)
    corrupt[corrupt.length >> 1] ^= 0x01
    res.writeHead(200, { 'content-length': String(corrupt.length) })
    res.end(corrupt)
    return true
  }
  const { status, delayMs } = await sync.syncOnce()
  assert.equal(status.state, 'stale')
  assert.equal(status.reason, 'verify_failed')
  assert.equal(status.generation, pinnedGeneration().manifest.generation)
  assert.equal(status.servable, true)
  assert.equal(delayMs, 30_000, 'first rung of the backoff ladder')
  assert.deepEqual(list(paths().staging), [])
  assert.deepEqual(list(paths().generations), [pinnedGeneration().manifest.generation])
})

test('an interrupted download is discarded and the next pass restarts from byte zero', async (t) => {
  const { sync, server, paths } = await setup(t, { publish: false })
  const gen = await generatedGeneration({ generation: '1760000200000-1', nodeCount: 2000 })
  server.publish(gen)
  let cut = true
  server.state.onData = (req, res, info) => {
    if (!cut || info.name !== 'nodes') return false
    cut = false
    res.writeHead(200, { 'content-length': String(info.bytes.length) })
    res.write(info.bytes.subarray(0, info.bytes.length >> 1))
    setImmediate(() => res.socket?.destroy())
    return true
  }
  const first = await sync.syncOnce()
  assert.equal(first.status.state, 'unavailable')
  assert.equal(first.status.reason, 'outage')
  assert.deepEqual(list(paths().staging), [])
  const second = await sync.syncOnce()
  assert.equal(second.status.state, 'synced')
  assert.equal(second.status.generation, '1760000200000-1')
  const nodeGets = server.dataRequests().filter((r) => r.url.endsWith('nodes.ndjson.gz'))
  assert.equal(nodeGets.length, 2, 'the whole file again, no Range resume in v1')
})

test('a 410 on a data file re-reads the manifest once and activates its generation', async (t) => {
  const { sync, server } = await setup(t)
  await sync.syncOnce()
  const retiring = await generatedGeneration({ generation: '1760000300000-1' })
  const replacement = await generatedGeneration({ generation: '1760000300000-2' })
  server.publish(retiring)
  server.state.onData = (req, res, info) => {
    if (info.generation !== '1760000300000-1') return false
    // Retired mid-download: the generation is gone and a newer one is current.
    server.retire('1760000300000-1')
    server.publish(replacement)
    const body = JSON.stringify({ error: 'generation_expired', message: 'gone' })
    res.writeHead(410, { 'content-type': 'application/json', 'content-length': String(body.length) })
    res.end(body)
    return true
  }
  const { status } = await sync.syncOnce()
  assert.equal(status.state, 'synced')
  assert.equal(status.generation, '1760000300000-2')
})

test('403 snapshot_access_withdrawn deletes the replica now and stays withdrawn through outages', async (t) => {
  const { sync, server, paths, events } = await setup(t)
  await sync.syncOnce()
  server.state.answer = '403-snapshot_access_withdrawn'
  const { status } = await sync.syncOnce()
  assert.equal(status.state, 'withdrawn')
  assert.equal(status.servable, false)
  assert.equal(status.generation, null)
  assert.equal(status.watermark, pinnedGeneration().manifest.projection.watermark, 'the age of the last data stays known')
  assert.deepEqual(list(paths().generations), [])
  assert.ok(events.includes('delete:withdrawn'))
  server.state.answer = { status: 502, body: { error: 'bad_gateway' } }
  assert.equal((await sync.syncOnce()).status.state, 'withdrawn')
})

test('lease expiry with no server reachable stops serving and deletes the files', async (t) => {
  const { sync, server, clock, paths, events } = await setup(t)
  await sync.syncOnce()
  await server.close()
  clock.now += LEASE_MS - 1000
  const within = await sync.syncOnce()
  assert.equal(within.status.state, 'stale')
  assert.equal(within.status.reason, 'outage')
  assert.equal(within.status.servable, true, 'an outage keeps serving within the lease')
  clock.now += 2000
  assert.equal(sync.status().state, 'expired', 'status says expired before the next pass deletes anything')
  assert.equal(sync.status().servable, false)
  const after = await sync.syncOnce()
  assert.equal(after.status.state, 'expired')
  assert.equal(after.status.generation, null)
  assert.deepEqual(list(paths().generations), [])
  assert.ok(events.includes('delete:lease_expired'))
})

test('the interpretation table: refusals keep the held generation within lease', async (t) => {
  const { sync, server } = await setup(t)
  await sync.syncOnce()
  const held = pinnedGeneration().manifest.generation
  /** @type {Array<[any, string, string, number | null]>} */
  const rows = [
    ['400-unsupported_protocol', 'unsupported', 'protocol', 900_000],
    ['404-unknown_path', 'unsupported', 'server_too_old', 900_000],
    ['404-graph_snapshots_disabled', 'unavailable', 'disabled', 900_000],
    ['503-snapshot_pending', 'stale', 'pending', 60_000],
    ['429-snapshot_download_capacity', 'stale', 'outage', 30_000],
    [{ status: 500, body: { error: 'internal' } }, 'stale', 'outage', null],
  ]
  for (const [answer, state, reason, delay] of rows) {
    server.state.answer = answer
    const { status, delayMs } = await sync.syncOnce()
    const label = typeof answer === 'string' ? answer : answer.status
    assert.equal(status.state, state, `${label} state`)
    assert.equal(status.reason, reason, `${label} reason`)
    assert.equal(status.generation, held, `${label} keeps the generation`)
    assert.equal(status.servable, true, `${label} keeps serving within lease`)
    if (delay !== null) assert.equal(delayMs, delay, `${label} delay`)
  }
})

test('503 with nothing held is unavailable and re-checks at retry-after', async (t) => {
  const { sync } = await setup(t, { publish: false })
  const { status, delayMs } = await sync.syncOnce()
  assert.equal(status.state, 'unavailable')
  assert.equal(status.reason, 'pending')
  assert.equal(delayMs, 60_000)
})

test('repeated outages climb the backoff ladder; a success resets it', async (t) => {
  const { sync, server } = await setup(t)
  await sync.syncOnce()
  server.state.answer = { status: 500, body: { error: 'internal' } }
  const delays = []
  for (let i = 0; i < 5; i++) delays.push((await sync.syncOnce()).delayMs)
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 300_000, 300_000])
  server.state.answer = 'ok'
  assert.equal((await sync.syncOnce()).delayMs, 900_000)
})

test('a 401 forces one credential refresh and retries; a 401 that survives is stale with reason credential', async (t) => {
  const { sync, server, tokens } = await setup(t)
  await sync.syncOnce()
  tokens.value = 'expired'
  server.state.acceptedToken = 'fresh'
  const failed = await sync.syncOnce()
  assert.equal(tokens.forced, 1)
  assert.equal(failed.status.state, 'stale')
  assert.equal(failed.status.reason, 'credential')
  assert.equal(failed.status.servable, true, 'credential loss keeps the replica within the lease')
})

test('a 401 cured by the forced refresh is a normal success', async (t) => {
  const { sync, server, tokens, target } = await setup(t)
  target.token = async (force = false) => {
    tokens.calls++
    if (force) tokens.forced++
    return { ok: true, token: force ? 'fresh' : 'stale', source: 'file', kind: 'oidc' }
  }
  server.state.acceptedToken = 'fresh'
  const { status } = await sync.syncOnce()
  assert.equal(status.state, 'synced')
  assert.ok(tokens.forced >= 1)
})

test('an unsupported format is refused before any download', async (t) => {
  const { sync, server } = await setup(t, { publish: false })
  const gen = pinnedGeneration()
  gen.manifest.schema.schema_version = 2
  server.publish(gen)
  const { status } = await sync.syncOnce()
  assert.equal(status.state, 'unsupported')
  assert.equal(status.reason, 'format')
  assert.equal(server.dataRequests().length, 0)
  assert.equal(manifestProblem(pinnedGeneration().manifest), null)
})

test('a manifest larger than the replica ceiling is refused with replica_too_large', async (t) => {
  const { sync, server } = await setup(t, { syncOpts: { maxReplicaBytes: 100 } })
  const { status } = await sync.syncOnce()
  assert.equal(status.reason, 'replica_too_large')
  assert.equal(status.servable, false)
  assert.equal(server.dataRequests().length, 0)
})

test('a full disk during download keeps the previous generation and removes staging', async (t) => {
  let fail = false
  const { sync, server, paths } = await setup(t, {
    syncOpts: {
      createWriteStream: (/** @type {string} */ file, /** @type {any} */ options) => {
        if (!fail) return fs.createWriteStream(file, options)
        return new Writable({
          write(chunk, encoding, callback) {
            callback(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
          },
        })
      },
    },
  })
  await sync.syncOnce()
  fail = true
  server.publish(await generatedGeneration({ generation: '1760000400000-1' }))
  const { status } = await sync.syncOnce()
  assert.equal(status.state, 'stale')
  assert.equal(status.reason, 'disk_full')
  assert.equal(status.generation, pinnedGeneration().manifest.generation)
  assert.deepEqual(list(paths().staging), [])
})

test('after a crash between staging and activation, a restart keeps the old generation and clears the leftovers', async (t) => {
  const { sync, paths, stateDir, server } = await setup(t)
  await sync.syncOnce()
  const p = paths()
  // A crash left a half-written staging download and a promoted directory the
  // record never named.
  fs.mkdirSync(path.join(p.staging, 'deadbeef'), { recursive: true })
  fs.writeFileSync(path.join(p.staging, 'deadbeef', 'nodes.ndjson.gz'), 'partial')
  fs.mkdirSync(path.join(p.generations, '1760000999999-1'), { recursive: true })
  await sync.close()
  const restarted = createReplicaSync({
    stateDir,
    resolveTarget: async () => ({ target: 'team', url: server.url, org: 'acme', token: async () => ({ ok: true, token: 'tok' }) }),
    now: () => T0 + 1000,
    random: () => 0,
  })
  t.after(() => restarted.close())
  const { status } = await restarted.syncOnce()
  assert.equal(status.generation, pinnedGeneration().manifest.generation)
  assert.equal(status.state, 'synced')
  assert.deepEqual(list(p.staging), [])
  assert.deepEqual(list(p.generations), [pinnedGeneration().manifest.generation])
})

test('a change of org or a removed login deletes the replica; nothing else is kept', async (t) => {
  const { sync, targetRef, target, stateDir, events } = await setup(t)
  await sync.syncOnce()
  const before = list(replicasRoot(stateDir))
  targetRef.current = { ...target, org: 'other-org' }
  await sync.syncOnce()
  const after = list(replicasRoot(stateDir))
  assert.equal(after.length, 1)
  assert.notDeepEqual(after, before)
  assert.ok(events.includes('delete:key_changed'))
  targetRef.current = null
  const { status } = await sync.syncOnce()
  assert.deepEqual(list(replicasRoot(stateDir)), [])
  assert.equal(status.reason, 'no_login')
  assert.ok(events.includes('delete:target_removed'))
})

test('a static token learns its org from the manifest and drops the replica when the org changes', async (t) => {
  const { sync, server, paths } = await setup(t, { org: null })
  const first = await sync.syncOnce()
  assert.equal(first.status.org, 'acme')
  const other = await generatedGeneration({ generation: '1760000500000-1' })
  other.manifest.org = 'globex'
  server.publish(other)
  const { status } = await sync.syncOnce()
  assert.equal(status.org, 'globex')
  assert.equal(status.generation, '1760000500000-1')
  assert.deepEqual(list(paths().generations), ['1760000500000-1'])
})

test('overlapping refreshes coalesce into one check', async (t) => {
  const { sync, server } = await setup(t)
  const [a, b, c] = await Promise.all([sync.refresh(), sync.refresh(), sync.syncOnce()])
  assert.equal(server.requests.filter((r) => r.url.startsWith('/v1/graph/snapshot?')).length, 1)
  assert.equal(a.status.generation, b.status.generation)
  assert.equal(b.status.generation, c.status.generation)
})

test('close() during a download aborts it and leaves no staging behind', async (t) => {
  const { sync, server, paths } = await setup(t, { publish: false })
  server.publish(await generatedGeneration({ generation: '1760000600000-1' }))
  /** @type {() => void} */
  let reached = () => {}
  const stalled = new Promise((resolve) => { reached = () => resolve(undefined) })
  server.state.onData = (req, res, info) => {
    res.writeHead(200, { 'content-length': String(info.bytes.length) })
    res.write(info.bytes.subarray(0, 10))
    reached()
    return true
  }
  const pass = sync.syncOnce().catch((err) => err)
  await stalled
  await sync.close()
  assert.ok((await pass) instanceof Error, 'the pass rejects with the stop reason')
  assert.deepEqual(list(paths().staging), [])
  assert.deepEqual(list(paths().generations), [])
})

test('the loop runs passes on its own and refresh() wakes it early', async (t) => {
  const { sync, server } = await setup(t)
  void sync.start()
  await waitFor(() => sync.status().state === 'synced' && !sync.status().refresh_in_progress)
  const checks = () => server.requests.filter((r) => r.url.startsWith('/v1/graph/snapshot?')).length
  const before = checks()
  await sync.refresh()
  assert.equal(checks(), before + 1)
  assert.equal(sync.status().state, 'synced')
})

test('poll delay: interval plus jitter, clamped to 5 minutes and 6 hours', () => {
  assert.equal(pollDelayMs({ interval_seconds: 900, jitter_seconds: 300 }, () => 0.5), 1_050_000)
  assert.equal(pollDelayMs({ interval_seconds: 10, jitter_seconds: 0 }, () => 0), 300_000)
  assert.equal(pollDelayMs({ interval_seconds: 99_999, jitter_seconds: 0 }, () => 0), MAX_POLL_SECONDS * 1000)
})

test('the snapshot endpoint derives from the registered target URL', () => {
  assert.equal(deriveSnapshotEndpoint('https://hyp.example'), 'https://hyp.example/v1/graph/snapshot')
  assert.equal(deriveSnapshotEndpoint('https://hyp.example/base/'), 'https://hyp.example/base/v1/graph/snapshot')
  assert.equal(deriveSnapshotEndpoint('https://hyp.example/base/v1/mcp'), 'https://hyp.example/base/v1/graph/snapshot')
  assert.equal(deriveSnapshotEndpoint('https://hyp.example/v1/mcp?org=a'), 'https://hyp.example/v1/graph/snapshot')
})

test('leave never touches the replica: the plugin reads no central enrollment (LLP 0482)', () => {
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'hypaware-core', 'plugins-workspace', 'fastask', 'src')
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8')
    assert.ok(!/readCentralEnrollment|central\/src/.test(source), `${name} must not consult central enrollment`)
  }
})

/** @param {() => boolean} predicate */
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}
