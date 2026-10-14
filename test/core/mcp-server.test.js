// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { createMcpServer } from '../../src/core/mcp/server.js'
import { serveStdio } from '../../src/core/mcp/stdio.js'
import { REMOTE_TOOL_CONTRACTS } from '../../src/core/mcp/contracts.js'
import { createVerbRegistry } from '../../src/core/registry/verbs.js'

const readVerb = {
  name: 'query sql', tool: 'query_sql', summary: 'Run SQL', authClass: 'read',
  inputSchema: { type: 'object', properties: { sql: { type: 'string', greedy: true } }, required: ['sql'], positional: ['sql'] },
  operation: async (/** @type {any} */ p) => ({ columns: ['n'], rows: [{ n: 1n }, { n: 2n }], sql: p.sql }),
  render: () => ({ stdout: '' }),
}
const operatorVerb = {
  name: 'graph project', tool: 'graph_project', summary: 'project', authClass: 'operator',
  inputSchema: { type: 'object', properties: {} }, operation: async () => ({ ok: true }), render: () => ({ stdout: '' }),
}
const localOnlyVerb = {
  name: 'secret op', tool: 'secret_op', summary: 'local only', exposure: 'local-only',
  inputSchema: { type: 'object', properties: {} }, operation: async () => ({}), render: () => ({ stdout: '' }),
}

/** @param {object[]} list */
function fakeVerbs(list) {
  return {
    list: () => list,
    get: (/** @type {string} */ n) => list.find((v) => /** @type {any} */ (v).name === n),
    getByTool: (/** @type {string} */ t) => list.find((v) => /** @type {any} */ (v).tool === t),
    register() {},
  }
}

// One object, handed back by both members: the real registry stores the
// registration by reference and `listResources` resolves the name it read back
// through `getDataset` to prove the entry it advertises is the one a read
// would serve. A fake that minted a fresh copy per call failed that check for
// a reason nothing in production shares.
const logsDataset = { name: 'logs', plugin: '@x/otel', schema: { columns: [{ name: 'ts', type: 'TIMESTAMP', nullable: false }] } }
const fakeQuery = {
  listDatasets: () => [logsDataset],
  getDataset: (/** @type {string} */ n) => n === 'logs' ? logsDataset : undefined,
  registerDataset() {},
}

/** @param {object} [opts] */
function server(opts = {}) {
  return createMcpServer({
    verbs: /** @type {any} */ (fakeVerbs([readVerb, operatorVerb, localOnlyVerb])),
    query: /** @type {any} */ (fakeQuery),
    runTool: (/** @type {any} */ v, /** @type {any} */ p) => Promise.resolve(v.operation(p)),
    ...opts,
  })
}

test('initialize advertises serverInfo + tool/resource capabilities, echoing the client protocol', async () => {
  const r = await server().handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  assert.equal(/** @type {any} */ (r).result.serverInfo.name, 'hypaware')
  assert.equal(/** @type {any} */ (r).result.protocolVersion, '2024-11-05')
  assert.ok(/** @type {any} */ (r).result.capabilities.tools)
  assert.ok(/** @type {any} */ (r).result.capabilities.resources)
})

test('notifications get no response', async () => {
  assert.equal(await server().handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
})

test('tools/list on stdio shows read + operator + local-only (local-user trust)', async () => {
  const r = await server({ transport: 'stdio' }).handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = /** @type {any} */ (r).result.tools.map((/** @type {any} */ t) => t.name)
  assert.deepEqual(names.sort(), ['graph_project', 'query_sql', 'secret_op'])
})

test('tools/list on an http transport without operator scope hides operator + local-only', async () => {
  const r = await server({ transport: 'http', allowOperator: false }).handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = /** @type {any} */ (r).result.tools.map((/** @type {any} */ t) => t.name)
  assert.deepEqual(names, ['query_sql']) // operator + local-only withheld
})

test('tools/call runs the operation and sanitizes BigInt for JSON transport', async () => {
  const r = await server().handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query_sql', arguments: { sql: 'SELECT 1' } } })
  const result = /** @type {any} */ (r).result
  assert.equal(result.isError, false)
  // structuredContent is plain JSON (BigInt → string), and the response is serializable
  assert.doesNotThrow(() => JSON.stringify(r))
  assert.equal(typeof result.structuredContent.rows[0].n, 'string')
  assert.equal(JSON.parse(result.content[0].text).rows.length, 2)
})

test('tools/call on an operator-gated server cannot reach an operator tool', async () => {
  const r = await server({ transport: 'http', allowOperator: false }).handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'graph_project', arguments: {} } })
  assert.equal(/** @type {any} */ (r).error.code, -32601) // unknown tool (withheld)
})

