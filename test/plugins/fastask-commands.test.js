// @ts-check

// The fastask commands (LLP 0480#command, #sources; LLP 0481 T9): hyp fastask
// over each source (warm through a running daemon, cold from a replica on
// disk, team_server by SQL, local captures), flag validation and exit codes,
// graph replica status and refresh, query evidence, and hyp remote remove
// deleting the replica. Everything runs in a disposable HYP_HOME against
// loopback fakes: a team server answering MCP (query_sql runs the SQL it is
// sent over the pinned graph fixture), and a "daemon" made of the files a live
// daemon leaves (pid, status.json, control token) plus its control routes.

/**
 * @import { TestContext } from 'node:test'
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { AddressInfo } from 'node:net'
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { collect, executeSql } from 'squirreling'

import { writePidFile } from '../../src/core/daemon/pid.js'
import { writeStatusFile } from '../../src/core/daemon/status.js'
import { TracerProvider } from '../../src/core/observability/runtime.js'
import { runRemoteRemove } from '../../src/core/cli/remote_commands.js'
import { canonicalOrigin } from '../../src/core/remote/builtin_remotes.js'
import { pluginStateDir } from '../../src/core/runtime/paths.js'
import {
  DEFAULT_BUDGET_MS, EVIDENCE_NEEDS_REMOTE, parseFastaskArgs, renderEvidenceText, runFastask, runQueryEvidence, runReplicaRefresh, runReplicaStatus,
} from '../../hypaware-core/plugins-workspace/fastask/src/commands.js'
import { discover } from '../../hypaware-core/plugins-workspace/fastask/src/discovery.js'
import { createIndexBuilder } from '../../hypaware-core/plugins-workspace/fastask/src/index_builder.js'
import { DISCOVER_ROUTE, EVIDENCE_ROUTE, REFRESH_ROUTE, SOURCE_NAME, TOKEN_FILE } from '../../hypaware-core/plugins-workspace/fastask/src/replica_source.js'
import { replicaKey } from '../../hypaware-core/plugins-workspace/fastask/src/replica_store.js'

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'contracts', 'graph-snapshot', 'v1')
const readNdjson = (/** @type {string} */ name) => fs.readFileSync(path.join(FIXTURE, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const NODES = readNdjson('nodes.ndjson')
const EDGES = readNdjson('edges.ndjson')
/** The session the fixture's touched edge leads to, and a question that finds it. */
const QUESTION = 'why is app.js shaped this way'
const LEAD = 'fx-session-0001'
const MESSAGES = [
  { session_id: LEAD, message_id: 'fx-msg-0002', part_id: 'fx-msg-0002#0', role: 'user', part_type: 'text', message_index: 1, part_index: 0, message_created_at: '2026-08-31T22:36:00.000Z', date: '2026-08-31', content_text: 'Why does app.js poll?' },
  { session_id: LEAD, message_id: 'fx-msg-0003', part_id: 'fx-msg-0003#0', role: 'assistant', part_type: 'text', message_index: 2, part_index: 0, message_created_at: '2026-08-31T22:36:30.000Z', date: '2026-08-31', content_text: 'Because the socket path was flaky.' },
]

/**
 * A disposable HYP_HOME with the `fx` remote configured as the default and a
 * token in the environment, a repository directory for the caller's cwd, and
 * a command context over them.
 * @param {TestContext} t
 * @param {{ url?: string, login?: boolean }} [opts]
 */
function home(t, opts = {}) {
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-fastask-cmd-'))
  t.after(() => fs.rmSync(hypHome, { recursive: true, force: true }))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  const config = opts.url
    ? { version: 2, auto_update: false, query: { default_remote: 'fx', remotes: { fx: { url: opts.url } } } }
    : { version: 2, auto_update: false }
  fs.writeFileSync(configPath, JSON.stringify(config))
  const repo = path.join(hypHome, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:fx-org/fx-repo.git\n')
  /** @type {NodeJS.ProcessEnv} */
  const env = { HYP_HOME: hypHome, HYP_CONFIG: configPath, ...(opts.url && opts.login !== false ? { HYP_REMOTE_TOKEN_FX: 'fx-token' } : {}) }
  const stateRoot = path.join(hypHome, 'hypaware')
  const pluginDir = pluginStateDir(stateRoot, '@hypaware/fastask')
  return { hypHome, configPath, config, env, repo, stateRoot, pluginDir }
}

/** @param {ReturnType<typeof home>} h */
function ctxOf(h) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const ctx = /** @type {any} */ ({
    env: h.env,
    cwd: h.repo,
    config: h.config,
    query: { getDataset: () => undefined },
    storage: {},
    stdout: { write: (/** @type {string} */ s) => { out.push(s); return true } },
    stderr: { write: (/** @type {string} */ s) => { err.push(s); return true } },
  })
  return { ctx, out: () => out.join(''), err: () => err.join('') }
}

/**
 * The loopback team server. `evidence` picks how session_evidence answers.
 * @param {TestContext} t
 * @param {{ evidence?: 'ok' | 'missing' | 'busy', tools?: boolean }} [opts]
 */
async function teamServer(t, opts = {}) {
  /** @type {Array<{ name: string, args: any, auth: string | undefined }>} */
  const calls = []
  const tables = { node: NODES, edge: EDGES, ai_gateway_messages: MESSAGES }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const msg = JSON.parse(raw)
      if (msg.method === 'initialize') return reply(res, msg.id, { protocolVersion: '2025-06-18' })
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
      if (msg.method === 'tools/list') {
        const evidenceTool = { name: 'session_evidence', inputSchema: { properties: { contract: { type: 'string', enum: ['hypaware.session-evidence/1'] } } } }
        return reply(res, msg.id, { tools: [{ name: 'query_sql' }, ...(opts.tools === false ? [] : [evidenceTool])] })
      }
      const { name, arguments: args } = msg.params
      calls.push({ name, args, auth: req.headers.authorization })
      if (name === 'query_sql') {
        const rows = await collect(executeSql({ query: args.sql, tables }))
        return reply(res, msg.id, { structuredContent: { columns: Object.keys(rows[0] ?? {}), rows } })
      }
      if (name === 'session_evidence') {
        if (opts.evidence === 'missing') return reply(res, msg.id, undefined, { code: -32601, message: 'Unknown tool: session_evidence' })
        if (opts.evidence === 'busy') { res.writeHead(429); return res.end('org_read_capacity') }
        return reply(res, msg.id, { structuredContent: evidenceAnswer(args) })
      }
      reply(res, msg.id, undefined, { code: -32601, message: `Unknown tool: ${name}` })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)) }))
  const { port } = /** @type {AddressInfo} */ (server.address())
  return { url: `http://127.0.0.1:${port}`, calls }
}

