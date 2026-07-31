// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { querySqlVerb } from '../../src/core/query/verb.js'
import { createMcpServer } from '../../src/core/mcp/server.js'
import { buildOperationContext } from '../../src/core/cli/verb_command.js'
import { DEFAULT_EXECUTION_BUDGET } from '../../src/core/query/sql.js'

// T8 (LLP 0059): the `query_sql` MCP tool runs the same `querySqlVerb`
// `operation` as the CLI (LLP 0054 #uniform-surface), so a budget refusal
// must render as an MCP tool error (`isError: true`), not a silent empty
// result or a dead connection.

/** Storage stub; the fake partition carries no tablePath, so pendingInfo is never hit. */
const storage = { cacheRoot: '/tmp/hypaware-test', pendingInfo: async () => ({ pending: false }) }

/** @param {number} i */
const row = (i) => ({ columns: ['n'], cells: { n: () => Promise.resolve(i) }, resolved: { n: i } })

/** @param {number} count */
function finiteSource(count) {
  return {
    columns: ['n'],
    numRows: count,
    scan(/** @type {any} */ _hints) {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (let i = 0; i < count; i++) yield row(i)
        },
      }
    },
  }
}

/** @param {object} source */
function mcpServerWith(source) {
  const registry = {
    getDataset: (/** @type {string} */ name) =>
      name === 't'
        ? { discoverPartitions: async () => [{}], createDataSource: () => source }
        : null,
    listDatasets: () => ['t'],
  }
  const ctx = /** @type {any} */ ({ env: {}, config: { version: 2 }, query: registry, storage })
  const verbs = {
    list: () => [querySqlVerb],
    get: (/** @type {string} */ n) => (n === querySqlVerb.name ? querySqlVerb : undefined),
    getByTool: (/** @type {string} */ t) => (t === querySqlVerb.tool ? querySqlVerb : undefined),
    register() {},
  }
  return createMcpServer({
    verbs: /** @type {any} */ (verbs),
    query: /** @type {any} */ (registry),
    runTool: (verb, params) => Promise.resolve(verb.operation(params, buildOperationContext(ctx, 'auto'))),
  })
}

test('query_sql over the host-default row ceiling renders as an MCP tool error', async () => {
  const overCeiling = (DEFAULT_EXECUTION_BUDGET.maxBufferedRows ?? 0) + 1
  const server = mcpServerWith(finiteSource(overCeiling))
  const r = /** @type {any} */ (await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'query_sql', arguments: { sql: 'SELECT * FROM t ORDER BY n' } },
  }))
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /Query execution budget exceeded: ORDER BY buffered \d+ rows, over the rows ceiling of \d+/)
  // Never a silent empty success: no structuredContent/rows on the error shape.
  assert.equal(r.result.structuredContent, undefined)
})

test('query_sql safely under the ceiling still succeeds through the same MCP path', async () => {
  const server = mcpServerWith(finiteSource(3))
  const r = /** @type {any} */ (await server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'query_sql', arguments: { sql: 'SELECT * FROM t ORDER BY n' } },
  }))
  assert.equal(r.result.isError, false)
  assert.deepEqual(r.result.structuredContent.rows.map((/** @type {any} */ row) => row.n), [0, 1, 2])
})
