// @ts-check

// The agent-callable team-graph commands (LLP 0481 T15, LLP 0487#decision):
// query team-graph discover, neighbors and search over each source (warm
// through a running daemon, cold from a replica on disk, team_server, local),
// their flags and exit codes, the scope every warm request carries (review r1
// F1), and the ids and follow-up commands each document hands to the next
// operation. Everything runs in a disposable HYP_HOME against loopback fakes:
// a team server answering MCP (query_sql over the pinned graph fixture and a
// few messages, graph_neighbors over the same graph), and a "daemon" made of
// the files a live daemon leaves plus its control routes.

/**
 * @import { TestContext } from 'node:test'
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
import { canonicalOrigin } from '../../src/core/remote/builtin_remotes.js'
import { pluginStateDir } from '../../src/core/runtime/paths.js'
import { runQueryEvidence } from '../../hypaware-core/plugins-workspace/graph-cache/src/commands.js'
import { discover, neighbors } from '../../hypaware-core/plugins-workspace/graph-cache/src/discovery.js'
import { createIndexBuilder } from '../../hypaware-core/plugins-workspace/graph-cache/src/index_builder.js'
import { DISCOVER_ROUTE, NEIGHBORS_ROUTE, SOURCE_NAME, TOKEN_FILE } from '../../hypaware-core/plugins-workspace/graph-cache/src/replica_source.js'
import { replicaKey } from '../../hypaware-core/plugins-workspace/graph-cache/src/replica_store.js'
import {
  DISCOVER_CONTRACT, NEIGHBORS_CONTRACT, QUERY_STARTS, SEARCH_CONTRACT, runTeamGraphDiscover, runTeamGraphNeighbors, runTeamGraphSearch,
} from '../../hypaware-core/plugins-workspace/graph-cache/src/team_graph.js'

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'contracts', 'graph-snapshot', 'v1')
const readNdjson = (/** @type {string} */ name) => fs.readFileSync(path.join(FIXTURE, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const NODES = readNdjson('nodes.ndjson')
const EDGES = readNdjson('edges.ndjson')
const SESSION = 'fx-session-0001'
const SESSION_NODE = '064cdf336fa1a22c8057df70'
const APP_JS = 'daed8234d97ecd3c21815e80'
const MESSAGES = [
  { session_id: SESSION, message_id: 'fx-msg-0002', part_id: 'fx-msg-0002#0', role: 'user', part_type: 'text', message_index: 1, part_index: 0, message_created_at: '2026-08-31T22:36:00.000Z', date: '2026-08-31', content_text: 'Why does app.js poll the socket?' },
  { session_id: SESSION, message_id: 'fx-msg-0003', part_id: 'fx-msg-0003#0', role: 'assistant', part_type: 'text', message_index: 2, part_index: 0, message_created_at: '2026-08-31T22:36:30.000Z', date: '2026-08-31', content_text: 'Because the socket path was flaky.' },
]

/**
 * A disposable HYP_HOME, the `fx` remote as the default with a token in the
 * environment (unless `url` is absent), a repository for the caller's cwd.
 * @param {TestContext} t
 * @param {{ url?: string }} [opts]
 */
function home(t, opts = {}) {
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-team-graph-'))
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
  const env = { HYP_HOME: hypHome, HYP_CONFIG: configPath, ...(opts.url ? { HYP_REMOTE_TOKEN_FX: 'fx-token' } : {}) }
  const stateRoot = path.join(hypHome, 'hypaware')
  return { hypHome, config, env, repo, stateRoot, pluginDir: pluginStateDir(stateRoot, '@hypaware/graph-cache') }
}

/**
 * @param {ReturnType<typeof home>} h
 * @param {{ verbs?: any, getDataset?: () => any }} [opts]
 */
function ctxOf(h, opts = {}) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const ctx = /** @type {any} */ ({
    env: h.env, cwd: h.repo, config: h.config,
    query: { getDataset: opts.getDataset ?? (() => undefined) }, storage: {}, verbs: opts.verbs,
    stdout: { write: (/** @type {string} */ s) => { out.push(s); return true } },
    stderr: { write: (/** @type {string} */ s) => { err.push(s); return true } },
  })
  return { ctx, out: () => out.join(''), err: () => err.join(''), json: () => JSON.parse(out.join('')) }
}

/** The fixture graph as an index. */
async function fixtureIndex() {
  const builder = createIndexBuilder()
  for (const n of NODES) builder.addNode(n)
  for (const e of EDGES) builder.addEdge(e)
  return builder.finish()
}

/**
 * graph_neighbors over the fixture, as the context-graph verb answers it:
 * the seed by id or key, one hop, both directions unless asked.
 * @param {any} args
 */
function graphNeighborsAnswer(args) {
  const seed = NODES.find((n) => n.node_id === args.node || n.natural_key === args.node)
  if (!seed) return { ok: false, error: `no node matches '${args.node}'` }
  const node = (/** @type {string} */ id) => {
    const n = NODES.find((x) => x.node_id === id)
    return n ? { node_id: n.node_id, node_type: n.node_type, natural_key: n.natural_key, label: n.label } : { node_id: id, node_type: 'Unknown', natural_key: id, label: null }
  }
  const out = []
  for (const e of EDGES) {
    if (args.edge_type && !args.edge_type.includes(e.edge_type)) continue
    if (args.direction !== 'in' && e.src_id === seed.node_id) out.push({ hop: 1, edge_type: e.edge_type, direction: 'out', from: seed.node_id, node: node(e.dst_id), source_keys: e.source_keys })
    if (args.direction !== 'out' && e.dst_id === seed.node_id) out.push({ hop: 1, edge_type: e.edge_type, direction: 'in', from: seed.node_id, node: node(e.src_id), source_keys: e.source_keys })
  }
  return { ok: true, seed: node(seed.node_id), neighbors: out.slice(0, args.limit), reachable: out.length, truncated: out.length > args.limit, totalNodes: out.length + 1, totalEdges: out.length }
}

/**
 * The loopback team server: query_sql over the fixture and MESSAGES,
 * graph_neighbors over the fixture, session_evidence over MESSAGES.
 * `failSql` makes query_sql fail for SQL containing that text.
 * @param {TestContext} t
 * @param {{ failSql?: string }} [opts]
 */
async function teamServer(t, opts = {}) {
  /** @type {Array<{ name: string, args: any }>} */
  const calls = []
  const tables = { node: NODES, edge: EDGES, ai_gateway_messages: MESSAGES }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const msg = JSON.parse(raw)
      const reply = (/** @type {unknown} */ result, /** @type {unknown} */ error = undefined) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(error ? { jsonrpc: '2.0', id: msg.id, error } : { jsonrpc: '2.0', id: msg.id, result }))
      }
      if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18' })
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
      if (msg.method === 'tools/list') return reply({ tools: [{ name: 'query_sql' }, { name: 'graph_neighbors' }, { name: 'session_evidence', inputSchema: { properties: { contract: { type: 'string', enum: ['hypaware.session-evidence/1'] } } } }] })
      const { name, arguments: args } = msg.params
      calls.push({ name, args })
      if (name === 'query_sql') {
        if (opts.failSql && args.sql.includes(opts.failSql)) return reply({ isError: true, content: [{ type: 'text', text: 'query_sql failed: boom' }] })
        const rows = await collect(executeSql({ query: args.sql, tables }))
        return reply({ structuredContent: { columns: Object.keys(rows[0] ?? {}), rows } })
      }
      if (name === 'graph_neighbors') return reply({ structuredContent: graphNeighborsAnswer(args) })
      if (name === 'session_evidence') {
        const sessions = args.sessions.map((/** @type {string} */ s, /** @type {number} */ i) => {
          const entry = JSON.parse(s)
          const parts = MESSAGES.filter((m) => m.session_id === entry.session_id && (!entry.from || m.message_created_at >= entry.from) && (!entry.to || m.message_created_at < entry.to))
            .map(({ date, ...p }) => ({ ...p, text_truncated: false }))
          return { request_index: i, session_id: entry.session_id, status: 'ok', parts, truncated: false, next_cursor: null, coverage: { received_through: '2026-10-09T02:00:00.000Z', read_path: 'indexed', fallback_reason: null } }
        })
        return reply({ structuredContent: { contract: 'hypaware.session-evidence/1', server_version: '1.40.0', complete: true, deadline_reached: false, elapsed_ms: 2, sessions } })
      }
      reply(undefined, { code: -32601, message: `Unknown tool: ${name}` })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)) }))
  const { port } = /** @type {AddressInfo} */ (server.address())
  return { url: `http://127.0.0.1:${port}`, calls }
}

