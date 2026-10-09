// @ts-check

// The fastask evidence client and output (LLP 0480#evidence and #output, LLP
// 0481 T7). A loopback MCP server replays the pinned
// hypaware.session-evidence/1 fixtures, so every fixture round-trips through
// the real HTTP MCP client. The same server can refuse with a capacity 429,
// answer -32601, hang until the client hangs up, or serve query_sql by running
// the SQL the fallback generates over the fixtures' synthetic corpus, so the
// fallback is checked against the verb's own rows.

/**
 * @import { TestContext } from 'node:test'
 * @import { ServerResponse } from 'node:http'
 * @import { AddressInfo } from 'node:net'
 * @import { DiscoveryResult, EvidenceMcpClient, Lead, PlannedEntry } from '../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { collect, executeSql } from 'squirreling'

import { createHttpMcpClient } from '../../src/core/mcp/client.js'
import { argvToParams, parseControlFlags } from '../../src/core/cli/verb_codec.js'
import { querySqlVerb } from '../../src/core/query/verb.js'
import { queryGrepVerb } from '../../hypaware-core/plugins-workspace/grep/src/grep_verb.js'
import {
  CALL_ALLOWANCE_PARTS, CAPACITY_RETRY_MS, CURSOR_UNRESOLVABLE_NOTE, DEADLINE_FLOOR_MS, EVIDENCE_CONTRACT, EVIDENCE_MAX_RESPONSE_BYTES, FALLBACK_LABEL, FRESHNESS_UNAVAILABLE_NOTE, MAX_ENTRIES, MAX_FOLLOWS_PER_ENTRY,
  MAX_TEXT_CHARS, NOT_FOUND_NOTE, WINDOW_MS, callEvidence, evidenceDeadlineMs, evidenceRequest, evidenceSupport,
  fallbackSql, fetchEvidence, planEntries, skippedNote,
} from '../../hypaware-core/plugins-workspace/fastask/src/evidence.js'
import { buildFastaskOutput, evidenceCommand, renderFastaskText, shellQuote } from '../../hypaware-core/plugins-workspace/fastask/src/output.js'
import { createWarmEvidenceClient } from '../../hypaware-core/plugins-workspace/fastask/src/warm_client.js'

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'contracts', 'session-evidence', 'v1')
const FIXTURES = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((file) => ({ file, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) }))

/** Every distinct part across the fixtures: the synthetic corpus they all come from. */
const CORPUS = (() => {
  /** @type {Map<string, any>} */
  const parts = new Map()
  for (const f of FIXTURES) {
    for (const s of f.response?.sessions ?? []) {
      for (const p of s.parts ?? []) {
        // Truncated copies are cut by their request; keep the full text.
        if (!p.text_truncated && !parts.has(p.part_id)) parts.set(p.part_id, { ...p, date: p.message_created_at.slice(0, 10) })
      }
    }
  }
  return [...parts.values()]
})()

/**
 * A lead as discovery would hand it over.
 * @param {string} sessionId @param {string | null} touchedAt @param {Partial<Lead>} [extra]
 * @returns {Lead}
 */
function lead(sessionId, touchedAt, extra = {}) {
  return {
    session_id: sessionId,
    rank: 1,
    score: 1,
    group: 'login.js',
    why: [{ anchor: { type: 'File', key: 'acme/app:src/login.js', match: 'basename', proven: true, in_repo: true }, term: 'login', edge: 'touched', touched_at: touchedAt }],
    touched_at: touchedAt,
    exemplar: null,
    session: { first_seen: '2026-08-31T09:59:00.000Z', cwd: '/repo', git_branch: 'main', client_name: 'claude-code', user_id: 'fx-user-1' },
    ...extra,
  }
}

/**
 * The verb's own semantics over the corpus (server entrySql): the reference
 * the fallback is compared with.
 * @param {any} entry @param {{ roles?: string[], part_types?: string[] }} request
 */
function verbRows(entry, request) {
  const dir = entry.order === 'desc' ? -1 : 1
  return CORPUS
    .filter((p) => p.session_id === entry.session_id)
    .filter((p) => !entry.from || p.message_created_at >= entry.from)
    .filter((p) => !entry.to || p.message_created_at < entry.to)
    .filter((p) => !entry.message_ids || entry.message_ids.includes(p.message_id))
    .filter((p) => !request.roles || request.roles.includes(p.role))
    .filter((p) => !request.part_types || request.part_types.includes(p.part_type))
    .sort((a, b) => dir * (a.message_created_at.localeCompare(b.message_created_at) || a.message_index - b.message_index || a.part_index - b.part_index || a.part_id.localeCompare(b.part_id)))
}

/**
 * The loopback MCP server.
 * @param {TestContext} t
 * @param {{
 *   tools?: any[],
 *   evidence?: (args: any, res: ServerResponse, id: number) => void,
 * }} [opts]
 */
