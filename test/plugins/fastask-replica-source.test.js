// @ts-check

// The team-graph-replica daemon source (LLP 0481 T8): the T5 sync loop and
// the T6 index behind a guarded 127.0.0.1 control route, and the evidence
// path forwarded over one kept-alive MCP session per remote. Runs against the
// loopback snapshot server built from the pinned fixtures, which also plays
// the remote's MCP endpoint.

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { DISCOVER_ROUTE, EVIDENCE_ROUTE, REFRESH_ROUTE, TOKEN_FILE, createReplicaSource } from '../../hypaware-core/plugins-workspace/fastask/src/replica_source.js'
import { replicaKey, replicaPaths } from '../../hypaware-core/plugins-workspace/fastask/src/replica_store.js'
import { generatedGeneration, pinnedGeneration, startSnapshotServer } from '../helpers/fastask_snapshot_server.js'
import { writeSession } from '../../src/core/remote/credentials.js'
import { callEvidence } from '../../hypaware-core/plugins-workspace/fastask/src/evidence.js'
import { createWarmEvidenceClient } from '../../hypaware-core/plugins-workspace/fastask/src/warm_client.js'
import { measureFile } from '../../hypaware-core/plugins-workspace/fastask/src/contract.js'

/**
 * @import { TestContext } from 'node:test'
 * @import { PluginActivationContext, StartedSource } from '../../hypaware-plugin-kernel-types.js'
 */

const OK_EVIDENCE = JSON.parse(fs.readFileSync(new URL('../fixtures/contracts/session-evidence/v1/01-ok-minimal.json', import.meta.url), 'utf8'))

/**
 * A fake remote MCP endpoint: sessions by id, one tool, and switches to
 * reject sessions, refuse reuse, fail a call or change version.
 */
function fakeMcp() {
  const mcp = {
    sessions: new Set(),
    initializes: 0,
    calls: 0,
    version: '1.40.0',
    forgetSessions: false,
    refuseReuse: false,
    /** @type {number | null} */
    failNext: null,
    hang: false,
    aborted: 0,
    /** HTTP 429 answers still to give (the org read capacity, server LLP 0562). */
    capacity: 0,
    /** A tool error result for the next call. */
    toolErrorNext: /** @type {string | null} */ (null),
    /** @type {Set<string>} */
    used: new Set(),
  }
  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {any} msg
   */
  function handle(req, res, msg) {
    /** @param {unknown} payload @param {Record<string, string>} [headers] */
    const reply = (payload, headers = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(payload))
    }
    if (msg.method === 'initialize') {
      const sid = randomUUID()
      mcp.sessions.add(sid)
      mcp.initializes++
      return reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'hypaware-server', version: mcp.version } } }, { 'mcp-session-id': sid })
    }
    const sid = String(req.headers['mcp-session-id'] ?? '')
    if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
    if (mcp.forgetSessions) { mcp.sessions.clear(); mcp.forgetSessions = false }
    if (!mcp.sessions.has(sid)) { res.writeHead(404); res.end(); return }
    if (msg.method === 'tools/list') {
      return reply({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'session_evidence', inputSchema: { type: 'object', properties: { contract: { type: 'string', enum: ['hypaware.session-evidence/1'] } } } }] } })
    }
    if (msg.method === 'tools/call') {
      if (mcp.refuseReuse && mcp.used.has(sid)) { mcp.sessions.delete(sid); res.writeHead(404); res.end(); return }
      mcp.used.add(sid)
      mcp.calls++
      if (mcp.capacity > 0) { mcp.capacity--; res.writeHead(429); res.end(); return }
      if (mcp.toolErrorNext !== null) {
        const text = mcp.toolErrorNext
        mcp.toolErrorNext = null
        return reply({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text }] } })
      }
      if (mcp.failNext !== null) {
        const code = mcp.failNext
        mcp.failNext = null
        return reply({ jsonrpc: '2.0', id: msg.id, error: { code, message: code === -32601 ? 'unknown tool' : 'invalid params' } })
      }
      if (mcp.hang) {
        res.on('close', () => { if (!res.writableEnded) mcp.aborted++ })
        return
      }
      const content = { ...OK_EVIDENCE.response, server_version: mcp.version, elapsed_ms: 5 }
      return reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content } })
    }
    reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } })
  }
  return { mcp, handle }
}

/**
 * Starts the source on a fake server and clock, waits for its first index.
 *
 * @param {TestContext} t
 * @param {{ publish?: boolean, deps?: Record<string, unknown>, waitIndex?: boolean }} [opts]
 */