/** A session_evidence answer from MESSAGES, every entry read in full. @param {any} args */
function evidenceAnswer(args) {
  const sessions = args.sessions.map((/** @type {string} */ s, /** @type {number} */ i) => {
    const entry = JSON.parse(s)
    const parts = MESSAGES.filter((m) => m.session_id === entry.session_id)
      .filter((m) => !entry.from || m.message_created_at >= entry.from)
      .filter((m) => !entry.to || m.message_created_at < entry.to)
      .filter((m) => !entry.message_ids || entry.message_ids.includes(m.message_id))
      .map(({ date, ...p }) => ({ ...p, text_truncated: false }))
    return { request_index: i, session_id: entry.session_id, status: parts.length || MESSAGES.some((m) => m.session_id === entry.session_id) ? 'ok' : 'not_found', parts, truncated: false, next_cursor: null, coverage: { received_through: '2026-10-09T02:00:00.000Z', read_path: 'indexed', fallback_reason: null } }
  })
  return { contract: 'hypaware.session-evidence/1', server_version: '1.40.0', complete: true, deadline_reached: false, elapsed_ms: 2, sessions }
}

/** @param {ServerResponse} res @param {number} id @param {unknown} result @param {unknown} [error] */
function reply(res, id, result, error) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }))
}

/**
 * The replica on disk, as the sync loop writes it: the pinned fixture as the
 * active generation, with a lease that has or has not expired.
 * @param {ReturnType<typeof home>} h @param {string} url @param {{ expired?: boolean }} [opts]
 */