async function startServer(t, opts = {}) {
  /** @type {any[]} */
  const calls = []
  /** @type {Promise<void>[]} */
  const hangups = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const msg = JSON.parse(raw)
      if (msg.method === 'initialize') return reply(res, msg.id, { protocolVersion: '2025-06-18' })
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
      if (msg.method === 'tools/list') return reply(res, msg.id, { tools: opts.tools ?? [] })
      const { name, arguments: args } = msg.params
      calls.push({ name, args })
      hangups.push(new Promise((resolve) => res.on('close', () => { if (!res.writableFinished) resolve() })))
      if (name === 'session_evidence') return (opts.evidence ?? fixtureEvidence)(args, res, msg.id)
      if (name === 'query_sql') {
        const rows = await collect(executeSql({ query: args.sql, tables: { ai_gateway_messages: CORPUS } }))
        return reply(res, msg.id, { structuredContent: { columns: Object.keys(rows[0] ?? {}), rows }, content: [{ type: 'text', text: JSON.stringify({ rows }) }] })
      }
      reply(res, msg.id, undefined, { code: -32601, message: `Unknown tool: ${name}` })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)) }))
  const { port } = /** @type {AddressInfo} */ (server.address())
  return { url: `http://127.0.0.1:${port}/mcp`, calls, hangups }
}

/** @param {ServerResponse} res @param {number} id @param {unknown} result @param {unknown} [error] */
function reply(res, id, result, error) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }))
}

/** Answer with the fixture whose request is exactly these arguments. @param {any} args @param {ServerResponse} res @param {number} id */
function fixtureEvidence(args, res, id) {
  const fixture = FIXTURES.find((f) => JSON.stringify(f.request) === JSON.stringify(args))
  if (!fixture) return reply(res, id, undefined, { code: -32602, message: 'no fixture for this request' })
  if (fixture.jsonrpc_error) return reply(res, id, undefined, fixture.jsonrpc_error.error)
  if (fixture.tool_error) return reply(res, id, fixture.tool_error)
  reply(res, id, { structuredContent: fixture.response, content: [{ type: 'text', text: JSON.stringify(fixture.response) }] })
}

/** Answer any request from the corpus with the verb's semantics (no cursors needed: everything fits). @param {any} args @param {ServerResponse} res @param {number} id */
function corpusEvidence(args, res, id) {
  const sessions = args.sessions.map((/** @type {string} */ s, /** @type {number} */ i) => {
    const entry = JSON.parse(s)
    const rows = verbRows(entry, args)
    const page = rows.slice(0, entry.max_parts)
    return {
      request_index: i, session_id: entry.session_id, status: rows.length > page.length ? 'partial' : 'ok',
      parts: page.map(({ date, ...p }) => p), truncated: rows.length > page.length, next_cursor: rows.length > page.length ? `cur-${i}` : null,
      window: { from: entry.from ?? null, to: entry.to ?? null, bounds_source: 'request' },
      coverage: { received_through: '2026-10-09T02:00:00.000Z', read_path: 'indexed', fallback_reason: null },
    }
  })
  const response = { contract: EVIDENCE_CONTRACT, server_version: '1.40.0', complete: sessions.every((/** @type {any} */ s) => s.status === 'ok'), deadline_ms: args.deadline_ms, deadline_reached: false, elapsed_ms: 3, sessions }
  reply(res, id, { structuredContent: response, content: [{ type: 'text', text: JSON.stringify(response) }] })
}

/** @param {string} url @param {AbortSignal} [signal] */
async function connect(url, signal) {
  const client = createHttpMcpClient({ url, signal })
  await client.initialize()
  return client
}

/** The fixture's own entries, one lead each. @param {any} fixture @returns {PlannedEntry[]} */
function plannedFrom(fixture) {
  return fixture.request.sessions.map((/** @type {string} */ s, /** @type {number} */ i) => {
    let entry
    try { entry = JSON.parse(s) } catch { entry = { session_id: '?', order: 'asc', max_parts: 1 } }
    return { lead: i, kind: 'window', entry }
  })
}

// ----- Request building -----

test('planEntries: a window of touch time plus or minus 15 minutes, the exemplar by message_ids, the allowance split evenly', () => {
  const touched = '2026-08-31T10:00:30.000Z'
  const planned = planEntries([
    lead('fx-session-alpha', touched, { exemplar: { message_id: 'fx-alpha-m02', part_id: 'fx-alpha-m02#0' } }),
    lead('fx-session-beta', null),
  ])
  assert.equal(planned.length, 3)
  assert.deepEqual(planned[0], { lead: 0, kind: 'window', entry: { session_id: 'fx-session-alpha', order: 'asc', max_parts: 80, from: new Date(Date.parse(touched) - WINDOW_MS).toISOString(), to: new Date(Date.parse(touched) + WINDOW_MS).toISOString() } })
  assert.deepEqual(planned[1].entry, { session_id: 'fx-session-beta', order: 'asc', max_parts: 80 }, 'an unknown touch time leaves the server its locator bounds')
  assert.deepEqual(planned[2], { lead: 0, kind: 'message', entry: { session_id: 'fx-session-alpha', message_ids: ['fx-alpha-m02'], order: 'asc', max_parts: 80 } })
  assert.equal(planned.reduce((n, p) => n + p.entry.max_parts, 0) <= CALL_ALLOWANCE_PARTS, true)
})

test('planEntries: default 6 leads, never more than 16 entries, windows before exemplars', () => {
  const many = Array.from({ length: 20 }, (_, i) => lead(`s-${i}`, '2026-08-31T10:00:00.000Z', { exemplar: { message_id: `m-${i}`, part_id: null } }))
  const byDefault = planEntries(many)
  assert.equal(byDefault.filter((p) => p.kind === 'window').length, 6)
  assert.equal(byDefault.length, 12)
  const most = planEntries(many, { leads: 40 })
  assert.equal(most.length, MAX_ENTRIES)
  assert.equal(most.filter((p) => p.kind === 'window').length, 16, 'every chosen lead gets its window before any exemplar')
  assert.deepEqual(planEntries([]), [])
})