async function setup(t, opts = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastask-source-'))
  const server = await startSnapshotServer()
  if (opts.publish !== false) server.publish(pinnedGeneration())
  const { mcp, handle } = fakeMcp()
  server.state.onMcp = handle
  const clock = { now: Date.parse('2026-10-09T16:00:00.000Z') }
  const target = { target: 'team', url: server.url, org: 'acme', token: async () => /** @type {const} */ ({ ok: true, token: 'tok' }) }
  /** @type {string[]} */
  const logs = []
  const log = { debug() {}, info(/** @type {string} */ m) { logs.push(m) }, warn(/** @type {string} */ m) { logs.push(m) }, error(/** @type {string} */ m) { logs.push(m) } }
  const ctx = /** @type {PluginActivationContext} */ (/** @type {unknown} */ ({ paths: { stateDir }, log, env: {}, config: {} }))
  const start = createReplicaSource({ resolveTarget: async () => target, now: () => clock.now, timeZone: 'UTC', duty: 1, ...opts.deps })
  /** @type {StartedSource} */
  const source = await start(ctx)
  let stopped = false
  const stop = async () => { if (!stopped) { stopped = true; await source.stop() } }
  t.after(async () => {
    await stop()
    await server.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  })
  // Ready means indexed and idle: a refresh during a pass joins that pass.
  if (opts.waitIndex !== false) await waitFor(async () => { const d = await details(source); return d.index_generation !== null && !d.refresh_in_progress })
  const token = fs.readFileSync(path.join(stateDir, TOKEN_FILE), 'utf8')
  const port = (await details(source)).listen_port
  return { stateDir, server, mcp, clock, source, stop, token, port, logs, paths: () => replicaPaths(stateDir, replicaKey(server.url, 'acme')) }
}

/** @param {StartedSource} source */
async function details(source) {
  return /** @type {any} */ ((await source.status?.())?.details)
}

/**
 * @param {number} port
 * @param {string} route
 * @param {unknown} body
 * @param {{ token?: string | null, host?: string, raw?: string, contentLength?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ status: number, body: any }>}
 */