function writeReplica(h, url, opts = {}) {
  const origin = /** @type {string} */ (canonicalOrigin(url))
  const key = replicaKey(origin, null)
  const dir = path.join(h.pluginDir, 'replicas', key)
  const gen = path.join(dir, 'generations', 'g1')
  fs.mkdirSync(gen, { recursive: true })
  for (const f of ['manifest.json', 'nodes.ndjson.gz', 'edges.ndjson.gz']) fs.copyFileSync(path.join(FIXTURE, f), path.join(gen, f))
  const lease = new Date(Date.now() + (opts.expired ? -60_000 : 3_600_000)).toISOString()
  fs.writeFileSync(path.join(dir, 'replica.json'), JSON.stringify({
    format: 1, key, target: 'fx', origin, org: null, generation: 'g1', state: 'synced', reason: null,
    watermark: '2026-10-09T01:00:00.000Z', watermark_kind: 'commit', published_at: '2026-10-09T01:00:00.000Z',
    rows: { nodes: NODES.length, edges: EDGES.length }, lease_seconds: 3600, lease_expires_at: lease,
    poll: null, credential_fp: null, last_check: null, last_success: null, last_error: null,
  }))
  return dir
}

/** The fixture graph as a warm daemon holds it. */
async function fixtureIndex() {
  const builder = createIndexBuilder()
  for (const n of NODES) builder.addNode(n)
  for (const e of EDGES) builder.addEdge(e)
  return builder.finish()
}

/**
 * A running daemon as the command sees one: a live pid, a status.json naming
 * the source's control routes, the per-boot token, and the routes themselves.
 * @param {TestContext} t @param {ReturnType<typeof home>} h @param {{ evidence?: (args: any) => any }} [opts]
 */
async function fakeDaemon(t, h, opts = {}) {
  const token = 'daemon-token'
  fs.mkdirSync(h.pluginDir, { recursive: true })
  fs.writeFileSync(path.join(h.pluginDir, TOKEN_FILE), token)
  const index = await fixtureIndex()
  /** @type {Array<{ route: string, body: any, auth: string | undefined }>} */
  const hits = []
  const replica = { state: 'synced', reason: null, servable: true, target: 'fx', org: null, generation: 'g1', watermark: '2026-10-09T01:00:00.000Z', watermark_age_s: 600 }
  const server = http.createServer((/** @type {IncomingMessage} */ req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const route = String(req.url).replace('/_hypaware/', '')
      const body = raw ? JSON.parse(raw) : null
      hits.push({ route, body, auth: req.headers.authorization })
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end() }
      res.setHeader('content-type', 'application/json')
      if (route === DISCOVER_ROUTE) return res.end(JSON.stringify({ source: 'team_replica', replica, result: discover(index, body) }))
      if (route === EVIDENCE_ROUTE) return res.end(JSON.stringify(opts.evidence ? opts.evidence(body.arguments) : { ok: true, round_trip_ms: 12, result: { structuredContent: evidenceAnswer(body.arguments) } }))
      if (route === REFRESH_ROUTE) { res.writeHead(202); return res.end(JSON.stringify({ accepted: true, replica })) }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)) }))
  const { port } = /** @type {AddressInfo} */ (server.address())
  writePidFile(h.stateRoot, { pid: process.pid, startedAt: new Date().toISOString(), runId: 'fake', mode: 'foreground' })
  writeStatusFile(h.stateRoot, /** @type {any} */ ({
    state: 'healthy', pid: process.pid, startedAt: new Date().toISOString(), healthyAt: new Date().toISOString(), uptimeMs: 1, runId: 'fake', mode: 'foreground', sinks: [],
    sources: [{ name: SOURCE_NAME, plugin: '@hypaware/fastask', state: 'running', details: {
      ...replica, summary_line: 'team graph: synced, data as of 10 min ago, 2 KB', listen_host: '127.0.0.1', listen_port: port,
      control_routes: [DISCOVER_ROUTE, EVIDENCE_ROUTE, REFRESH_ROUTE],
    } }],
  }))
  return { hits }
}