/**
 * The pinned fixture as the active generation on disk, as the sync loop writes it.
 * @param {ReturnType<typeof home>} h @param {string} url
 */
function writeReplica(h, url) {
  const origin = /** @type {string} */ (canonicalOrigin(url))
  const key = replicaKey(origin, null)
  const dir = path.join(h.pluginDir, 'replicas', key)
  const gen = path.join(dir, 'generations', 'g1')
  fs.mkdirSync(gen, { recursive: true })
  for (const f of ['manifest.json', 'nodes.ndjson.gz', 'edges.ndjson.gz']) fs.copyFileSync(path.join(FIXTURE, f), path.join(gen, f))
  fs.writeFileSync(path.join(dir, 'replica.json'), JSON.stringify({
    format: 1, key, target: 'fx', origin, org: null, generation: 'g1', state: 'synced', reason: null,
    watermark: '2026-10-09T01:00:00.000Z', watermark_kind: 'commit', published_at: '2026-10-09T01:00:00.000Z',
    rows: { nodes: NODES.length, edges: EDGES.length }, lease_seconds: 3600, lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    poll: null, credential_fp: null, last_check: null, last_success: null, last_error: null,
  }))
}

/**
 * A running daemon as the commands see one: live pid, status.json naming the
 * source's routes, the per-boot token, and the discover and neighbors routes.
 * @param {TestContext} t @param {ReturnType<typeof home>} h @param {{ refuse?: 'remote' | 'org' | 'login' }} [opts]
 */
