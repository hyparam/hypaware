// @ts-check

import { createHash } from 'node:crypto'
import http from 'node:http'
import { gzipSync } from 'node:zlib'
import { collect, executeSql } from 'squirreling'

import { EDGE_COLUMNS, NODE_COLUMNS, encodeLine, measureFile } from '../../plugins-workspace/fastask/src/contract.js'

/**
 * @import { AddressInfo } from 'node:net'
 */

/**
 * Shared fixture for the fastask smokes (LLP 0481 T10): a small synthetic team
 * graph published as `hypaware.graph-snapshot/1` generations, and one loopback
 * server that plays the team server for both halves of fastask:
 *
 * - `GET /v1/graph/snapshot` and its generation files (the replica sync), with
 *   the 200/304/403/503 answers of server LLP 0554#responses;
 * - `POST /v1/mcp` (the evidence path and the team_server source):
 *   `session_evidence` per the v1 contract, `query_sql` executed for real over
 *   the same graph and messages, and `grep_search`.
 *
 * Everything is synthetic and self-contained (no test fixtures are read), so
 * the smokes run from a packed install too. Text carries a marker so a smoke
 * can prove none of it left the machine through a sink.
 */

/** A string that appears only in the team graph and its evidence. */
export const REPLICA_MARKER = 'fxreplicamarker'
export const REPO = 'fx-org/fx-repo'
export const TOKEN = 'fx-smoke-token'
/** The question every query smoke asks: it names login.js. */
export const QUESTION = 'why does login.js poll the session'

const SESSIONS = [
  { id: 'fx-session-login-a', file: 'src/login.js', at: '2026-10-08T09:10:00.000Z', branch: 'main', client: 'claude-code' },
  { id: 'fx-session-login-b', file: 'src/login.js', at: '2026-10-08T15:40:00.000Z', branch: 'fix-login', client: 'codex' },
  { id: 'fx-session-poll', file: 'src/poll.js', at: '2026-10-07T11:00:00.000Z', branch: 'main', client: 'claude-code' },
]

/** The messages behind each session: the evidence the smokes read back. */
export const MESSAGES = SESSIONS.flatMap((s, i) => {
  const t = Date.parse(s.at)
  return [
    message(s.id, `${s.id}-m1`, 'user', t - 60_000, `Why does ${s.file} poll every second? ${REPLICA_MARKER}-${i}-question`),
    message(s.id, `${s.id}-m2`, 'assistant', t + 60_000, `Because the socket path dropped events; polling was the safe fix. ${REPLICA_MARKER}-${i}-answer`),
  ]
})

/**
 * @param {string} session @param {string} id @param {string} role @param {number} ms @param {string} text
 */
function message(session, id, role, ms, text) {
  const iso = new Date(ms).toISOString()
  return {
    session_id: session, conversation_id: session, agent_id: null, chain_id: session, is_sidechain: false, parent_thread_id: null,
    message_id: id, part_id: `${id}#0`, message_index: role === 'user' ? 0 : 1, part_index: 0, role, part_type: 'text',
    message_created_at: iso, received_at: iso, date: iso.slice(0, 10), user_id: 'fx-user', gateway_id: 'fx-gateway',
    provider: 'anthropic', model: null, tool_result_for: null, is_compact_summary: false, content_text: text,
  }
}

/**
 * `graph_neighbors` over the published graph, in the context-graph verb's
 * shape: the seed by id or natural key, one hop, the asked direction.
 *
 * @param {{ node: any[], edge: any[] }} tables
 * @param {any} args
 */