/** @param {string} text */
const parse = (text) => JSON.parse(text)

// ----- Flags and exit codes -----

test('flags: defaults, values, and every usage error exits 2', async (t) => {
  assert.deepEqual(parseFastaskArgs(['why', 'login', '--file', 'a.js', '--file=b.js', '--leads', '3', '--json']),
    { question: 'why login', remote: null, org: null, repo: null, files: ['a.js', 'b.js'], budgetMs: DEFAULT_BUDGET_MS, leads: 3, json: true })
  const h = home(t)
  for (const argv of [[], ['--json'], ['q', '--budget-ms', '5'], ['q', '--budget-ms', 'soon'], ['q', '--leads', '41'], ['q', '--leads', '0'], ['q', '--bogus'], ['q', '--remote'], ['q', '--json=yes'], ['q', '-x']]) {
    const { ctx, err } = ctxOf(h)
    assert.equal(await runFastask(argv, ctx), 2, argv.join(' '))
    assert.match(err(), /usage: hyp fastask/)
  }
  const { ctx, out } = ctxOf(h)
  assert.equal(await runFastask(['--help'], ctx), 0)
  assert.match(out(), /--budget-ms/)
})

// ----- Sources -----

test('local: no remote login answers from local captures and says so', async (t) => {
  const h = home(t)
  const { ctx, out } = ctxOf(h)
  assert.equal(await runFastask([QUESTION, '--json'], ctx), 0)
  const doc = parse(out())
  assert.equal(doc.source.kind, 'local')
  assert.match(doc.source.note, /local captures only/)
  assert.deepEqual(doc.leads, [])
  const text = ctxOf(h)
  assert.equal(await runFastask([QUESTION], text.ctx), 0)
  assert.match(text.out(), /^source: local \(local\)/)
  assert.match(text.out(), /No leads/)
  assert.match(text.out(), /local captures only\n$/)
})

test('team_server: no replica yet, so discovery runs by SQL on the server, labeled slow with the reason', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  const { ctx, out } = ctxOf(h)
  assert.equal(await runFastask([QUESTION, '--json'], ctx), 0)
  const doc = parse(out())
  assert.equal(doc.source.kind, 'team_server')
  assert.match(doc.source.note, /slow.*not been downloaded/)
  assert.equal(doc.leads[0]?.session_id, LEAD)
  assert.equal(doc.leads[0].evidence.status, 'ok')
  assert.deepEqual(doc.leads[0].evidence.parts.map((/** @type {any} */ p) => p.content_text), MESSAGES.map((m) => m.content_text))
  assert.deepEqual(Object.keys(doc.timings_ms), ['load', 'connect', 'discovery', 'evidence', 'total'])
  assert.equal(doc.timings_ms.load, 0)
  assert.ok(server.calls.every((c) => c.auth === 'Bearer fx-token'), 'the remote bearer rides every call')
  assert.ok(server.calls.some((c) => c.name === 'query_sql' && /FROM edge/.test(c.args.sql)), 'discovery read the touched edges by SQL')
})