async function fakeDaemon(t, h, opts = {}) {
  const token = 'daemon-token'
  fs.mkdirSync(h.pluginDir, { recursive: true })
  fs.writeFileSync(path.join(h.pluginDir, TOKEN_FILE), token)
  const index = await fixtureIndex()
  /** @type {Array<{ route: string, body: any }>} */
  const hits = []
  const replica = { state: 'synced', reason: null, servable: true, target: 'fx', org: null, generation: 'g1', watermark: '2026-10-09T01:00:00.000Z', watermark_age_s: 600 }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const route = String(req.url).replace('/_hypaware/', '')
      const body = raw ? JSON.parse(raw) : null
      hits.push({ route, body })
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end() }
      res.setHeader('content-type', 'application/json')
      if (opts.refuse) { res.writeHead(409); return res.end(JSON.stringify({ error: 'scope_mismatch', reason: opts.refuse })) }
      if (route === DISCOVER_ROUTE) return res.end(JSON.stringify({ source: 'team_replica', replica, result: discover(index, body) }))
      if (route === NEIGHBORS_ROUTE) return res.end(JSON.stringify({ source: 'team_replica', replica, result: neighbors(index, body) }))
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
    sources: [{ name: SOURCE_NAME, plugin: '@hypaware/graph-cache', state: 'running', details: { ...replica, listen_host: '127.0.0.1', listen_port: port, control_routes: [DISCOVER_ROUTE, NEIGHBORS_ROUTE] } }],
  }))
  return { hits }
}

