// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import {
  cliSurface,
  createProductResource,
  errorCode,
  productBatch,
  productEvent,
  queryFields,
  queryResult,
  rowsBucket
} from '../../src/core/product_telemetry/collection.js'
import {
  AGENT_SHELL_MARKERS,
  ERROR_CODES,
  MCP_TOOLS,
  QUERY_DATASETS,
  QUERY_ROWS,
  QUERY_SURFACES,
  QUERY_TOOLS,
  V2_ERROR_CODES,
  validateBatch
} from '../../src/core/product_telemetry/contract.js'
import { createOutbox } from '../../src/core/product_telemetry/outbox.js'
import { effectivePolicy, productRoot, writePolicy } from '../../src/core/product_telemetry/policy.js'
import { createDelivery } from '../../src/core/product_telemetry/delivery.js'
import {
  MCP_FLUSH_MS,
  MCP_FLUSH_RECORDS,
  createMcpCallRecorder,
  noteInvocation,
  withProductInvocation
} from '../../src/core/product_telemetry/client.js'
import { createMcpServer } from '../../src/core/mcp/server.js'
import { QueryExecutionBudgetError } from '../../src/core/query/sql.js'

/** @param {any} t */
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-product-v2-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param {string} root */
function enroll(root) {
  const identityPath = path.join(root, 'identity.json')
  const jwt = `header.${Buffer.from(JSON.stringify({ org: 'org-a' })).toString('base64url')}.signature`
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(identityPath, JSON.stringify({
    central_url: 'https://example.invalid',
    gateway_id: randomUUID(),
    jwt,
    expires_at: Date.now() / 1000 + 86400
  }))
  return writePolicy(root, 'organization', { url: 'https://example.invalid', identityPath })
}

/**
 * A receiver advertising `versions` that acknowledges every POST.
 * @param {number[]} versions @param {string[]} posts
 */
function receiver(versions, posts) {
  return /** @type {typeof fetch} */ (async (_, init) => {
    if (!init?.method) {
      return new Response(JSON.stringify({
        schema_versions: versions,
        max_records: 100,
        max_batch_bytes: 32768,
        max_queue_age_seconds: 604800,
        dedup_seconds: 691200
      }), { status: 200 })
    }
    posts.push(String(init.body))
    return new Response(JSON.stringify({ status: 202, duplicate: false }), { status: 202 })
  })
}

const QUERY = { datasets: ['logs'], location: 'local', rows: 3, surface: 'cli' }

/** @param {NodeJS.ProcessEnv} env @param {Record<string, any>} [note] @param {number} [code] */
function invoke(env, note = { query: QUERY }, code = 0) {
  return withProductInvocation(['query', 'sql'], env, async () => {
    noteInvocation({ command: 'query sql', kind: 'execution', ...note })
    return code
  })
}

/** @param {string} root */
function queued(root) {
  return createOutbox(root).entries().map((e) => JSON.parse(e.wire))
}

/** @param {string} root */
function toolCalls(root) {
  return queued(root).flatMap((b) => b.records).filter((r) => r.name === 'mcp.tool_call').length
}

/** @param {string} root @param {number[]} versions */
function sawReceiver(root, versions) {
  createOutbox(root).saveDelivery({
    binding: effectivePolicy(root).binding,
    state: 'accepted',
    attempt: 0,
    next_at: 0,
    schema_versions: versions
  })
}