test('evidenceRequest: each entry a JSON string, user and assistant text only, the text cap and the deadline at top level', () => {
  const planned = planEntries([lead('fx-session-alpha', '2026-08-31T10:00:30.000Z')])
  const request = evidenceRequest(planned, 900)
  assert.deepEqual(Object.keys(request), ['contract', 'sessions', 'roles', 'part_types', 'max_text_chars', 'deadline_ms'])
  assert.equal(request.contract, EVIDENCE_CONTRACT)
  assert.equal(typeof request.sessions[0], 'string')
  assert.deepEqual(JSON.parse(request.sessions[0]), planned[0].entry)
  assert.deepEqual(request.roles, ['user', 'assistant'])
  assert.deepEqual(request.part_types, ['text'])
  assert.equal(request.max_text_chars, MAX_TEXT_CHARS)
  assert.equal(request.deadline_ms, 900)
})

test('evidenceDeadlineMs: remaining budget minus the round trip, never under 250 ms', () => {
  assert.equal(evidenceDeadlineMs(1500, 300), 1200)
  assert.equal(evidenceDeadlineMs(400, 300), DEADLINE_FLOOR_MS)
  assert.equal(evidenceDeadlineMs(-50), DEADLINE_FLOOR_MS)
})

test('evidenceSupport: the tool must be listed with v1 in its contract enum', () => {
  const tool = (/** @type {any} */ contract) => ({ tools: [{ name: 'session_evidence', inputSchema: { properties: { contract } } }] })
  assert.equal(evidenceSupport({ tools: [{ name: 'query_sql' }] }), 'missing_tool')
  assert.equal(evidenceSupport(undefined), 'missing_tool')
  assert.equal(evidenceSupport(tool({ type: 'string', enum: ['hypaware.session-evidence/2'] })), 'unsupported_contract')
  assert.equal(evidenceSupport(tool({ type: 'string', enum: [EVIDENCE_CONTRACT] })), 'supported')
  assert.equal(evidenceSupport(tool({ type: 'string' })), 'supported')
})

// ----- Every pinned fixture through the real client -----

for (const fixture of FIXTURES) {
  test(`fixture ${fixture.file} round-trips through the evidence client`, async (t) => {
    const { url, calls } = await startServer(t)
    const client = await connect(url)
    const planned = plannedFrom(fixture)
    const result = await callEvidence({ client, planned, leadCount: planned.length, deadlineAt: performance.now() + 2000, request: fixture.request })
    assert.notEqual(result, 'fallback')
    if (result === 'fallback') return
    assert.deepEqual(calls[0].args, fixture.request, 'the request reached the server unchanged')
    if (fixture.tool_error || fixture.jsonrpc_error) {
      // -32602 and isError are both client defects, reported as invalid_request.
      assert.equal(result.failure?.code, 'invalid_request')
      assert.ok(result.failure?.message, 'the server reason is kept')
      assert.ok(result.leads.every((l) => l.status === 'error' && l.parts.length === 0))
      return
    }
    const response = fixture.response
    assert.equal(result.failure, null)
    assert.equal(result.deadline_reached, response.deadline_reached)
    assert.equal(result.leads.length, response.sessions.length)
    response.sessions.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      const got = result.leads[i]
      assert.equal(got.status, s.status, `${fixture.case}: status of entry ${i}`)
      assert.deepEqual(got.parts.map((p) => p.part_id), s.parts.map((/** @type {any} */ p) => p.part_id), `${fixture.case}: parts in the server's order`)
      assert.deepEqual(got.parts.map((p) => [p.role, p.message_created_at, p.content_text, p.text_truncated]), s.parts.map((/** @type {any} */ p) => [p.role, p.message_created_at, p.content_text, p.text_truncated]))
      if (s.next_cursor) assert.deepEqual(got.continuation, { ...planned[i].entry, cursor: s.next_cursor })
      else assert.equal(got.continuation, null)
      if (s.status === 'not_found') assert.equal(got.note, NOT_FOUND_NOTE)
      if (s.status === 'error') assert.match(String(got.note), new RegExp(s.error.code))
    })
    const throughs = response.sessions.map((/** @type {any} */ s) => s.coverage?.received_through).filter(Boolean).sort()
    assert.equal(result.received_through, throughs[0] ?? null)
    assert.equal(result.complete, response.complete && response.sessions.every((/** @type {any} */ s) => s.status === 'ok' || s.status === 'not_found'))
  })
}

// ----- Deadline, capacity, failure channels -----

test('the deadline is sent as the remaining budget minus the round trip', async (t) => {
  const { url, calls } = await startServer(t, { evidence: corpusEvidence })
  const client = await connect(url)
  let clock = 1000
  await fetchEvidence({ client, leads: [lead('fx-session-alpha', '2026-08-31T10:00:30.000Z')], remainingMs: 1500, roundTripMs: 200, now: () => clock })
  assert.equal(calls[0].args.deadline_ms, 1300)
})

test('a server that outlives the budget is aborted: the call ends promptly as deadline and the server sees the hang-up', async (t) => {
  const { url, hangups } = await startServer(t, { evidence: () => {} })
  const controller = new AbortController()
  const client = await connect(url, controller.signal)
  const started = performance.now()
  realTimeout(() => controller.abort(new Error('budget')), 50)
  const result = await fetchEvidence({ client, leads: [lead('fx-session-alpha', '2026-08-31T10:00:30.000Z')], remainingMs: 50, signal: controller.signal })
  assert.ok(performance.now() - started < 1000, 'returned at the budget, not when the server finished')
  assert.equal(result.failure?.code, 'deadline')
  assert.equal(result.deadline_reached, true)
  assert.ok(result.leads.every((l) => l.status === 'deadline'))
  await hangups[0]
})