/**
 * Splits a printed follow-up the way a shell would (single quotes only).
 * @param {string} line
 */
function shellSplit(line) {
  /** @type {string[]} */
  const words = []
  let word = ''
  let quoted = false
  let any = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === "'") quoted = false
      else word += ch
    } else if (ch === "'") { quoted = true; any = true }
    else if (ch === ' ') { if (word || any) words.push(word); word = ''; any = false }
    else if (ch === '\\' && line[i + 1] === "'") { word += "'"; i++ }
    else word += ch
  }
  if (word || any) words.push(word)
  return words
}

/** @param {string} command a printed `hyp query team-graph <op> ...` @param {string} op */
function argvOf(command, op) {
  const words = shellSplit(command)
  assert.deepEqual(words.slice(0, 4), ['hyp', 'query', 'team-graph', op])
  return words.slice(4)
}

// ----- discover -----

test('discover: usage errors exit 2 and name the problem; --help prints the usage', async (t) => {
  const h = home(t)
  for (const [argv, message] of /** @type {Array<[string[], RegExp]>} */ ([
    [[], /at least one term or --file/],
    [Array.from({ length: 13 }, (_, i) => `t${i}`), /at most 12 terms/],
    [['app.js', '--limit', '0'], /--limit must be an integer from 1 to 40/],
    [['app.js', '--offset', 'x'], /--offset must be an integer/],
    [['app.js', '--bogus'], /unknown flag '--bogus'/],
    [['app.js', '--json=1'], /--json takes no value/],
  ])) {
    const c = ctxOf(h)
    assert.equal(await runTeamGraphDiscover(argv, c.ctx), 2, argv.join(' '))
    assert.match(c.err(), message)
  }
  const c = ctxOf(h)
  assert.equal(await runTeamGraphDiscover(['--help'], c.ctx), 0)
  assert.match(c.out(), /^hyp query team-graph discover <term>/)
})