function graphNeighbors(tables, args) {
  const seed = tables.node.find((n) => n.node_id === args.node || n.natural_key === args.node)
  if (!seed) return { ok: false, error: `no node matches '${args.node}'` }
  /** @param {string} id */
  const node = (id) => {
    const n = tables.node.find((x) => x.node_id === id)
    return n ? { node_id: n.node_id, node_type: n.node_type, natural_key: n.natural_key, label: n.label } : { node_id: id, node_type: 'Unknown', natural_key: id, label: null }
  }
  const out = []
  for (const e of tables.edge) {
    if (Array.isArray(args.edge_type) && !args.edge_type.includes(e.edge_type)) continue
    if (args.direction !== 'in' && e.src_id === seed.node_id) out.push({ hop: 1, edge_type: e.edge_type, direction: 'out', from: seed.node_id, node: node(e.dst_id), source_keys: e.source_keys })
    if (args.direction !== 'out' && e.dst_id === seed.node_id) out.push({ hop: 1, edge_type: e.edge_type, direction: 'in', from: seed.node_id, node: node(e.src_id), source_keys: e.source_keys })
  }
  const limit = Number.isInteger(args.limit) ? args.limit : 100
  return { ok: true, seed: node(seed.node_id), neighbors: out.slice(0, limit), reachable: out.length, truncated: out.length > limit, totalNodes: out.length + 1, totalEdges: out.length }
}

/** @param {string} type @param {string} key */
const nodeId = (type, key) => createHash('sha256').update(`${type}\0${key}`).digest('hex').slice(0, 24)

/** The graph's rows, as the server's projectors would have written them. */
export function graphRows() {
  const nodes = []
  const edges = []
  const files = [...new Set(SESSIONS.map((s) => s.file))]
  for (const file of files) {
    const key = `${REPO}:${file}`
    nodes.push({
      node_id: nodeId('File', key), node_type: 'File', natural_key: key, label: file.split('/').pop(), props: {},
      first_seen: '2026-10-07T10:00:00.000Z', source_dataset: 'ai_gateway_messages', source_keys: null, projector: 'ai-gateway.t0', projector_version: 2,
    })
  }
  for (const s of SESSIONS) {
    nodes.push({
      node_id: nodeId('Session', s.id), node_type: 'Session', natural_key: s.id, label: `session ${s.id} ${REPLICA_MARKER}`,
      props: { cwd: `/work/${REPO.split('/')[1]}`, git_branch: s.branch, client_name: s.client, user_id: 'fx-user' },
      first_seen: new Date(Date.parse(s.at) - 300_000).toISOString(), source_dataset: 'ai_gateway_messages',
      source_keys: { session_id: s.id }, projector: 'ai-gateway.t0', projector_version: 2,
    })
    const fileKey = `${REPO}:${s.file}`
    edges.push({
      edge_id: nodeId('edge', `${s.id}>${fileKey}`), edge_type: 'touched', src_id: nodeId('Session', s.id), dst_id: nodeId('File', fileKey),
      src_type: 'Session', dst_type: 'File', props: null, first_seen: s.at, source_dataset: 'ai_gateway_messages',
      source_keys: { session_id: s.id, message_id: `${s.id}-m1`, part_id: `${s.id}-m1#0` }, projector: 'ai-gateway.t0', projector_version: 2,
    })
  }
  return { nodes, edges }
}

/**
 * One published generation: gzip NDJSON files encoded and measured with the
 * plugin's contract module, and a manifest in the v1 shape.
 *
 * @param {{ generation: string, watermark: string, origin: string }} args
 */
export async function makeGeneration({ generation, watermark, origin }) {
  const { nodes, edges } = graphRows()
  const files = {
    nodes: gzipSync(nodes.map((r) => `${encodeLine(r, NODE_COLUMNS)}\n`).join('')),
    edges: gzipSync(edges.map((r) => `${encodeLine(r, EDGE_COLUMNS)}\n`).join('')),
  }
  /** @type {Record<string, any>} */
  const described = {}
  for (const name of /** @type {const} */ (['nodes', 'edges'])) {
    const { facts } = await measureFile(files[name])
    described[name] = { path: `generations/${generation}/${name}.ndjson.gz`, ...facts }
  }
  const manifest = {
    protocol: 'hypaware.graph-snapshot/1',
    server: { origin, version: 'smoke' },
    org: 'fx-org',
    scope: 'org',
    generation,
    published_at: watermark,
    projection: { watermark, watermark_kind: 'source_committed_before', projectors: [{ name: 'ai-gateway.t0', max_version: 2 }] },
    schema: { schema_version: 1, id_recipe: 'sha256-trunc24/v1', node_columns: [...NODE_COLUMNS], edge_columns: [...EDGE_COLUMNS] },
    files: described,
    unresolved: { edges: 0, endpoint_ids: 0 },
    lease: { duration_seconds: 86_400 },
    poll: { interval_seconds: 900, jitter_seconds: 300 },
    retained_until: null,
  }
  return { manifest, files }
}