test('tools/call with bad arguments is an invalid-params error', async () => {
  const r = await server().handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'query_sql', arguments: {} } })
  assert.equal(/** @type {any} */ (r).error.code, -32602)
})

test('a thrown operation becomes an isError tool result, not a protocol error', async () => {
  const throwing = {
    name: 'boom', tool: 'boom', summary: 'b', inputSchema: { type: 'object', properties: {} },
    operation: async () => { throw new Error('kaboom') }, render: () => ({ stdout: '' }),
  }
  const s = createMcpServer({ verbs: /** @type {any} */ (fakeVerbs([throwing])), query: /** @type {any} */ (fakeQuery), runTool: (/** @type {any} */ v, /** @type {any} */ p) => v.operation(p) })
  const r = await s.handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'boom', arguments: {} } })
  assert.equal(/** @type {any} */ (r).result.isError, true)
  assert.match(/** @type {any} */ (r).result.content[0].text, /kaboom/)
})

test('resources expose dataset schemas; read returns the columns', async () => {
  const list = await server().handleMessage({ jsonrpc: '2.0', id: 7, method: 'resources/list' })
  assert.equal(/** @type {any} */ (list).result.resources[0].uri, 'hypaware://dataset/logs/schema')
  const read = await server().handleMessage({ jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'hypaware://dataset/logs/schema' } })
  const text = JSON.parse(/** @type {any} */ (read).result.contents[0].text)
  assert.equal(text.dataset, 'logs')
  assert.equal(text.columns[0].name, 'ts')
})

test('unknown method and unknown resource are proper errors', async () => {
  const m = await server().handleMessage({ jsonrpc: '2.0', id: 9, method: 'frobnicate' })
  assert.equal(/** @type {any} */ (m).error.code, -32601)
  const res = await server().handleMessage({ jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'hypaware://dataset/nope/schema' } })
  assert.equal(/** @type {any} */ (res).error.code, -32602)
})

// The mark, registered but never a tool: a `cli-only` verb is hidden on every
// transport, so the instructions must not render the rule 5 line for it.
const hiddenMarkVerb = {
  name: 'report mark', tool: 'set_recommendation_status', summary: 'mark', exposure: 'cli-only',
  inputSchema: { type: 'object', properties: {} }, operation: async () => ({}), render: () => ({ stdout: '' }),
}

/**
 * Drive `serveStdio` over in-memory streams and collect the parsed replies.
 *
 * @param {{ handleMessage: (message: any) => Promise<object | null> }} s
 * @param {object[]} messages
 */
async function overStdio(s, messages) {
  const stdin = new PassThrough()
  let out = ''
  const served = serveStdio({ server: s, stdin, stdout: { write: (chunk) => { out += chunk } } })
  for (const m of messages) stdin.write(`${JSON.stringify(m)}\n`)
  stdin.end()
  await served
  return out.trim().split('\n').map((line) => JSON.parse(line))
}