test('discover, team_server: no replica yet, so the server answers by SQL with the reason; ids and follow-ups chain', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  const c = ctxOf(h)
  assert.equal(await runTeamGraphDiscover(['app.js', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.equal(out.contract, DISCOVER_CONTRACT)
  assert.deepEqual([out.source.kind, out.source.remote], ['team_server', 'fx'])
  assert.match(out.source.note, /not been downloaded yet/)
  assert.deepEqual(out.terms, [{ text: 'app.js', kind: 'path' }])
  assert.deepEqual(out.anchors.map((/** @type {any} */ a) => a.node_id), [APP_JS])
  assert.deepEqual(out.sessions.map((/** @type {any} */ s) => [s.session_id, s.node_id]), [[SESSION, SESSION_NODE]])
  assert.deepEqual(out.page, { offset: 0, limit: 8, next_offset: null })
  assert.equal(out.next.next_page, null)
  assert.equal(out.next.neighbors, `hyp query team-graph neighbors ${APP_JS} --direction in --remote fx --json`)
  assert.equal(out.next.search, `hyp query team-graph search --session ${SESSION} app.js --remote fx --json`)
  assert.ok(server.calls.every((c) => c.name === 'query_sql'))
})

test('discover, cold: the replica on disk answers, labeled with its load time and state', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  writeReplica(h, server.url)
  const c = ctxOf(h)
  assert.equal(await runTeamGraphDiscover(['--term', 'app.js', '--limit', '1', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.deepEqual([out.source.kind, out.source.path, out.source.replica_state], ['team_replica', 'cold', 'synced'])
  assert.match(out.source.note, /daemon not running: loaded the team graph in \d+ ms/)
  assert.equal(typeof out.source.watermark_age_s, 'number')
  assert.deepEqual(out.sessions.map((/** @type {any} */ s) => s.session_id), [SESSION])
  assert.equal(server.calls.length, 0, 'nothing read from the server')
})

test('discover, warm: the daemon answers with the explicit terms, the page and the caller\'s scope', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  const daemon = await fakeDaemon(t, h)
  const c = ctxOf(h)
  assert.equal(await runTeamGraphDiscover(['app.js', 'cafe', '--limit', '3', '--offset', '0', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.deepEqual([out.source.kind, out.source.path], ['team_replica', 'warm'])
  const body = daemon.hits[0].body
  assert.equal(daemon.hits[0].route, DISCOVER_ROUTE)
  assert.deepEqual([body.terms, body.leads, body.offset, body.question], [['app.js', 'cafe'], 3, 0, ''])
  assert.deepEqual(Object.keys(body.scope).sort(), ['credential_fp', 'org', 'origin', 'target'])
  assert.equal(body.scope.target, 'fx')
  assert.equal(body.scope.origin, canonicalOrigin(server.url))
  assert.deepEqual(out.sessions.map((/** @type {any} */ s) => s.node_id), [SESSION_NODE])
  assert.equal(server.calls.length, 0)
})

test('discover, warm: a daemon that refuses the scope is not used; the server answers and says why', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  writeReplica(h, server.url)
  await fakeDaemon(t, h, { refuse: 'login' })
  const c = ctxOf(h)
  assert.equal(await runTeamGraphDiscover(['app.js', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.equal(out.source.kind, 'team_server')
  assert.match(out.source.note, /belongs to another login/)
})

test('discover, --org reads the server and rides every follow-up', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  writeReplica(h, server.url)
  const c = ctxOf(h)
  assert.equal(await runTeamGraphDiscover(['app.js', '--org', 'acme', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.equal(out.source.kind, 'team_server')
  assert.match(out.source.note, /--org reads the server/)
  assert.match(out.next.neighbors, / --remote fx --org acme --json$/)
  assert.match(out.next.search, / --remote fx --org acme --json$/)
})

test('discover, local: no remote login answers from local captures and says when there is no capture graph', async (t) => {
  const h = home(t)
  const c = ctxOf(h)
  assert.equal(await runTeamGraphDiscover(['app.js', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.equal(out.source.kind, 'local')
  assert.match(out.source.note, /no capture graph here/)
  assert.deepEqual(out.sessions, [])
  assert.equal(out.next.neighbors, null)
})

test('discover, unreachable server: exit 1 with the reason', async (t) => {
  const h = home(t, { url: 'http://127.0.0.1:9' })
  const c = ctxOf(h)
  assert.equal(await runTeamGraphDiscover(['app.js'], c.ctx, { pluginDir: h.pluginDir }), 1)
  assert.match(c.err(), /cannot read 'fx'/)
})

// ----- neighbors -----

test('neighbors: usage errors exit 2', async (t) => {
  const h = home(t)
  for (const [argv, message] of /** @type {Array<[string[], RegExp]>} */ ([
    [[], /at least one node id or --key/],
    [['x', '--direction', 'up'], /--direction must be in, out or both/],
    [['x', '--limit', '501'], /--limit must be an integer from 1 to 500/],
    [['x', '--max-visits', '20001'], /--max-visits must be an integer from 1 to 20000/],
  ])) {
    const c = ctxOf(h)
    assert.equal(await runTeamGraphNeighbors(argv, c.ctx), 2, argv.join(' '))
    assert.match(c.err(), message)
  }
})

test('neighbors, warm: the daemon\'s neighbors route walks the index with the scope; placeholders are named', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  const daemon = await fakeDaemon(t, h)
  const c = ctxOf(h)
  assert.equal(await runTeamGraphNeighbors([APP_JS, '--direction', 'in', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.equal(out.contract, NEIGHBORS_CONTRACT)
  assert.deepEqual([out.source.kind, out.source.path], ['team_replica', 'warm'])
  assert.equal(daemon.hits[0].route, NEIGHBORS_ROUTE)
  assert.deepEqual([daemon.hits[0].body.ids, daemon.hits[0].body.direction], [[APP_JS], 'in'])
  assert.equal(daemon.hits[0].body.scope.target, 'fx')
  assert.deepEqual(out.starts, [{ input: APP_JS, by: 'id', found: true, node_id: APP_JS, type: 'File', key: '/work/fx-repo/src/app.js' }])
  const byId = Object.fromEntries(out.neighbors.map((/** @type {any} */ n) => [n.node.node_id, n]))
  assert.equal(byId[SESSION_NODE].node.key, SESSION)
  assert.equal(byId[SESSION_NODE].edge_type, 'touched')
  assert.deepEqual(byId[SESSION_NODE].exemplar, { message_id: 'fx-msg-0002', part_id: null })
  assert.equal(byId.fc9f47960a5086179e42f389.node.placeholder, true)
  assert.equal(out.coverage.unresolved_met, 1)
  assert.equal(out.next.search, `hyp query team-graph search --session ${SESSION} <term>... --remote fx --json`)
})

test('neighbors, cold: --key resolves on the replica on disk; out from a session reaches its files', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  writeReplica(h, server.url)
  const c = ctxOf(h)
  assert.equal(await runTeamGraphNeighbors(['--key', SESSION, '--direction', 'out', '--edge-type', 'touched', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.equal(out.source.path, 'cold')
  assert.deepEqual(out.starts[0].node_id, SESSION_NODE)
  assert.ok(out.neighbors.every((/** @type {any} */ n) => n.direction === 'out' && n.edge_type === 'touched'))
  assert.ok(out.neighbors.some((/** @type {any} */ n) => n.node.node_id === APP_JS))
})

test('neighbors, team_server: answered through graph_neighbors --remote, named, at most 8 starts', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  const c = ctxOf(h)
  const ids = [APP_JS, ...Array.from({ length: QUERY_STARTS + 2 }, (_, i) => `missing-${i}`)]
  assert.equal(await runTeamGraphNeighbors([...ids, '--direction', 'in', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.equal(out.source.kind, 'team_server')
  assert.match(out.source.note, /answered by query graph neighbors --remote/)
  assert.equal(server.calls.filter((x) => x.name === 'graph_neighbors').length, QUERY_STARTS)
  assert.equal(out.coverage.starts_dropped, 3)
  assert.deepEqual(server.calls[0].args, { node: APP_JS, depth: 1, direction: 'in', limit: 50 })
  assert.ok(out.neighbors.some((/** @type {any} */ n) => n.node.node_id === SESSION_NODE && n.from === APP_JS))
  assert.equal(out.starts.filter((/** @type {any} */ s) => !s.found).length, QUERY_STARTS - 1)
})

test('neighbors, local: the local query graph neighbors verb answers; without it, exit 1 with why', async (t) => {
  const h = home(t)
  const without = ctxOf(h)
  assert.equal(await runTeamGraphNeighbors([APP_JS], without.ctx, { pluginDir: h.pluginDir }), 1)
  assert.match(without.err(), /no capture graph here/)
  const verb = { operation: async (/** @type {any} */ params) => graphNeighborsAnswer(params) }
  const c = ctxOf(h, { verbs: { get: (/** @type {string} */ name) => (name === 'query graph neighbors' ? verb : undefined) } })
  assert.equal(await runTeamGraphNeighbors([APP_JS, '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.equal(out.source.kind, 'local')
  assert.ok(out.neighbors.length > 0)
})

test('neighbors: no start found exits 1, and the document says which', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  writeReplica(h, server.url)
  const c = ctxOf(h)
  assert.equal(await runTeamGraphNeighbors(['nope', '--json'], c.ctx, { pluginDir: h.pluginDir }), 1)
  assert.deepEqual(c.json().starts, [{ input: 'nope', by: 'id', found: false, node_id: null, type: null, key: null }])
})

// ----- search -----

test('search: usage errors exit 2', async (t) => {
  const h = home(t)
  for (const [argv, message] of /** @type {Array<[string[], RegExp]>} */ ([
    [['poll'], /at least one --session/],
    [['--session', 's'], /at least one term/],
    [[...Array.from({ length: 17 }, (_, i) => ['--session', `s${i}`]).flat(), 'poll'], /at most 16 sessions/],
    [['--session', 's', 'poll', '--hits', '51'], /--hits must be an integer from 1 to 50/],
    [['--session', 's', 'poll', '--chars', '10'], /--chars must be an integer from 40 to 2000/],
  ])) {
    const c = ctxOf(h)
    assert.equal(await runTeamGraphSearch(argv, c.ctx), 2, argv.join(' '))
    assert.match(c.err(), message)
  }
})

test('search, team_server: one query per session, hits with excerpts, and each read command runs as printed', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  const c = ctxOf(h)
  assert.equal(await runTeamGraphSearch(['--session', SESSION, '--session', 'fx-session-none', 'socket', '--term', 'FLAKY', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const out = c.json()
  assert.equal(out.contract, SEARCH_CONTRACT)
  assert.deepEqual([out.source.kind, out.source.remote], ['team_server', 'fx'])
  assert.deepEqual(out.terms, ['socket', 'FLAKY'])
  assert.equal(server.calls.filter((x) => x.name === 'query_sql').length, 2)
  const [found, none] = out.sessions
  assert.deepEqual(found.hits.map((/** @type {any} */ x) => [x.message_id, x.matched_terms]), [['fx-msg-0002', ['socket']], ['fx-msg-0003', ['socket', 'FLAKY']]])
  assert.deepEqual([none.session_id, none.hits, none.error], ['fx-session-none', [], null])
  const hit = found.hits[0]
  assert.equal(hit.read_command, `hyp query evidence --remote fx --session '${JSON.stringify(hit.read)}' --json`)
  const r = ctxOf(h)
  const argv = shellSplit(hit.read_command).slice(3)
  assert.equal(await runQueryEvidence(argv, r.ctx), 0, r.err())
  assert.match(r.out(), /poll the socket/)
})

test('search: a per-session hit budget, and one failing session leaves the others answered', async (t) => {
  const server = await teamServer(t, { failSql: "'fx-session-broken'" })
  const h = home(t, { url: server.url })
  const c = ctxOf(h)
  assert.equal(await runTeamGraphSearch(['--session', SESSION, '--session', 'fx-session-broken', 'socket', '--hits', '1', '--json'], c.ctx, { pluginDir: h.pluginDir }), 0)
  const [found, broken] = c.json().sessions
  assert.deepEqual([found.hits.length, found.truncated], [1, true])
  assert.match(broken.error, /boom/)
  const all = ctxOf(h)
  assert.equal(await runTeamGraphSearch(['--session', 'fx-session-broken', 'socket', '--json'], all.ctx, { pluginDir: h.pluginDir }), 1, 'nothing could be read')
})

// ----- chaining -----

test('the printed follow-ups chain: discover, then neighbors, then search, each run as printed', async (t) => {
  const server = await teamServer(t)
  const h = home(t, { url: server.url })
  writeReplica(h, server.url)
  const d = ctxOf(h)
  assert.equal(await runTeamGraphDiscover(['app.js', '--json'], d.ctx, { pluginDir: h.pluginDir }), 0)
  const discovered = d.json()
  const n = ctxOf(h)
  assert.equal(await runTeamGraphNeighbors(argvOf(discovered.next.neighbors, 'neighbors'), n.ctx, { pluginDir: h.pluginDir }), 0)
  const neighbored = n.json()
  assert.ok(neighbored.neighbors.some((/** @type {any} */ x) => x.node.key === SESSION))
  const s = ctxOf(h)
  assert.equal(await runTeamGraphSearch(argvOf(discovered.next.search, 'search'), s.ctx, { pluginDir: h.pluginDir }), 0)
  assert.equal(s.json().sessions[0].hits[0].message_id, 'fx-msg-0002')
})