function call(port, route, body, opts = {}) {
  const text = opts.raw ?? JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `/_hypaware/${route}`,
      headers: {
        'content-type': 'application/json',
        'content-length': String(opts.contentLength ?? Buffer.byteLength(text)),
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token}` }),
      },
      signal: opts.signal,
    }, (res) => {
      /** @type {Buffer[]} */
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null })
      })
    })
    req.on('error', reject)
    req.end(opts.contentLength !== undefined ? '' : text)
  })
}

test('discover answers from the warm index with the token, and refuses without it', async (t) => {
  const { port, token } = await setup(t)
  const ok = await call(port, DISCOVER_ROUTE, { question: 'where was app.js changed?' }, { token })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.source, 'team_replica')
  assert.equal(ok.body.replica.generation, pinnedGeneration().manifest.generation)
  assert.equal(ok.body.replica.generation_dir, undefined, 'no local paths leave the daemon')
  assert.ok(ok.body.result.leads.some((/** @type {any} */ l) => l.session_id === 'fx-session-0001'), JSON.stringify(ok.body.result.leads))
  assert.equal((await call(port, DISCOVER_ROUTE, { question: 'x' }, { token: null })).status, 401)
  assert.equal((await call(port, DISCOVER_ROUTE, { question: 'x' }, { token: 'f'.repeat(64) })).status, 401)
  assert.equal((await call(port, 'fastask/other', {}, { token })).status, 404)
})

test('a misdirected Host and an oversized body are refused before any work', async (t) => {
  const { port, token } = await setup(t)
  assert.equal((await call(port, DISCOVER_ROUTE, { question: 'x' }, { token, host: 'attacker.example:80' })).status, 421)
  assert.equal((await call(port, DISCOVER_ROUTE, null, { token, contentLength: 10 * 1024 * 1024 })).status, 413)
  const big = JSON.stringify({ question: 'x'.repeat(70 * 1024) })
  assert.equal((await call(port, DISCOVER_ROUTE, null, { token, raw: big })).status, 413)
  assert.equal((await call(port, DISCOVER_ROUTE, null, { token, raw: '{not json' })).status, 400)
})

test('the token file is per boot, mode 0600, and removed at stop', async (t) => {
  const { stateDir, token, stop } = await setup(t)
  const file = path.join(stateDir, TOKEN_FILE)
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  await stop()
  assert.equal(fs.existsSync(file), false)
})

test('status advertises the listener and routes, and a synced summary line', async (t) => {
  const { source } = await setup(t)
  const status = await source.status?.()
  const d = /** @type {any} */ (status?.details)
  assert.equal(status?.state, 'ready')
  assert.equal(d.listen_host, '127.0.0.1')
  assert.ok(Number.isInteger(d.listen_port) && d.listen_port > 0)
  assert.deepEqual(d.control_routes, [DISCOVER_ROUTE, EVIDENCE_ROUTE, REFRESH_ROUTE])
  assert.ok(d.index_bytes > 0)
  assert.equal(d.state, 'synced')
  assert.match(d.summary_line, /^team graph: synced, data as of \d+ h ago \(acme\), \d+ (B|KB)$/)
  assert.equal(status?.message, d.summary_line)
})

test('evidence reuses one MCP session across calls: one initialize for two calls', async (t) => {
  const { port, token, mcp, source } = await setup(t)
  const first = await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
  const second = await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.reused, false)
  assert.equal(second.body.reused, true)
  assert.deepEqual(second.body.result.structuredContent.sessions, OK_EVIDENCE.response.sessions)
  assert.equal(mcp.initializes, 1)
  assert.equal(mcp.calls, 2)
  const record = (await details(source)).evidence[0]
  assert.equal(record.supports_evidence, true)
  assert.deepEqual(record.contracts, ['hypaware.session-evidence/1'])
  assert.equal(record.server_version, '1.40.0')
  assert.equal(record.per_call, false)
  assert.equal(typeof record.last_round_trip_ms, 'number')
})

test('a rejected session is re-initialized and the call retried once', async (t) => {
  const { port, token, mcp } = await setup(t)
  await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
  mcp.forgetSessions = true
  const again = await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
  assert.equal(again.body.ok, true)
  assert.equal(mcp.initializes, 2)
})

test('-32601 and -32602 come back as typed errors and force a re-initialize', async (t) => {
  const { port, token, mcp } = await setup(t)
  await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
  for (const code of [-32601, -32602]) {
    const before = mcp.initializes
    mcp.failNext = code
    const failed = await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
    assert.equal(failed.body.ok, false)
    assert.equal(failed.body.kind, 'rpc')
    assert.equal(failed.body.code, code)
    const next = await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
    assert.equal(next.body.ok, true)
    assert.equal(mcp.initializes, before + 1, `re-initialized after ${code}`)
  }
})

test('a server version change re-initializes before the next call', async (t) => {
  const { port, token, mcp } = await setup(t)
  await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
  mcp.version = '1.41.0'
  await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
  assert.equal(mcp.initializes, 1, 'the call that reports the new version still completes on the old session')
  await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
  assert.equal(mcp.initializes, 2)
})

test('a server that refuses session reuse is recorded per-call, and calls still succeed', async (t) => {
  const { port, token, mcp, source } = await setup(t)
  mcp.refuseReuse = true
  for (let i = 0; i < 4; i++) {
    const r = await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
    assert.equal(r.body.ok, true, `call ${i}`)
  }
  assert.equal((await details(source)).evidence[0].per_call, true)
})

test('the caller\'s abort reaches the upstream request', async (t) => {
  const { port, token, mcp } = await setup(t)
  await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
  mcp.hang = true
  const controller = new AbortController()
  const pending = call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token, signal: controller.signal }).catch((err) => err)
  await waitFor(async () => mcp.calls >= 2)
  controller.abort()
  await pending
  await waitFor(async () => mcp.aborted === 1)
})

test('evidence without a tool that supports the contract says so instead of calling', async (t) => {
  const { port, token, server } = await setup(t)
  const { handle } = fakeMcp()
  server.state.onMcp = (req, res, msg) => {
    if (msg.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }))
      return
    }
    handle(req, res, msg)
  }
  const r = await call(port, EVIDENCE_ROUTE, { arguments: OK_EVIDENCE.request }, { token })
  assert.equal(r.body.ok, false)
  assert.equal(r.body.kind, 'unsupported')
})

test('a new generation is indexed, swapped in, and the old files removed', async (t) => {
  const { source, server, port, token, paths } = await setup(t)
  server.publish(await generatedGeneration({ generation: '1760002000000-1' }))
  await source.reload?.(/** @type {any} */ ({}))
  await waitFor(async () => { const d = await details(source); return d.index_generation === '1760002000000-1' && !d.refresh_in_progress })
  assert.deepEqual(fs.readdirSync(paths().generations), ['1760002000000-1'])
  const ok = await call(port, DISCOVER_ROUTE, { question: 'anything' }, { token })
  assert.equal(ok.body.replica.generation, '1760002000000-1')
})

test('a generation whose rows break the contract is rejected: the old one and its index stay, status says why', async (t) => {
  // The review's probe (HYP-111 r1 F5): digests valid over rows whose node_id
  // column is renamed. Before the per-line check it activated an empty index.
  const { source, server, port, token, paths, logs } = await setup(t)
  const before = await details(source)
  const bad = await generatedGeneration({ generation: '1760000000000-99', nodeCount: 3, edgeCount: 0 })
  const rows = gunzipSync(bad.files.nodes).toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
  for (const row of rows) {
    row.renamed_node_id = row.node_id
    delete row.node_id
  }
  bad.files.nodes = gzipSync(rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
  bad.manifest.files.nodes = { path: bad.manifest.files.nodes.path, ...(await measureFile(bad.files.nodes)).facts }
  server.publish(bad)
  await call(port, REFRESH_ROUTE, {}, { token })
  await waitFor(() => logs.includes('fastask.generation_rejected'))
  await waitFor(async () => !(await details(source)).refresh_in_progress)

  const after = await details(source)
  assert.equal(after.generation, before.generation, 'the previous generation stays active')
  assert.equal(after.index_generation, before.index_generation)
  assert.equal(after.index_bytes, before.index_bytes, 'the index is unchanged')
  assert.match(after.index_error, /^generation 1760000000000-99 rejected \(schema_violation\): nodes line 1: column 1 is "node_type", expected node_id$/)
  const status = await source.status?.()
  assert.equal(status?.state, 'degraded')
  assert.match(status?.lastError ?? '', /schema_violation/)
  assert.deepEqual(fs.readdirSync(paths().generations), [before.generation])
  assert.deepEqual(fs.readdirSync(paths().staging), [])
  const ok = await call(port, DISCOVER_ROUTE, { question: 'app.js' }, { token })
  assert.equal(ok.status, 200, 'discover still answers from the previous index')
  assert.equal(ok.body.replica.generation, before.generation)
})

test('a withdrawal drops the index: discover answers 503 with the state', async (t) => {
  const { source, server, port, token } = await setup(t)
  server.state.answer = '403-snapshot_access_withdrawn'
  await source.reload?.(/** @type {any} */ ({}))
  await waitFor(async () => { const d = await details(source); return d.state === 'withdrawn' && !d.refresh_in_progress })
  const r = await call(port, DISCOVER_ROUTE, { question: 'app.js' }, { token })
  assert.equal(r.status, 503)
  assert.equal(r.body.replica.state, 'withdrawn')
  const status = await source.status?.()
  assert.equal(status?.state, 'degraded')
  assert.equal(/** @type {any} */ (status?.details).summary_line, 'team graph: removed, access to acme was withdrawn')
  assert.equal(/** @type {any} */ (status?.details).index_generation, null)
})

test('T7\'s evidence client reads through the warm path exactly as through a direct MCP client', async (t) => {
  const { port, token, mcp } = await setup(t)
  const planned = OK_EVIDENCE.request.sessions.map((/** @type {string} */ text, /** @type {number} */ i) => ({ lead: i, kind: /** @type {const} */ ('window'), entry: JSON.parse(text) }))
  const client = createWarmEvidenceClient({ endpoint: `http://127.0.0.1:${port}`, token })
  const read = () => callEvidence({ client, planned, leadCount: planned.length, deadlineAt: performance.now() + 2000, sleep: async () => {} })

  const ok = await read()
  assert.ok(ok !== 'fallback')
  assert.equal(ok.path, 'session_evidence')
  assert.equal(ok.failure, null)
  assert.equal(ok.leads.length, planned.length)
  assert.equal(typeof client.lastRoundTripMs, 'number', 'the daemon\'s round trip comes back for the next deadline')

  mcp.failNext = -32601
  assert.equal(await read(), 'fallback', '-32601 falls back to query_sql')
  mcp.failNext = -32602
  const defect = await read()
  assert.ok(defect !== 'fallback' && defect.failure?.code === 'invalid_request', '-32602 is a reported client defect')

  mcp.toolErrorNext = 'invalid_request: sessions[0] is not a JSON object'
  const toolError = await read()
  assert.ok(toolError !== 'fallback' && toolError.failure?.code === 'invalid_request', 'a tool error result passes through as is')

  mcp.capacity = 1
  const retried = await read()
  assert.ok(retried !== 'fallback' && retried.failure === null && retried.retries === 1, 'one capacity retry, then success')
  mcp.capacity = 2
  const busy = await read()
  assert.ok(busy !== 'fallback' && busy.failure?.code === 'server_busy', 'capacity twice is server busy')

  await assert.rejects(client.callTool('query_sql', {}), /forwards session_evidence only/)
})