/** @param {() => void} fn @param {number} ms */
function realTimeout(fn, ms) { setTimeout(fn, ms) }

/** A server answering 429 (no Retry-After, server LLP 0562) the first `n` times, then from the corpus. @param {number} n */
function busyThen(n) {
  let refusals = 0
  return (/** @type {any} */ args, /** @type {ServerResponse} */ res, /** @type {number} */ id) => {
    if (refusals++ < n) { res.writeHead(429, { 'content-type': 'text/plain' }); return res.end('org_read_capacity: too many concurrent reads') }
    corpusEvidence(args, res, id)
  }
}

test('a capacity 429 is retried once after at most 250 ms when the budget allows', async (t) => {
  const { url, calls } = await startServer(t, { evidence: busyThen(1) })
  const client = await connect(url)
  /** @type {number[]} */
  const slept = []
  let clock = 0
  const result = await fetchEvidence({
    client, leads: [lead('fx-session-alpha', '2026-08-31T10:00:30.000Z')], remainingMs: 2000, now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms },
  })
  assert.deepEqual(slept, [CAPACITY_RETRY_MS])
  assert.equal(calls.length, 2)
  assert.equal(calls[1].args.deadline_ms, 2000 - CAPACITY_RETRY_MS, 'the retry carries the budget that is left')
  assert.equal(result.failure, null)
  assert.equal(result.retries, 1)
  assert.equal(result.leads[0].status, 'ok')
})

test('a second 429, or one with too little budget for a retry, is server busy', async (t) => {
  for (const [refusals, remainingMs, expectedCalls] of [[2, 2000, 2], [1, 400, 1]]) {
    const { url, calls } = await startServer(t, { evidence: busyThen(refusals) })
    const client = await connect(url)
    let clock = 0
    const result = await fetchEvidence({
      client, leads: [lead('fx-session-alpha', '2026-08-31T10:00:30.000Z')], remainingMs, now: () => clock,
      sleep: async (ms) => { clock += ms },
    })
    assert.equal(result.failure?.code, 'server_busy', `${refusals} refusals, ${remainingMs} ms`)
    assert.match(result.failure?.message ?? '', /server busy/)
    assert.equal(calls.length, expectedCalls)
  }
})

test('a -32602 and a tool error both reach the caller as invalid_request', async (t) => {
  const { url } = await startServer(t, { evidence: (_a, res, id) => reply(res, id, undefined, { code: -32602, message: 'unknown argument' }) })
  const viaRpc = await fetchEvidence({ client: await connect(url), leads: [lead('fx-session-alpha', null)], remainingMs: 2000 })
  assert.deepEqual(viaRpc.failure, { code: 'invalid_request', message: 'unknown argument' })
  const second = await startServer(t, { evidence: (_a, res, id) => reply(res, id, { isError: true, content: [{ type: 'text', text: 'invalid_request: sessions[0] is not a JSON object' }] }) })
  const viaTool = await fetchEvidence({ client: await connect(second.url), leads: [lead('fx-session-alpha', null)], remainingMs: 2000 })
  assert.equal(viaTool.failure?.code, 'invalid_request')
})

// ----- Fallback -----

const FALLBACK_LEADS = [
  lead('fx-session-alpha', '2026-08-31T10:00:30.000Z', { exemplar: { message_id: 'fx-alpha-m06', part_id: 'fx-alpha-m06#0' } }),
  lead('fx-session-beta', '2026-08-31T10:31:00.000Z'),
  lead('fx-session-alpha', null),
]

test('a server without the verb (-32601) is read through query_sql: labeled, and the same rows the verb returns', async (t) => {
  const withVerb = await startServer(t, { evidence: corpusEvidence })
  const verb = await fetchEvidence({ client: await connect(withVerb.url), leads: FALLBACK_LEADS, remainingMs: 2000 })
  const without = await startServer(t, { evidence: (_a, res, id) => reply(res, id, undefined, { code: -32601, message: 'Unknown tool: session_evidence' }) })
  const fallback = await fetchEvidence({ client: await connect(without.url), leads: FALLBACK_LEADS, remainingMs: 2000 })
  assert.equal(verb.path, 'session_evidence')
  assert.equal(fallback.path, 'query_sql')
  assert.equal(fallback.label, FALLBACK_LABEL)
  assert.ok(verb.leads.some((l) => l.parts.length > 0), 'the comparison has rows in it')
  assert.deepEqual(fallback.leads.map((l) => l.parts), verb.leads.map((l) => l.parts), 'same rows, same order, per lead')
  assert.deepEqual(fallback.leads.map((l) => l.status), verb.leads.map((l) => l.status))
  assert.ok(without.calls.slice(1).every((c) => c.name === 'query_sql'))
})

test('a server whose tools/list lacks v1 is read through query_sql without calling the verb', async (t) => {
  const { url, calls } = await startServer(t)
  const result = await fetchEvidence({ client: await connect(url), leads: FALLBACK_LEADS.slice(0, 1), remainingMs: 2000, support: 'unsupported_contract' })
  assert.equal(result.path, 'query_sql')
  assert.ok(calls.every((c) => c.name === 'query_sql'))
})

