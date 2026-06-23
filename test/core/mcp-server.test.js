// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createMcpServer } from '../../src/core/mcp/server.js'

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

const fakeQuery = {
  listDatasets: () => [{ name: 'logs', plugin: '@x/otel', schema: { columns: [{ name: 'ts', type: 'TIMESTAMP', nullable: false }] } }],
  getDataset: (/** @type {string} */ n) => n === 'logs' ? { schema: { columns: [{ name: 'ts', type: 'TIMESTAMP', nullable: false }] } } : undefined,
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