/**
 * The loopback team server. `state.answer` steers the snapshot route:
 * `'ok'` (200, or 304 on a matching If-None-Match), `'withdrawn'` (403
 * snapshot_access_withdrawn) or `'pending'` (503 snapshot_pending with
 * `retry-after`). Every request is recorded.
 */
export async function startFastaskServer() {
  /** @type {Map<string, { manifest: any, files: { nodes: Buffer, edges: Buffer } }>} */
  const generations = new Map()
  /** @type {Array<{ method: string, path: string, ifNoneMatch: string | null, tool: string | null }>} */
  const requests = []
  const state = {
    current: /** @type {string | null} */ (null),
    /** @type {'ok' | 'withdrawn' | 'pending'} */
    answer: 'ok',
    retryAfter: '2',
  }
  const { nodes, edges } = graphRows()
  const tables = {
    node: nodes.map((n) => ({ ...n, props: JSON.stringify(n.props) })),
    edge: edges.map((e) => ({ ...e, source_keys: JSON.stringify(e.source_keys) })),
    ai_gateway_messages: MESSAGES,
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    /** @type {string[]} */
    const chunks = []
    req.setEncoding('utf8')
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = chunks.join('')
      const rpc = url.pathname === '/v1/mcp' && body ? JSON.parse(body) : null
      requests.push({ method: req.method ?? '', path: `${url.pathname}${url.search}`, ifNoneMatch: /** @type {string | undefined} */ (req.headers['if-none-match']) ?? null, tool: rpc?.params?.name ?? rpc?.method ?? null })
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'unauthorized' })
      if (rpc) return void answerMcp(res, rpc)
      if (url.pathname === '/v1/graph/snapshot') return answerSnapshot(req, res)
      const m = url.pathname.match(/^\/v1\/graph\/snapshot\/generations\/([^/]+)\/(nodes|edges)\.ndjson\.gz$/)
      const gen = m ? generations.get(decodeURIComponent(m[1])) : undefined
      if (m && gen) {
        const bytes = gen.files[/** @type {'nodes' | 'edges'} */ (m[2])]
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(bytes.length) })
        return res.end(bytes)
      }
      if (m) return json(res, 410, { error: 'generation_expired' })
      json(res, 404, { error: 'unknown_path' })
    })
  })

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  function answerSnapshot(req, res) {
    if (state.answer === 'withdrawn') return json(res, 403, { error: 'snapshot_access_withdrawn', message: 'no longer a member of this org', replica: 'delete' })
    if (state.answer === 'pending') return json(res, 503, { error: 'snapshot_pending', message: 'no current snapshot' }, { 'retry-after': state.retryAfter })
    const gen = state.current ? generations.get(state.current) : undefined
    if (!gen) return json(res, 503, { error: 'snapshot_pending', message: 'no current snapshot' }, { 'retry-after': state.retryAfter })
    const headers = { etag: `"${gen.manifest.generation}"`, 'cache-control': 'private, no-cache', 'hyp-snapshot-lease': '86400', 'hyp-snapshot-poll': '900' }
    if (req.headers['if-none-match'] === headers.etag) {
      res.writeHead(304, headers)
      return res.end()
    }
    json(res, 200, gen.manifest, headers)
  }

  /** @param {http.ServerResponse} res @param {any} rpc */
  async function answerMcp(res, rpc) {
    /** @param {unknown} result @param {unknown} [error] */
    const reply = (result, error) => json(res, 200, error ? { jsonrpc: '2.0', id: rpc.id, error } : { jsonrpc: '2.0', id: rpc.id, result })
    if (rpc.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fastask-smoke' } })
    if (rpc.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
    if (rpc.method === 'tools/list') {
      return reply({ tools: [
        { name: 'query_sql' },
        { name: 'grep_search' },
        { name: 'graph_neighbors' },
        { name: 'session_evidence', inputSchema: { type: 'object', properties: { contract: { type: 'string', enum: ['hypaware.session-evidence/1'] } } } },
      ] })
    }
    const { name, arguments: args } = rpc.params ?? {}
    try {
      if (name === 'query_sql') {
        const rows = await collect(executeSql({ query: String(args.sql), tables }))
        return reply({ structuredContent: { columns: Object.keys(rows[0] ?? {}), rows }, content: [{ type: 'text', text: JSON.stringify({ rows }) }] })
      }
      if (name === 'grep_search') return reply({ structuredContent: { hits: [] }, content: [{ type: 'text', text: '{"hits":[]}' }] })
      if (name === 'graph_neighbors') {
        const answer = graphNeighbors(tables, args)
        return reply({ structuredContent: answer, content: [{ type: 'text', text: JSON.stringify(answer) }] })
      }
      if (name === 'session_evidence') {
        const answer = evidenceAnswer(args)
        return reply({ structuredContent: answer, content: [{ type: 'text', text: JSON.stringify(answer) }] })
      }
      reply(undefined, { code: -32601, message: `Unknown tool: ${name}` })
    } catch (err) {
      reply({ isError: true, content: [{ type: 'text', text: `invalid_request: ${err instanceof Error ? err.message : String(err)}` }] })
    }
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const { port } = /** @type {AddressInfo} */ (server.address())
  const url = `http://127.0.0.1:${port}`
  return {
    url,
    state,
    requests,
    /** @param {string} generation @param {string} watermark */
    async publish(generation, watermark) {
      generations.set(generation, await makeGeneration({ generation, watermark, origin: url }))
      state.current = generation
    },
    snapshotChecks: () => requests.filter((r) => r.path.startsWith('/v1/graph/snapshot?')),
    dataRequests: () => requests.filter((r) => r.path.includes('/generations/')),
    toolCalls: (/** @type {string} */ tool) => requests.filter((r) => r.tool === tool),
    close() {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}

/** A session_evidence answer over MESSAGES, per the v1 contract. @param {any} args */
function evidenceAnswer(args) {
  const roles = Array.isArray(args.roles) ? args.roles : null
  const types = Array.isArray(args.part_types) ? args.part_types : null
  const sessions = (args.sessions ?? []).map((/** @type {string} */ s, /** @type {number} */ i) => {
    const e = JSON.parse(s)
    const known = MESSAGES.some((m) => m.session_id === e.session_id)
    const parts = MESSAGES
      .filter((m) => m.session_id === e.session_id)
      .filter((m) => (!e.from || m.message_created_at >= e.from) && (!e.to || m.message_created_at < e.to))
      .filter((m) => !e.message_ids || e.message_ids.includes(m.message_id))
      .filter((m) => (!roles || roles.includes(m.role)) && (!types || types.includes(m.part_type)))
      .map(({ date, ...p }) => ({ ...p, text_truncated: false }))
    return {
      request_index: i, session_id: e.session_id, status: known ? 'ok' : 'not_found', parts, truncated: false, next_cursor: null,
      window: { from: e.from ?? null, to: e.to ?? null, bounds_source: e.from ? 'request' : 'locator' },
      coverage: { received_through: '2026-10-09T03:00:00.000Z', read_path: 'indexed', fallback_reason: null },
    }
  })
  return { contract: 'hypaware.session-evidence/1', server_version: 'smoke', complete: true, deadline_reached: false, elapsed_ms: 1, sessions }
}

/**
 * @param {http.ServerResponse} res @param {number} status @param {unknown} body @param {Record<string, string>} [headers]
 */
function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers })
  res.end(text)
}

/**
 * Split a printed POSIX shell command line into argv (single and double
 * quotes, backslashes), so a smoke can run exactly what fastask printed.
 *
 * @param {string} line
 */
export function shellSplit(line) {
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

/** A string buffer standing in for stdout/stderr. */
export function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return { write(/** @type {string} */ s) { chunks.push(String(s)); return true }, text() { return chunks.join('') } }
}

/**
 * Poll until `predicate()` holds, or fail after `ms`.
 * @param {() => boolean | Promise<boolean>} predicate @param {number} [ms] @param {string} [what]
 */
export async function waitFor(predicate, ms = 15_000, what = 'condition') {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}