// @ref LLP 0561#rollout [tests]: no v2 record is queued until a v2 capability is seen
test('emission builds v1 until delivery has seen the receiver advertise v2', async (t) => {
  const env = { HYP_HOME: temp(t) }
  const root = productRoot(env)
  enroll(root)
  const posts = /** @type {string[]} */ ([])
  let offset = 0
  const later = () => Date.now() + (offset += 2 * 3600_000)

  await invoke(env)
  assert.deepEqual(queued(root).map((b) => b.schema_version), [1], 'nothing seen yet')
  await createDelivery(root, { fetchFn: receiver([1], posts), now: later }).drain()
  assert.deepEqual(createOutbox(root).readDelivery().schema_versions, [1])

  await invoke(env)
  const v1 = queued(root)
  assert.deepEqual(v1.map((b) => b.schema_version), [1], 'a v1 receiver keeps emission at v1')
  const invocation = v1[0].records.find((/** @type {any} */ r) => r.name === 'cli.invocation')
  assert.equal(Object.hasOwn(invocation.attributes, 'datasets'), false, 'no query fields in v1')
  await createDelivery(root, { fetchFn: receiver([1, 2], posts), now: later }).drain()
  assert.deepEqual(createOutbox(root).readDelivery().schema_versions, [1, 2])
  assert.equal(posts.length, 2)
  assert(posts.every((p) => JSON.parse(p).schema_version === 1))

  await invoke(env)
  const v2 = queued(root)
  assert.deepEqual(v2.map((b) => b.schema_version), [2])
  assert.equal(validateBatch(v2[0], Date.now()), null)
  const fields = v2[0].records.find((/** @type {any} */ r) => r.name === 'cli.invocation').attributes
  assert.deepEqual(
    { datasets: fields.datasets, location: fields.location, rows: fields.rows, surface: fields.surface },
    { datasets: ['logs'], location: 'local', rows: '1-10', surface: 'cli' }
  )
})

test('a v2 batch is never sent to a receiver that stopped advertising v2', async (t) => {
  const env = { HYP_HOME: temp(t) }
  const root = productRoot(env)
  enroll(root)
  sawReceiver(root, [1, 2])
  await invoke(env)
  assert.deepEqual(queued(root).map((b) => b.schema_version), [2])
  const posts = /** @type {string[]} */ ([])
  await createDelivery(root, { fetchFn: receiver([1], posts), now: () => Date.now() + 1000 }).drain()
  assert.deepEqual(posts, [], 'the v2 batch never reaches the v1 receiver')
  assert.equal(queued(root).length, 0)
  assert.deepEqual(createOutbox(root).readDelivery().schema_versions, [1])
  await invoke(env)
  assert.deepEqual(queued(root).map((b) => b.schema_version), [1], 'emission follows the withdrawal')
})

test('a different binding never inherits another receiver answer', async (t) => {
  const env = { HYP_HOME: temp(t) }
  const root = productRoot(env)
  enroll(root)
  createOutbox(root).saveDelivery({ binding: 'b'.repeat(64), schema_versions: [1, 2] })
  await invoke(env)
  assert.deepEqual(queued(root).map((b) => b.schema_version), [1])
})

test('the client vocabularies are the receiver lists', () => {
  // Pinned from hypaware-server LLP 0666: a client value outside these is
  // refused there and the whole batch discarded.
  assert.deepEqual([...MCP_TOOLS], ['query_sql', 'grep_search', 'graph_neighbors', 'session_evidence', 'list_recommendations', 'get_recommendation', 'set_recommendation_status', 'open_recommendations', 'fix_recommendation', 'check_team_history', 'other'])
  assert.deepEqual([...QUERY_TOOLS], ['query_sql', 'grep_search', 'graph_neighbors', 'session_evidence'])
  assert.deepEqual([...QUERY_DATASETS], ['ai_gateway_messages', 'claude_telemetry_events', 'logs', 'traces', 'metrics', 'github_events', 'node', 'edge', 'session_summaries_daily', 'audit_events', 'product_events', 'product_metrics', 'other'])
  assert.deepEqual([...QUERY_ROWS], ['0', '1-10', '11-100', '101-1000', '>1000', 'unknown'])
  assert.deepEqual([...QUERY_SURFACES], ['cli', 'mcp', 'agent_shell', 'unknown'])
  assert.deepEqual([...V2_ERROR_CODES], [...ERROR_CODES, 'budget_exceeded'])
})