test('a server without the verb falls back through the warm path too', async (t) => {
  const { port, token, server } = await setup(t)
  const { handle } = fakeMcp()
  server.state.onMcp = (req, res, msg) => {
    if (msg.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'query_sql' }] } }))
      return
    }
    handle(req, res, msg)
  }
  const planned = [{ lead: 0, kind: /** @type {const} */ ('window'), entry: JSON.parse(OK_EVIDENCE.request.sessions[0]) }]
  const client = createWarmEvidenceClient({ endpoint: `http://127.0.0.1:${port}`, token })
  assert.equal(await callEvidence({ client, planned, leadCount: 1, deadlineAt: performance.now() + 2000 }), 'fallback')
})

test('the real resolver reads the hyp status config, shows its path and target, and follows a reload', async (t) => {
  // Two servers standing in for two remotes; the config's default moves from one to the other.
  const first = await startSnapshotServer()
  const second = await startSnapshotServer()
  first.publish(pinnedGeneration())
  second.publish(await generatedGeneration({ generation: '1760004000000-1' }))
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fastask-real-resolver-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  const configPath = path.join(hypHome, 'hypaware-config.json')
  /** @param {string} name */
  const writeConfig = (name) => fs.writeFileSync(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/fastask' }],
    query: { default_remote: name, remotes: { one: { url: first.url }, two: { url: second.url } } },
  }))
  writeConfig('one')
  for (const target of ['one', 'two']) {
    await writeSession(stateRoot, target, { refreshToken: 'r', accessJwt: 'tok', expiresAt: '2099-01-01T00:00:00.000Z', org: 'acme' })
  }
  const pluginState = path.join(stateRoot, 'plugins', 'fastask')
  const log = { debug() {}, info() {}, warn() {}, error() {} }
  const ctx = /** @type {PluginActivationContext} */ (/** @type {unknown} */ ({ paths: { stateDir: pluginState }, log, env: { HYP_HOME: hypHome, HYP_CONFIG: configPath }, config: {} }))
  const source = await createReplicaSource({ duty: 1 })(ctx)
  t.after(async () => {
    await source.stop()
    await first.close()
    await second.close()
    fs.rmSync(hypHome, { recursive: true, force: true })
  })
  await waitFor(async () => { const d = await details(source); return d.index_generation !== null && !d.refresh_in_progress })
  let d = await details(source)
  assert.equal(d.config_path, configPath, 'the config read is visible in status')
  assert.equal(d.target, 'one')
  assert.equal(d.index_generation, pinnedGeneration().manifest.generation)

  writeConfig('two')
  await source.reload?.(ctx)
  await waitFor(async () => { const x = await details(source); return x.target === 'two' && x.index_generation === '1760004000000-1' && !x.refresh_in_progress })
  d = await details(source)
  assert.equal(d.origin, new URL(second.url).origin)
  assert.equal(fs.readdirSync(path.join(pluginState, 'replicas')).length, 1, 'the old remote\'s replica is gone')
})

test('stop during a build aborts it promptly and leaves no staging', async (t) => {
  const { server, stop, paths, source } = await setup(t, { publish: false, waitIndex: false, deps: { duty: 0.02 } })
  server.publish(await generatedGeneration({ generation: '1760003000000-1', nodeCount: 30_000, edgeCount: 30_000 }))
  // The first pass found nothing published and waits out retry-after; check now.
  await waitFor(async () => !(await details(source)).refresh_in_progress)
  await source.reload?.(/** @type {any} */ ({}))
  await waitFor(async () => {
    const staging = paths().staging
    return fs.existsSync(staging) && fs.readdirSync(staging).some((d) => fs.existsSync(path.join(staging, d, 'manifest.json')))
  }, 20_000)
  const started = Date.now()
  await stop()
  assert.ok(Date.now() - started < 2000, `stop took ${Date.now() - started} ms`)
  assert.deepEqual(fs.readdirSync(paths().staging), [])
  assert.ok(!fs.existsSync(paths().generations) || fs.readdirSync(paths().generations).length === 0, 'the aborted generation never became active')
})

/**
 * @param {() => Promise<boolean> | boolean} predicate
 * @param {number} [ms]
 */
async function waitFor(predicate, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}