test('fallbackSql is the verb read: window on message_created_at, widened day bounds, roles, part types, order and LIMIT max_parts + 1', () => {
  const sql = fallbackSql({ session_id: "o'brien", from: '2026-08-31T09:45:00.000Z', to: '2026-08-31T10:15:00.000Z', message_ids: ['m1'], order: 'asc', max_parts: 40 })
  assert.equal(sql, "SELECT message_id, part_id, role, message_created_at, message_index, part_index, content_text FROM ai_gateway_messages WHERE session_id = 'o''brien' AND date >= '2026-08-30' AND date <= '2026-09-01' AND message_created_at >= '2026-08-31T09:45:00.000Z' AND message_created_at < '2026-08-31T10:15:00.000Z' AND message_id IN ('m1') AND role IN ('user', 'assistant') AND part_type IN ('text') ORDER BY message_created_at ASC, message_index ASC, part_index ASC, part_id ASC LIMIT 41")
})

// ----- Output -----

/** Split a POSIX shell command line (single and double quotes, backslashes). @param {string} line */
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

/**
 * Parse a generated command with the real verb parsers.
 * @param {string} command
 */
function parseCommand(command) {
  const argv = shellSplit(command)
  assert.equal(argv[0], 'hyp')
  const verbs = { 'query sql': querySqlVerb, 'query grep': queryGrepVerb }
  const name = `${argv[1]} ${argv[2]}`
  const verb = verbs[/** @type {keyof typeof verbs} */ (name)]
  if (!verb) return { name, argv: argv.slice(3) }
  const ctrl = parseControlFlags(argv.slice(3))
  assert.ok(ctrl.ok, `${command}: ${!ctrl.ok && ctrl.error}`)
  const params = argvToParams(verb.inputSchema, ctrl.ok ? ctrl.rest : [])
  assert.ok(params.ok, `${command}: ${!params.ok && params.error}`)
  return { name, controls: ctrl.ok ? ctrl.controls : {}, params: params.ok ? params.params : {} }
}

const SOURCE = /** @type {const} */ ({ kind: 'team_replica', path: 'warm', remote: 'hyperparam', org: 'acme', generation: '1760000000000-7', watermark: '2026-10-09T01:45:00.000Z', watermark_age_s: 3600, replica_state: 'synced', note: null })
const TIMINGS = { load: 0, connect: 0.4, discovery: 4.2, evidence: 811.6, total: 1033.4 }

/** @param {Lead[]} leads @param {Partial<DiscoveryResult>} [extra] */
function discoveryOf(leads, extra = {}) {
  return {
    terms: [{ text: "login's", kind: /** @type {any} */ ('word') }, { text: 'poll', kind: /** @type {any} */ ('word') }],
    anchors: [], leads, ambiguous: true, groups: [], no_anchor: false, fallback: null,
    coverage: { visits: 1840, truncated: false, anchors_truncated: 0, unresolved_edges_met: 2, sessions_considered: 9 },
    ...extra,
  }
}

test('the fastask/1 document: stable fields, evidence per lead, and the timings phases', async (t) => {
  const { url } = await startServer(t, { evidence: corpusEvidence })
  const leads = [lead('fx-session-alpha', '2026-08-31T10:00:30.000Z'), lead('fx-session-missing', '2026-08-31T10:00:30.000Z', { rank: 2 })]
  const evidence = await fetchEvidence({ client: await connect(url), leads, remainingMs: 2000, leadCount: 1 })
  const out = buildFastaskOutput({ question: 'why is login shaped this way', source: SOURCE, discovery: discoveryOf(leads), evidence, timings: TIMINGS })
  assert.deepEqual(Object.keys(out), ['contract', 'question', 'source', 'leads', 'ambiguous', 'followups', 'coverage', 'timings_ms'])
  assert.equal(out.contract, 'fastask/1')
  assert.deepEqual(out.timings_ms, { load: 0, connect: 0, discovery: 4, evidence: 812, total: 1033 })
  assert.deepEqual(Object.keys(out.leads[0]), ['session_id', 'rank', 'group', 'why', 'session', 'evidence'])
  assert.equal(out.leads[0].evidence?.status, 'ok')
  assert.equal(out.leads[1].evidence, null, 'a lead past the evidence count carries none')
  assert.equal(out.coverage.evidence_received_through, '2026-10-09T02:00:00.000Z')
  assert.equal(out.coverage.evidence_path, 'session_evidence')
  assert.equal(out.coverage.partial, false)
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out, 'plain JSON')
})