test('initialize over stdio carries instructions with the stdio CLI line and nothing for a hidden tool', async () => {
  const s = createMcpServer({
    verbs: /** @type {any} */ (fakeVerbs([readVerb, operatorVerb, localOnlyVerb, hiddenMarkVerb])),
    query: /** @type {any} */ (fakeQuery),
    runTool: (/** @type {any} */ v, /** @type {any} */ p) => Promise.resolve(v.operation(p)),
    transport: 'stdio',
  })
  const [init, list] = await overStdio(s, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ])
  const text = init.result.instructions
  assert.equal(typeof text, 'string')
  assert.ok(text.includes('hyp report get <id>'))
  assert.ok(text.includes('hyp report mark <id> applied --reason ... --link ...'))
  // The hidden mark is not listed, so no line names it or calls marking expected through it.
  assert.ok(!list.result.tools.some((/** @type {any} */ t) => t.name === 'set_recommendation_status'))
  assert.ok(!text.includes('set_recommendation_status'))
  assert.ok(!text.includes('You cannot mark'))
})

test('initialize on http with no recommendation tool renders no recommendation line and no hyp report', async () => {
  const r = await server({ transport: 'http', allowOperator: false }).handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  const text = /** @type {any} */ (r).result.instructions
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0)
  assert.doesNotMatch(text, /recommendation/i)
  assert.doesNotMatch(text, /hyp report/)
})

test('initialize for an http read principal with the two read contracts renders the hand-off and no mark line', async () => {
  const verbs = createVerbRegistry()
  verbs.register(/** @type {any} */ (readVerb))
  verbs.register(/** @type {any} */ (operatorVerb))
  for (const c of REMOTE_TOOL_CONTRACTS) {
    verbs.register({
      name: `contract ${c.tool}`,
      tool: c.tool,
      title: c.title,
      summary: c.summary,
      inputSchema: c.inputSchema,
      authClass: c.authClass,
      operation: async () => ({}),
      render: () => ({ stdout: '' }),
    })
  }
  const s = createMcpServer({
    verbs,
    query: /** @type {any} */ (fakeQuery),
    runTool: (/** @type {any} */ v, /** @type {any} */ p) => Promise.resolve(v.operation(p)),
    transport: 'http',
    allowOperator: false,
  })
  const list = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.deepEqual(/** @type {any} */ (list).result.tools.map((/** @type {any} */ t) => t.name).sort(),
    ['get_recommendation', 'list_recommendations', 'query_sql'])
  const r = await s.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize' })
  const text = /** @type {any} */ (r).result.instructions
  assert.ok(text.includes('You cannot mark recommendations from here.'))
  assert.ok(text.includes('The person marks it with hyp report mark or the dashboard.'))
  assert.ok(text.includes('include_evidence'))
  // No mark line: not the tool, not rule 5, and no CLI command for the agent to run.
  assert.ok(!text.includes('set_recommendation_status'))
  assert.doesNotMatch(text, /expected last step/)
  assert.ok(!text.includes('hyp report mark <id>'))
  assert.ok(!text.includes('hyp report get'))
})

test('instructions are built once per assembly, on the first initialize, not per request', async () => {
  let listed = 0
  const fake = fakeVerbs([readVerb, operatorVerb])
  const counting = { ...fake, list: () => { listed += 1; return fake.list() } }
  const s = createMcpServer({
    verbs: /** @type {any} */ (counting),
    query: /** @type {any} */ (fakeQuery),
    runTool: (/** @type {any} */ v, /** @type {any} */ p) => Promise.resolve(v.operation(p)),
  })
  // Nothing at creation: listing reads plugin properties, and an assembly
  // that never sees `initialize` should not pay for it.
  assert.equal(listed, 0)
  /** @type {string[]} */
  const seen = []
  for (let id = 1; id <= 3; id++) {
    const r = await s.handleMessage({ jsonrpc: '2.0', id, method: 'initialize' })
    seen.push(/** @type {any} */ (r).result.instructions)
  }
  // One listing for the first `initialize`, none for the two after it.
  assert.equal(listed, 1)
  assert.equal(new Set(seen).size, 1)
  assert.ok(seen[0].length > 0)
})