test('query fields stay inside their vocabularies', () => {
  assert.deepEqual(
    queryFields({ datasets: ['customer_secrets', 'logs', 'logs', 'traces', 'metrics', 'node', 'edge'], location: 'org', rows: 5, surface: 'claude-code' }),
    { datasets: ['other', 'logs', 'traces', 'metrics'], location: 'local', rows: '1-10', surface: 'unknown' }
  )
  assert.deepEqual(queryFields({}), { datasets: [], location: 'local', rows: 'unknown', surface: 'unknown' })
  assert.deepEqual(
    [0, 1, 10, 11, 100, 101, 1000, 1001, -1, 1.5, '3', undefined].map(rowsBucket),
    ['0', '1-10', '1-10', '11-100', '11-100', '101-1000', '101-1000', '>1000', 'unknown', 'unknown', 'unknown', 'unknown']
  )
  assert.equal(cliSurface({}), 'cli')
  for (const marker of AGENT_SHELL_MARKERS) assert.equal(cliSurface({ [marker]: '1' }), 'agent_shell', marker)
  assert.equal(cliSurface({ CLAUDECODE: '' }), 'cli', 'an empty marker is not set')

  assert.deepEqual(queryResult('query_sql', { columns: ['x'], rows: [{}, {}], datasets: ['ai_gateway_messages'], sql: 'select secret' }, 'remote', 'cli'),
    { datasets: ['ai_gateway_messages'], location: 'remote', rows: 2, surface: 'cli' })
  assert.deepEqual(queryResult('grep_search', { hits: [] }, 'local', 'mcp').datasets, ['ai_gateway_messages'])
  assert.deepEqual(queryResult('graph_neighbors', { neighbors: [{}] }, 'local', 'mcp'), { datasets: ['node', 'edge'], location: 'local', rows: 1, surface: 'mcp' })
  assert.equal(queryResult('query_sql', null, 'local', 'mcp').rows, undefined)

  const call = productEvent('mcp.tool_call', { tool: 'private_plugin_tool', outcome: 'success', duration_ms: 3.7, query: QUERY })
  assert.deepEqual(call?.attributes, { tool: 'other', outcome: 'success', error_code: 'other', duration_ms: 4 }, 'no query fields on a non-query tool')
  const status = productEvent('cli.invocation', { command: 'status', outcome: 'success', query: QUERY })
  assert.equal(Object.hasOwn(status?.attributes ?? {}, 'datasets'), false, 'no query fields on a non-query command')
})

test('v1 batches never carry a v2 field, event or code', () => {
  const now = Date.now()
  const records = /** @type {Record<string, any>[]} */ ([
    productEvent('cli.invocation', { command: 'query sql', invocation_kind: 'execution', outcome: 'failure', exit_class: 'nonzero', duration_ms: 1, query: QUERY }, now),
    productEvent('mcp.tool_call', { tool: 'query_sql', outcome: 'success', duration_ms: 1, query: QUERY }, now),
    productEvent('coded.failure', { component: 'cli', operation: 'start', error_code: 'budget_exceeded', occurrence_count: 1 }, now)
  ])
  const v2 = productBatch(createProductResource(), records, now, 2)
  assert.equal(v2?.schema_version, 2)
  assert.equal(v2?.records.length, 3)
  const v1 = productBatch(createProductResource(), records, now)
  assert.equal(v1?.schema_version, 1)
  assert.deepEqual(v1?.records.map((r) => r.name), ['cli.invocation', 'coded.failure'])
  assert.equal(v1?.records[1].attributes.error_code, 'query_failed')
  assert.equal(Object.hasOwn(v1?.records[0].attributes, 'rows'), false)
  assert.equal(records[0].attributes.rows, '1-10', 'the caller records are not mutated')
  assert.equal(productBatch(createProductResource(), [records[1]], now), null, 'a v1 batch of only tool calls is nothing')
  assert.equal(validateBatch({ ...v2, schema_version: 1 }, now), 'invalid_event', 'v1 refuses v2 content')
  assert.equal(validateBatch({ ...v2, schema_version: 3 }, now), 'unsupported_version')
})

// @ref LLP 0561#errors [tests]: by class or code, never by message text
test('failures map onto error codes by class or code only', () => {
  const coded = (/** @type {string} */ code) => Object.assign(new Error('x'), { code })
  assert.equal(errorCode(coded('ENOSPC')), 'disk_full')
  assert.equal(errorCode(coded('ECONNREFUSED')), 'unavailable')
  assert.equal(errorCode(new TypeError('fetch failed', { cause: coded('ENOTFOUND') })), 'unavailable')
  assert.equal(errorCode(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout')
  assert.equal(errorCode(new QueryExecutionBudgetError(1, 2, undefined)), 'budget_exceeded')
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'service_token_revoked' })), 'revoked')
  assert.equal(errorCode(new Error('ENOSPC: disk full, timeout, unauthorized')), null, 'message text is never read')
  assert.equal(errorCode(coded('EWHATEVER')), null)
  assert.equal(errorCode('ENOSPC'), null)
  assert.equal(errorCode(null), null)
})