test('statuses and continuations render as runnable commands with the guardian wording', () => {
  const continuation = { session_id: "fx-o'session", from: '2026-08-31T09:45:30.000Z', to: '2026-08-31T10:15:30.000Z', order: /** @type {const} */ ('asc'), max_parts: 40, cursor: 'fxcur-alpha-asc-d1' }
  const evidence = {
    path: /** @type {const} */ ('session_evidence'), label: null, complete: false, deadline_reached: true, received_through: '2026-10-09T02:00:00.000Z', read_path: 'indexed', failure: null, retries: 0, resends: 0,
    leads: [
      { status: /** @type {const} */ ('deadline'), parts: [{ message_id: 'm1', part_id: 'm1#0', role: 'user', message_created_at: '2026-08-31T10:00:00.000Z', content_text: 'line one\nline two', text_truncated: true }], continuation, note: null, skipped_parts: 0 },
      { status: /** @type {const} */ ('not_found'), parts: [], continuation: null, note: NOT_FOUND_NOTE, skipped_parts: 0 },
    ],
  }
  const leads = [lead("fx-o'session", '2026-08-31T10:00:30.000Z'), lead('fx-session-missing', null, { rank: 2 })]
  const out = buildFastaskOutput({ question: 'q', source: SOURCE, discovery: discoveryOf(leads), evidence, timings: TIMINGS })
  const command = /** @type {string} */ (out.leads[0].evidence?.continuation)
  assert.equal(command, evidenceCommand('hyperparam', continuation))
  const parsed = parseCommand(command)
  assert.equal(parsed.name, 'query evidence')
  assert.deepEqual(parsed.argv, ['--remote', 'hyperparam', '--session', JSON.stringify(continuation), '--json'], 'the entry and its cursor survive the shell')
  assert.equal(out.coverage.partial, true)

  const text = renderFastaskText(out, { now: Date.parse('2026-10-09T02:45:00.000Z') })
  assert.match(text, /evidence: deadline/)
  assert.match(text, /user 2026-08-31T10:00:00.000Z: line one line two \[cut\]/)
  assert.match(text, new RegExp(`evidence: not_found - ${NOT_FOUND_NOTE.replace(/[()]/g, '\\$&')}`))
  assert.doesNotMatch(text, /does not exist/)
  assert.match(text, /more: hyp query evidence --remote hyperparam --session /)
  assert.match(text, /team graph as of 2026-10-09T01:45:00.000Z \(1h\), evidence received through 2026-10-09T02:00:00.000Z\n$/)
})