test('cold: the daemon is not running, so the command loads the replica on disk and labels the load time', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  writeReplica(h, server.url)
  const { ctx, out } = ctxOf(h)
  assert.equal(await runFastask([QUESTION, '--json'], ctx), 0)
  const doc = parse(out())
  assert.equal(doc.source.kind, 'team_replica')
  assert.equal(doc.source.path, 'cold')
  assert.equal(doc.source.generation, 'g1')
  assert.match(doc.source.note, /^daemon not running: loaded the team graph in \d+ ms$/)
  assert.equal(doc.leads[0]?.session_id, LEAD)
  assert.equal(doc.leads[0].evidence.status, 'ok')
  assert.ok(!server.calls.some((c) => c.name === 'query_sql'), 'the replica answered discovery; the server only gave evidence')
})

test('spans: fastask.run, fastask.discover and fastask.evidence carry counts and timings, never the question', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  writeReplica(h, server.url)
  /** @type {any[]} */
  const captured = []
  const provider = new TracerProvider({ resource: { attributes: {} }, exporters: [{ exportBatch(spans) { captured.push(...spans) } }] })
  provider.register()
  t.after(() => provider.shutdown())
  const { ctx } = ctxOf(h)
  assert.equal(await runFastask([`${QUESTION} private-question-marker`, '--json'], ctx), 0)
  const byName = (/** @type {string} */ name) => captured.filter((x) => x.name === name)
  const [run] = byName('fastask.run')
  assert.ok(run, 'fastask.run')
  assert.equal(run.attributes.source_kind, 'team_replica')
  assert.equal(run.attributes.source_path, 'cold')
  assert.equal(run.attributes.leads, 1)
  for (const phase of ['load', 'connect', 'discovery', 'evidence', 'total']) assert.equal(typeof run.attributes[`timing_${phase}_ms`], 'number', phase)
  const [disc] = byName('fastask.discover')
  assert.equal(disc?.attributes.path, 'cold')
  const [ev] = byName('fastask.evidence')
  assert.equal(ev?.attributes.path, 'session_evidence')
  assert.equal(ev?.attributes.status_ok, 1)
  assert.equal(ev?.attributes.fallback, false)
  assert.ok(!JSON.stringify(captured).includes('private-question-marker'), 'no question text in telemetry')
})

test('an expired replica is not served: team_server answers with the reason', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  writeReplica(h, server.url, { expired: true })
  const { ctx, out } = ctxOf(h)
  assert.equal(await runFastask([QUESTION, '--json'], ctx), 0)
  const doc = parse(out())
  assert.equal(doc.source.kind, 'team_server')
  assert.match(doc.source.note, /lease expired/)
})

test('warm: the daemon answers discovery and forwards evidence; no MCP handshake from the command', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  const daemon = await fakeDaemon(t, h)
  const { ctx, out } = ctxOf(h)
  assert.equal(await runFastask([QUESTION, '--json', '--leads', '2'], ctx), 0)
  const doc = parse(out())
  assert.equal(doc.source.kind, 'team_replica')
  assert.equal(doc.source.path, 'warm')
  assert.equal(doc.source.note, null)
  assert.equal(doc.leads[0]?.session_id, LEAD)
  assert.equal(doc.leads[0].evidence.status, 'ok')
  assert.equal(doc.timings_ms.connect, 0)
  assert.equal(doc.timings_ms.load, 0)
  assert.deepEqual(daemon.hits.map((x) => x.route), [DISCOVER_ROUTE, EVIDENCE_ROUTE])
  assert.equal(daemon.hits[0].body.repo, 'fx-org/fx-repo', "the caller's repository is read from its origin remote")
  assert.equal(daemon.hits[0].body.leads, 2)
  assert.equal(server.calls.length, 0, 'the command itself never contacted the server')
})