test('the CLI boundary reports a classified failure code', async (t) => {
  const env = { HYP_HOME: temp(t) }
  const root = productRoot(env)
  writePolicy(root, 'local')
  sawReceiver(root, [1, 2])
  await invoke(env, { error: new QueryExecutionBudgetError(1, 2, undefined), fallback: 'query_failed' }, 1)
  await invoke(env, { error: new Error('boom'), fallback: 'query_failed' }, 1)
  await invoke(env, { error: new Error('boom') }, 1)
  const codes = queued(root)
    .sort((a, b) => Date.parse(a.records[0].timestamp) - Date.parse(b.records[0].timestamp))
    .flatMap((b) => b.records)
    .filter((r) => r.name === 'coded.failure')
    .map((r) => r.attributes.error_code)
  assert.deepEqual(codes.sort(), ['budget_exceeded', 'other', 'query_failed'])
})

// @ref LLP 0561#mcp [tests]: buffered, appended every 100 records or once a minute, flushed on shutdown
test('MCP tool calls are buffered and appended in bounded batches', async (t) => {
  const env = { HYP_HOME: temp(t) }
  const root = productRoot(env)
  writePolicy(root, 'local')
  sawReceiver(root, [1, 2])
  t.mock.timers.enable({ apis: ['setTimeout'] })
  /** @type {ReturnType<typeof createMcpCallRecorder>} */
  let recorder = null
  const call = { tool: 'query_sql', outcome: 'success', duration_ms: 12.5, query: { datasets: ['ai_gateway_messages'], location: 'local', rows: 40, surface: 'mcp' } }
  await withProductInvocation(['mcp', 'serve'], env, async () => {
    noteInvocation({ command: 'mcp serve', kind: 'execution' })
    recorder = createMcpCallRecorder()
    assert(recorder)
    for (let i = 0; i < MCP_FLUSH_RECORDS - 2; i++) recorder.record(call)
    assert.equal(queued(root).length, 0, 'nothing appended per call')
    // The first successful query also brings the milestone into the buffer.
    recorder.record(call)
    const flushed = queued(root)
    assert.equal(toolCalls(root), MCP_FLUSH_RECORDS - 1, 'a full buffer is appended at once')
    assert(flushed.every((b) => b.records.length <= 100 && validateBatch(b, Date.now()) === null))
    assert.equal(fs.existsSync(path.join(root, 'dropped')), false, 'a full batch fits the byte cap')

    recorder.record({ tool: 'set_recommendation_status', outcome: 'failure', error: new Error('no'), duration_ms: 1 })
    recorder.record({ tool: 'query_sql', outcome: 'failure', error: new QueryExecutionBudgetError(1, 2, undefined), duration_ms: 1 })
    recorder.record({ tool: 'query_sql', outcome: 'failure', error: new Error('parse'), duration_ms: 1 })
    t.mock.timers.tick(MCP_FLUSH_MS - 1)
    assert.equal(toolCalls(root), MCP_FLUSH_RECORDS - 1)
    t.mock.timers.tick(1)
    assert.equal(toolCalls(root), MCP_FLUSH_RECORDS + 2, 'the minute timer appends what is left')

    recorder.record({ tool: 'grep_search', outcome: 'success', duration_ms: 1, query: queryResult('grep_search', { hits: [] }, 'local', 'mcp') })
    return 0
  })
  const records = queued(root).flatMap((b) => b.records)
  const calls = records.filter((r) => r.name === 'mcp.tool_call')
  assert.equal(calls.length, MCP_FLUSH_RECORDS + 3, 'shutdown flushes the buffer')
  assert.equal(records.filter((r) => r.name === 'installation.milestone').length, 1)
  assert.deepEqual(calls.slice(-4, -1).map((r) => r.attributes.error_code), ['other', 'budget_exceeded', 'query_failed'])
  assert.equal(Object.hasOwn(calls.at(-4).attributes, 'datasets'), false, 'a failed call has no query fields')
  assert.equal(records.filter((r) => r.name === 'cli.invocation').length, 1, 'mcp serve keeps its one invocation')
})