test('every follow-up parses with the real verb parsers, on the verb path and the fallback path', () => {
  const leads = [lead("fx-o'session", '2026-08-31T10:00:30.000Z')]
  for (const [path, label] of [['session_evidence', null], ['query_sql', FALLBACK_LABEL]]) {
    const evidence = { path: /** @type {any} */ (path), label, complete: true, deadline_reached: false, received_through: null, read_path: null, failure: null, retries: 0, resends: 0, leads: [{ status: /** @type {const} */ ('ok'), parts: [], continuation: null, note: null, skipped_parts: 0 }] }
    const out = buildFastaskOutput({ question: 'q', source: SOURCE, discovery: discoveryOf(leads), evidence, timings: TIMINGS })
    assert.equal(out.followups.length, 2)
    for (const f of out.followups) {
      const parsed = parseCommand(f.command)
      if (parsed.name === 'query evidence') {
        assert.equal(path, 'session_evidence', 'the verb command is only offered where the server has the verb')
        assert.deepEqual(JSON.parse(String(parsed.argv?.[3])), { session_id: "fx-o'session" })
        continue
      }
      assert.equal(parsed.controls?.remote, 'hyperparam')
      if (parsed.name === 'query grep') assert.equal(parsed.params?.query, "login's poll")
      if (parsed.name === 'query sql') assert.match(String(parsed.params?.sql), /WHERE session_id = 'fx-o''session'/)
    }
  }
  const local = buildFastaskOutput({ question: 'q', source: { ...SOURCE, kind: 'local', path: 'local', remote: null }, discovery: discoveryOf(leads, { no_anchor: true }), evidence: null, timings: TIMINGS })
  assert.match(local.followups[0].command, /^hyp query grep 'login/, 'with no anchor the text search comes first')
  for (const f of local.followups) assert.equal(parseCommand(f.command).controls?.remote, undefined)
  assert.equal(renderFastaskText(local).trimEnd().split('\n').at(-1), 'local captures only')
})

test('shellQuote leaves plain words alone and survives embedded quotes', () => {
  assert.equal(shellQuote('hyperparam'), 'hyperparam')
  for (const value of ["it's", '{"a":"b c"}', 'x\'y"z', '']) assert.deepEqual(shellSplit(`cmd ${shellQuote(value)}`), ['cmd', value])
})

// ----- Server LLP 0565#client consequences -----

/** A session_evidence handler answering each entry with `answerFor(entry, index)`. @param {(entry: any, index: number, args: any) => any} answerFor */
function perEntry(answerFor) {
  return (/** @type {any} */ args, /** @type {ServerResponse} */ res, /** @type {number} */ id) => {
    const sessions = args.sessions.map((/** @type {string} */ s, /** @type {number} */ i) => ({ request_index: i, ...answerFor(JSON.parse(s), i, args) }))
    const response = { contract: EVIDENCE_CONTRACT, server_version: '1.40.0', complete: sessions.every((/** @type {any} */ s) => s.status === 'ok'), deadline_reached: false, elapsed_ms: 1, sessions }
    reply(res, id, { structuredContent: response, content: [{ type: 'text', text: JSON.stringify(response) }] })
  }
}

/** @param {any} entry */
const unbounded = (entry) => ({ session_id: entry.session_id, status: 'error', parts: [], truncated: false, next_cursor: null, window: null, coverage: null, error: { code: 'freshness_unavailable', message: 'no commit watermark' } })

/** @param {any} entry */
const okWithParts = (entry) => ({
  session_id: entry.session_id, status: 'ok', truncated: false, next_cursor: null, window: { from: entry.from ?? null, to: entry.to ?? null, bounds_source: 'request' },
  coverage: { received_through: '2026-10-09T02:00:00.000Z', read_path: 'indexed', fallback_reason: null },
  parts: verbRows(entry, { roles: ['user', 'assistant'], part_types: ['text'] }).slice(0, entry.max_parts).map(({ date, ...p }) => p),
})

test('freshness_unavailable: not read, not complete, worded as unconfirmed freshness, and never retried', async (t) => {
  const { url, calls } = await startServer(t, { evidence: perEntry(unbounded) })
  const result = await fetchEvidence({ client: await connect(url), leads: FALLBACK_LEADS, remainingMs: 2000 })
  assert.equal(calls.filter((c) => c.name === 'session_evidence').length, 1, 'no retry within the command')
  assert.deepEqual(result.failure, { code: 'freshness_unavailable', message: FRESHNESS_UNAVAILABLE_NOTE })
  assert.equal(result.complete, false)
  assert.equal(result.received_through, null)
  assert.ok(result.leads.every((l) => l.status === 'error' && l.parts.length === 0 && l.note === FRESHNESS_UNAVAILABLE_NOTE))
  const out = buildFastaskOutput({ question: 'q', source: SOURCE, discovery: discoveryOf(FALLBACK_LEADS), evidence: result, timings: TIMINGS })
  const text = renderFastaskText(out)
  assert.match(text, /the server could not confirm how fresh its evidence is/)
  assert.doesNotMatch(text, /no evidence|no readable text|not_found/i, 'never reads as absent evidence')
})

test('freshness_unavailable on one entry only: the others are read; no aggregate failure', async (t) => {
  const { url } = await startServer(t, { evidence: perEntry((entry, i) => (i === 0 ? unbounded(entry) : okWithParts(entry))) })
  const result = await fetchEvidence({ client: await connect(url), leads: FALLBACK_LEADS.slice(1, 3), remainingMs: 2000 })
  assert.equal(result.failure, null)
  assert.equal(result.leads[0].note, FRESHNESS_UNAVAILABLE_NOTE)
  assert.equal(result.leads[1].status, 'ok')
  assert.equal(result.complete, false)
})

test('a partial entry with no parts is sent again alone, with its cursor, and gets its parts', async (t) => {
  /** @type {any[]} */
  const sent = []
  const { url } = await startServer(t, {
    evidence: perEntry((entry, i, args) => {
      sent.push({ sessions: args.sessions.length, entry, roles: args.roles, part_types: args.part_types, max_text_chars: args.max_text_chars })
      // In the full call the second entry does not fit its share; alone it does.
      if (args.sessions.length > 1 && i === 1) return { session_id: entry.session_id, status: 'partial', parts: [], truncated: true, next_cursor: 'fxcur-unchanged', window: null, coverage: null }
      return okWithParts(entry)
    }),
  })
  const leads = [FALLBACK_LEADS[1], lead('fx-session-alpha', '2026-08-31T10:00:30.000Z')]
  const result = await fetchEvidence({ client: await connect(url), leads, remainingMs: 2000 })
  assert.equal(result.resends, 1)
  const alone = sent.find((x) => x.sessions === 1)
  assert.ok(alone, 'one entry was sent alone')
  assert.equal(alone.entry.session_id, 'fx-session-alpha')
  assert.equal(alone.entry.cursor, 'fxcur-unchanged', 'with its unchanged cursor')
  assert.deepEqual([alone.roles, alone.part_types, alone.max_text_chars], [['user', 'assistant'], ['text'], MAX_TEXT_CHARS], 'with the same filters')
  assert.equal(result.leads[1].status, 'ok')
  assert.ok(result.leads[1].parts.length > 0)
})

test('without the budget for it, a no-part partial entry is not resent and keeps its continuation', async (t) => {
  /** @type {number[]} */
  const sizes = []
  const { url } = await startServer(t, {
    evidence: perEntry((entry, i, args) => {
      sizes.push(args.sessions.length)
      return { session_id: entry.session_id, status: 'partial', parts: [], truncated: true, next_cursor: 'fxcur-unchanged', window: null, coverage: null }
    }),
  })
  let clock = 0
  const client = await connect(url)
  const planned = planEntries([lead('fx-session-alpha', '2026-08-31T10:00:30.000Z')])
  // 300 ms left: the floor deadline of a resend (250 ms) plus the round trip does not fit.
  const result = await callEvidence({ client, planned, leadCount: 1, deadlineAt: 300, roundTripMs: 100, now: () => clock })
  assert.notEqual(result, 'fallback')
  if (result === 'fallback') return
  assert.equal(result.resends, 0)
  assert.deepEqual(sizes, [1], 'one call, no resend')
  assert.equal(result.leads[0].status, 'partial')
  assert.equal(result.leads[0].continuation?.cursor, 'fxcur-unchanged')
})

test('every evidence call asks the client to bound the response it reads', async () => {
  /** @type {Array<number | undefined>} */
  const bounds = []
  /** @type {EvidenceMcpClient} */
  const client = {
    async callTool(_name, args, opts) {
      bounds.push(opts?.maxBytes)
      const entries = /** @type {string[]} */ (args?.sessions)
      const sessions = entries.map((s, i) => ({ request_index: i, session_id: JSON.parse(s).session_id, status: entries.length === 1 ? 'ok' : 'partial', parts: [], next_cursor: 'c' }))
      return { structuredContent: { complete: false, deadline_reached: false, sessions } }
    },
  }
  await fetchEvidence({ client, leads: FALLBACK_LEADS.slice(0, 2), remainingMs: 2000 })
  assert.ok(bounds.length >= 2, 'the first call and the resends')
  assert.ok(bounds.every((b) => b === EVIDENCE_MAX_RESPONSE_BYTES))
  assert.equal(EVIDENCE_MAX_RESPONSE_BYTES, 16 * 1024 * 1024, 'twice a server cap of up to 8 MiB (default 4 MiB)')
})

test('the warm client reads at most the bound from the daemon', async (t) => {
  const big = 'x'.repeat(EVIDENCE_MAX_RESPONSE_BYTES + 1024)
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, round_trip_ms: 1, result: { structuredContent: { pad: big } } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)) }))
  const { port } = /** @type {AddressInfo} */ (server.address())
  const warm = createWarmEvidenceClient({ endpoint: `http://127.0.0.1:${port}`, token: 't' })
  await assert.rejects(warm.callTool('session_evidence', {}), /exceeds 16777216 bytes/)
})