test('warm, server without the verb: the fallback goes over the command\'s own connection, labeled', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  await fakeDaemon(t, h, { evidence: () => ({ ok: false, kind: 'unsupported', message: 'no session_evidence' }) })
  const { ctx, out } = ctxOf(h)
  assert.equal(await runFastask([QUESTION, '--json'], ctx), 0)
  const doc = parse(out())
  assert.equal(doc.source.path, 'warm')
  assert.equal(doc.coverage.evidence_path, 'query_sql')
  assert.equal(doc.coverage.evidence_label, 'server without evidence index support')
  assert.ok(server.calls.length > 0 && server.calls.every((c) => c.name === 'query_sql'))
})

test('nothing could be read for the leads: exit 1 with the reason, and the document still printed', async (t) => {
  const server = await teamServer(t, { evidence: 'busy' })
  const h = home(t, { url: server.url })
  writeReplica(h, server.url)
  const { ctx, out, err } = ctxOf(h)
  assert.equal(await runFastask([QUESTION, '--json'], ctx), 1)
  assert.equal(parse(out()).coverage.evidence_failure.code, 'server_busy')
  const human = ctxOf(h)
  assert.equal(await runFastask([QUESTION], human.ctx), 1)
  assert.match(human.err(), /evidence could not be read: server busy/)
  assert.equal(err(), '')
})

test('an unreachable team server is an aggregate failure, exit 1', async (t) => {
  const h = home(t, { url: 'http://127.0.0.1:9' })
  const { ctx, err } = ctxOf(h)
  assert.equal(await runFastask([QUESTION, '--remote', 'fx'], ctx), 1)
  assert.match(err(), /cannot read 'fx'/)
})

// ----- graph replica status and refresh -----

test('graph replica status: no login, a replica on disk with the daemon down, and a running daemon', async (t) => {
  const none = home(t)
  const a = ctxOf(none)
  assert.equal(await runReplicaStatus([], a.ctx), 0)
  assert.match(a.out(), /no default remote login/)

  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  const b = ctxOf(h)
  assert.equal(await runReplicaStatus([], b.ctx), 0)
  assert.equal(b.out(), 'team graph: not downloaded yet (daemon not running)\n')
  writeReplica(h, server.url)
  const c = ctxOf(h)
  assert.equal(await runReplicaStatus(['--json'], c.ctx), 0)
  const doc = parse(c.out())
  assert.equal(doc.daemon, 'not_running')
  assert.equal(doc.state, 'synced')
  assert.match(doc.summary_line, /^team graph: synced, .*\(daemon not running\)$/)
  assert.ok(!('generation_dir' in doc) && !('listen_port' in doc), 'no paths or ports')

  await fakeDaemon(t, h)
  const d = ctxOf(h)
  assert.equal(await runReplicaStatus([], d.ctx), 0)
  assert.equal(d.out(), 'team graph: synced, data as of 10 min ago, 2 KB\n')
  const e = ctxOf(h)
  assert.equal(await runReplicaStatus(['extra'], e.ctx), 2)
})

test('graph replica refresh: asks the running daemon, or says the daemon is not running', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  const down = ctxOf(h)
  assert.equal(await runReplicaRefresh([], down.ctx), 1)
  assert.match(down.err(), /daemon is not running/)
  const daemon = await fakeDaemon(t, h)
  const up = ctxOf(h)
  assert.equal(await runReplicaRefresh([], up.ctx), 0)
  assert.match(up.out(), /check started/)
  assert.deepEqual(daemon.hits.map((x) => [x.route, x.auth]), [[REFRESH_ROUTE, 'Bearer daemon-token']])
})

// ----- query evidence -----