test('a flush larger than one slot splits instead of dropping', async (t) => {
  const env = { HYP_HOME: temp(t) }
  const root = productRoot(env)
  writePolicy(root, 'local')
  sawReceiver(root, [1, 2])
  const wide = { datasets: ['session_summaries_daily', 'claude_telemetry_events', 'ai_gateway_messages', 'product_metrics'], location: 'remote', rows: 5000, surface: 'agent_shell' }
  await withProductInvocation(['mcp', 'serve'], env, async () => {
    noteInvocation({ command: 'mcp serve', kind: 'execution' })
    const recorder = createMcpCallRecorder()
    for (let i = 0; i < MCP_FLUSH_RECORDS; i++) recorder?.record({ tool: 'session_evidence', outcome: 'degraded', error: new QueryExecutionBudgetError(1, 2, undefined), duration_ms: 86_399_999, query: wide })
    return 0
  })
  assert.equal(fs.existsSync(path.join(root, 'dropped')), false)
  assert.equal(toolCalls(root), MCP_FLUSH_RECORDS)
})

test('MCP tool calls under a v1 receiver are not sent, but still reach first_query', async (t) => {
  const env = { HYP_HOME: temp(t) }
  const root = productRoot(env)
  writePolicy(root, 'local')
  await withProductInvocation(['mcp', 'serve'], env, async () => {
    noteInvocation({ command: 'mcp serve', kind: 'execution' })
    createMcpCallRecorder()?.record({ tool: 'query_sql', outcome: 'success', duration_ms: 1 })
    return 0
  })
  const records = queued(root).flatMap((b) => b.records)
  assert.equal(queued(root).every((b) => b.schema_version === 1), true)
  assert.equal(records.some((r) => r.name === 'mcp.tool_call'), false)
  assert.equal(records.filter((r) => r.name === 'installation.milestone').length, 1)
})

test('no recorder exists while product telemetry is off', async (t) => {
  const env = { HYP_HOME: temp(t) }
  assert.equal(createMcpCallRecorder(), null)
  await withProductInvocation(['mcp', 'serve'], env, async () => {
    assert.equal(createMcpCallRecorder(), null)
    return 0
  })
})

test('the MCP server reports each tools/call once without changing the reply', async () => {
  const verbs = [
    { name: 'query sql', tool: 'query_sql', summary: 's', authClass: 'read', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
      operation: async () => ({ rows: [{ n: 1 }], datasets: ['logs'] }), render: () => ({ stdout: '' }) },
    { name: 'boom', tool: 'boom', summary: 's', authClass: 'read', inputSchema: { type: 'object', properties: {} },
      operation: async () => { throw Object.assign(new Error('x'), { code: 'ENOSPC' }) }, render: () => ({ stdout: '' }) },
  ]
  const seen = /** @type {any[]} */ ([])
  const server = createMcpServer({
    verbs: /** @type {any} */ ({ list: () => verbs, get: () => undefined, getByTool: (/** @type {string} */ t) => verbs.find((v) => v.tool === t), register() {} }),
    query: /** @type {any} */ ({ listDatasets: () => [], getDataset: () => undefined, registerDataset() {} }),
    runTool: (/** @type {any} */ v, /** @type {any} */ p) => v.operation(p),
    onToolCall: (call) => {
      seen.push(call)
      throw new Error('an observer failure never reaches the client')
    },
  })
  const ok = /** @type {any} */ (await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query_sql', arguments: { sql: 'select 1' } } }))
  const failed = /** @type {any} */ (await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'boom', arguments: {} } }))
  const unknown = /** @type {any} */ (await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } }))
  assert.equal(ok.result.isError, false)
  assert.equal(failed.result.isError, true)
  assert.ok(unknown.error)
  assert.deepEqual(seen.map((c) => [c.tool, c.outcome]), [['query_sql', 'success'], ['boom', 'failure'], ['nope', 'failure']])
  assert.deepEqual(seen[0].value, { rows: [{ n: 1 }], datasets: ['logs'] })
  assert.equal(seen[1].error.code, 'ENOSPC')
  assert.equal(seen[2].error, null)
  assert(seen.every((c) => typeof c.duration_ms === 'number' && c.duration_ms >= 0))
})