// ----- Server LLP 0566: parts too large to return, bounded cursors -----

/** A session_evidence handler that answers pages in order: `pages[n]` for the nth call. @param {Array<(entry: any) => any>} pages */
function paged(pages) {
  let call = 0
  return (/** @type {any} */ args, /** @type {ServerResponse} */ res, /** @type {number} */ id) => {
    const page = pages[Math.min(call++, pages.length - 1)]
    perEntry((entry) => page(entry))(args, res, id)
  }
}

const P1 = { session_id: 'fx-session-alpha', message_id: 'fx-alpha-m01', part_id: 'fx-alpha-m01#0', role: 'user', message_created_at: '2026-08-31T10:00:00.000Z', content_text: 'one', text_truncated: false }

test('skipped parts are counted and worded, the cursor is followed, and a repeated part is kept once', async (t) => {
  /** @type {any[]} */
  const sent = []
  const pages = paged([
    (e) => ({ session_id: e.session_id, status: 'partial', parts: [], skipped_parts: 1, truncated: true, next_cursor: 'fxcur-after-big-1', window: null, coverage: null }),
    (e) => ({ session_id: e.session_id, status: 'partial', parts: [], skipped_parts: 1, truncated: true, next_cursor: 'fxcur-after-big-2', window: null, coverage: null }),
    // A resumed tie group may repeat a row already returned (LLP 0566#bounded-cursor).
    (e) => ({ session_id: e.session_id, status: 'ok', parts: [P1, P1], truncated: false, next_cursor: null, window: null, coverage: { received_through: '2026-10-09T02:00:00.000Z', read_path: 'indexed', fallback_reason: null } }),
  ])
  const { url } = await startServer(t, {
    evidence: (args, res, id) => {
      sent.push(args.sessions.map((/** @type {string} */ s) => JSON.parse(s).cursor ?? null))
      pages(args, res, id)
    },
  })
  const result = await fetchEvidence({ client: await connect(url), leads: [lead('fx-session-alpha', '2026-08-31T10:00:30.000Z')], remainingMs: 2000 })
  assert.deepEqual(sent, [[null], ['fxcur-after-big-1'], ['fxcur-after-big-2']], 'each page sent alone with the cursor the last one returned')
  assert.equal(result.resends, 2)
  const l = result.leads[0]
  assert.equal(l.status, 'ok')
  assert.equal(l.skipped_parts, 2, 'skipped counts add up across pages')
  assert.deepEqual(l.parts.map((p) => p.part_id), ['fx-alpha-m01#0'], 'deduplicated by part_id')
  assert.equal(l.note, '2 parts too large to return were skipped')
  const out = buildFastaskOutput({ question: 'q', source: SOURCE, discovery: discoveryOf([lead('fx-session-alpha', null)]), evidence: result, timings: TIMINGS })
  assert.equal(out.leads[0].evidence?.skipped_parts, 2)
  assert.match(renderFastaskText(out), /evidence: ok - 2 parts too large to return were skipped/)
})

test('following an entry that keeps skipping stops after MAX_FOLLOWS_PER_ENTRY, still partial with its continuation', async (t) => {
  let calls = 0
  const { url } = await startServer(t, {
    evidence: (args, res, id) => {
      calls++
      perEntry((e) => ({ session_id: e.session_id, status: 'partial', parts: [], skipped_parts: 1, truncated: true, next_cursor: `fxcur-${calls}`, window: null, coverage: null }))(args, res, id)
    },
  })
  const result = await fetchEvidence({ client: await connect(url), leads: [lead('fx-session-alpha', null)], remainingMs: 2000 })
  assert.equal(calls, 1 + MAX_FOLLOWS_PER_ENTRY)
  assert.equal(result.resends, MAX_FOLLOWS_PER_ENTRY)
  const l = result.leads[0]
  assert.equal(l.status, 'partial')
  assert.equal(l.skipped_parts, 1 + MAX_FOLLOWS_PER_ENTRY)
  assert.equal(l.continuation?.cursor, `fxcur-${calls}`, 'the continuation resumes after the last page read')
  assert.equal(l.note, `${1 + MAX_FOLLOWS_PER_ENTRY} parts too large to return were skipped`)
})

test('cursor_unresolvable is worded for the reader and never followed', async (t) => {
  let calls = 0
  const { url } = await startServer(t, {
    evidence: (args, res, id) => {
      calls++
      perEntry((e) => ({ session_id: e.session_id, status: 'error', parts: [], truncated: false, next_cursor: null, window: null, coverage: null, error: { code: 'cursor_unresolvable', message: 'tie group over 256 rows' } }))(args, res, id)
    },
  })
  const result = await fetchEvidence({ client: await connect(url), leads: [lead('fx-session-alpha', null)], remainingMs: 2000 })
  assert.equal(calls, 1)
  assert.equal(result.leads[0].note, CURSOR_UNRESOLVABLE_NOTE)
  assert.equal(result.failure, null, 'one entry the server could not continue is not an aggregate failure by itself')
  assert.equal(skippedNote(1), '1 part too large to return was skipped')
})