test('query evidence: usage errors exit 2, and without --remote it says why', async (t) => {
  const h = home(t)
  for (const [argv, pattern] of /** @type {Array<[string[], RegExp]>} */ ([
    [['--session', '{"session_id":"s"}'], new RegExp(EVIDENCE_NEEDS_REMOTE)],
    [['--remote', 'fx'], /at least one --session/],
    [['--remote', 'fx', '--session', 'not json'], /JSON object/],
    [['--remote', 'fx', '--session', '{"x":1}'], /session_id/],
    [['--remote', 'fx', '--session', '{"session_id":"s"}', '--whatever'], /unexpected argument/],
  ])) {
    const { ctx, err } = ctxOf(h)
    assert.equal(await runQueryEvidence(argv, ctx), 2, argv.join(' '))
    assert.match(err(), pattern)
  }
})

test('the conversation follow-up fastask prints runs as printed and reads the server', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  writeReplica(h, server.url)
  const { ctx, out } = ctxOf(h)
  assert.equal(await runFastask([QUESTION, '--json'], ctx), 0)
  const doc = parse(out())
  const conversation = doc.followups.find((/** @type {any} */ f) => /query evidence/.test(f.command))
  assert.ok(conversation, 'the verb path offers query evidence')
  const argv = shellSplit(conversation.command)
  assert.deepEqual(argv.slice(0, 3), ['hyp', 'query', 'evidence'])
  const run = ctxOf(h)
  assert.equal(await runQueryEvidence(argv.slice(3), run.ctx), 0, run.err())
  const body = parse(run.out())
  assert.equal(body.sessions[0].session_id, LEAD)
  assert.equal(body.sessions[0].status, 'ok')
  const sent = server.calls.at(-1)
  assert.equal(sent?.name, 'session_evidence')
  assert.equal(sent?.args.contract, 'hypaware.session-evidence/1')
  assert.deepEqual(sent?.args.sessions, [JSON.stringify({ session_id: LEAD })], 'the entry reaches the server as one JSON string')
})

// ----- remote remove -----

test('hyp remote remove deletes that target\'s replica directly and leaves others', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  const fx = writeReplica(h, server.url)
  const other = path.join(h.pluginDir, 'replicas', 'other--org--000000000000')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'replica.json'), JSON.stringify({ target: 'elsewhere' }))
  const { ctx, out } = ctxOf(h)
  assert.equal(await runRemoteRemove(['fx'], ctx), 0)
  assert.match(out(), /removed remote 'fx'.*and its team graph replica/)
  assert.equal(fs.existsSync(fx), false)
  assert.equal(fs.existsSync(other), true)
})

/** Split a POSIX shell command line. @param {string} line */
function shellSplit(line) {
  /** @type {string[]} */
  const out = []
  let cur = ''
  let quote = ''
  let started = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") { if (c === "'") quote = ''; else cur += c; continue }
    if (quote === '"') { if (c === '"') quote = ''; else if (c === '\\') cur += line[++i]; else cur += c; continue }
    if (c === "'" || c === '"') { quote = c; started = true; continue }
    if (c === '\\') { cur += line[++i]; started = true; continue }
    if (c === ' ') { if (started) { out.push(cur); cur = ''; started = false } continue }
    cur += c
    started = true
  }
  if (started) out.push(cur)
  return out
}

test('query evidence text: skipped parts, unconfirmed freshness and an unresolvable cursor are worded for the reader', () => {
  const text = renderEvidenceText({ sessions: [
    { session_id: 'a', status: 'partial', parts: [], skipped_parts: 3, next_cursor: 'c' },
    { session_id: 'b', status: 'error', parts: [], error: { code: 'freshness_unavailable', message: 'no watermark' } },
    { session_id: 'c', status: 'error', parts: [], error: { code: 'cursor_unresolvable', message: 'tie group too large' } },
    { session_id: 'd', status: 'not_found', parts: [] },
  ] })
  assert.match(text, /^a: partial - 3 parts too large to return were skipped$/m)
  assert.match(text, /^b: error - the server could not confirm how fresh its evidence is$/m)
  assert.match(text, /^c: error - the server could not continue this session's evidence$/m)
  assert.match(text, /^d: not_found - no readable text \(purged, deleted or outside your access\)$/m)
})
