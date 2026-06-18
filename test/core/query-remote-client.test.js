// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { executeQuerySqlRemote, pingRemote, RemoteQueryError, joinUrl } from '../../src/core/query/sql-remote.js'
import { parseQuerySqlArgv } from '../../src/core/cli/core_commands.js'

/**
 * Build a fake fetch that records the request and returns a fixed response.
 * @param {{ status: number, body?: unknown, text?: string, throws?: Error }} spec
 */
function fakeFetch(spec) {
  /** @type {{ url: string, init: any }[]} */
  const calls = []
  /** @type {typeof fetch} */
  const fn = /** @type {any} */ (async (url, init) => {
    calls.push({ url: String(url), init })
    if (spec.throws) throw spec.throws
    const text = spec.text ?? (spec.body !== undefined ? JSON.stringify(spec.body) : '')
    return { status: spec.status, async text() { return text } }
  })
  return Object.assign(fn, { calls })
}

test('joinUrl tolerates a trailing slash on the base', () => {
  assert.equal(joinUrl('http://h:8740', '/v1/query'), 'http://h:8740/v1/query')
  assert.equal(joinUrl('http://h:8740/', '/v1/query'), 'http://h:8740/v1/query')
})

test('executeQuerySqlRemote maps a 200 result and sends {query} with the bearer token', async () => {
  const fetchFn = fakeFetch({ status: 200, body: { columns: ['n'], rows: [{ n: 1 }], datasets: ['logs'], truncated: false } })
  const result = await executeQuerySqlRemote({ serverUrl: 'http://h:8740', token: 'tok', query: 'SELECT 1', fetchFn })

  assert.deepEqual(result.columns, ['n'])
  assert.deepEqual(result.rows, [{ n: 1 }])
  assert.deepEqual(result.datasets, ['logs'])
  assert.deepEqual(result.freshnessMessages, [])

  const call = fetchFn.calls[0]
  assert.equal(call.url, 'http://h:8740/v1/query')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(call.init.body), { query: 'SELECT 1' })
})

test('executeQuerySqlRemote turns server truncation into a freshness notice', async () => {
  const fetchFn = fakeFetch({ status: 200, body: { columns: ['n'], rows: [{ n: 1 }, { n: 2 }], datasets: [], truncated: true, limit: 'rows:10000' } })
  const result = await executeQuerySqlRemote({ serverUrl: 'http://h:8740', token: 't', query: 'SELECT 1', fetchFn })
  assert.equal(result.freshnessMessages.length, 1)
  assert.match(result.freshnessMessages[0], /showing first 2 rows .*rows:10000.* narrow your query/)
})

test('executeQuerySqlRemote maps 401 to an unauthorized error', async () => {
  const fetchFn = fakeFetch({ status: 401, body: { error: 'unauthorized' } })
  await assert.rejects(
    () => executeQuerySqlRemote({ serverUrl: 'http://h:8740', token: 'bad', query: 'SELECT 1', fetchFn }),
    (err) => err instanceof RemoteQueryError && err.kind === 'unauthorized' && /admin token/.test(err.message)
  )
})

test('executeQuerySqlRemote surfaces query_failed detail verbatim', async () => {
  const fetchFn = fakeFetch({ status: 400, body: { error: 'query_failed', detail: 'no such table: nope' } })
  await assert.rejects(
    () => executeQuerySqlRemote({ serverUrl: 'http://h:8740', token: 't', query: 'SELECT * FROM nope', fetchFn }),
    (err) => err instanceof RemoteQueryError && err.kind === 'query_failed' && /no such table: nope/.test(err.message)
  )
})

test('executeQuerySqlRemote maps a connection failure to unreachable', async () => {
  const fetchFn = fakeFetch({ status: 0, throws: new Error('ECONNREFUSED') })
  await assert.rejects(
    () => executeQuerySqlRemote({ serverUrl: 'http://h:8740', token: 't', query: 'SELECT 1', fetchFn }),
    (err) => err instanceof RemoteQueryError && err.kind === 'unreachable' && /could not reach http:\/\/h:8740/.test(err.message)
  )
})

test('pingRemote: 200 is connected', async () => {
  const verdict = await pingRemote({ serverUrl: 'http://h:8740', token: 't', fetchFn: fakeFetch({ status: 200, body: { columns: [], rows: [] } }) })
  assert.deepEqual(verdict, { kind: 'connected', ok: true })
})

test('pingRemote: 400 query_failed still proves auth → connected', async () => {
  // The decisive case: a bad ping query does NOT mean a bad connection.
  const verdict = await pingRemote({ serverUrl: 'http://h:8740', token: 't', fetchFn: fakeFetch({ status: 400, body: { error: 'query_failed', detail: 'parse error' } }) })
  assert.equal(verdict.kind, 'connected')
  assert.equal(verdict.ok, true)
})

test('pingRemote: 401 is unauthorized', async () => {
  const verdict = await pingRemote({ serverUrl: 'http://h:8740', token: 'bad', fetchFn: fakeFetch({ status: 401, body: { error: 'unauthorized' } }) })
  assert.equal(verdict.kind, 'unauthorized')
  assert.equal(verdict.ok, false)
})

test('pingRemote: connection failure is unreachable', async () => {
  const verdict = await pingRemote({ serverUrl: 'http://h:8740', token: 't', fetchFn: fakeFetch({ status: 0, throws: new Error('ETIMEDOUT') }) })
  assert.equal(verdict.kind, 'unreachable')
  assert.equal(verdict.ok, false)
})

test('parseQuerySqlArgv: --server with a URL names the server', () => {
  const a = parseQuerySqlArgv(['SELECT 1', '--server', 'http://h:8740'])
  assert.ok(a.ok && a.serverGiven === true && a.server === 'http://h:8740')
  assert.ok(a.ok && a.refreshGiven === false)
})

test('parseQuerySqlArgv: bare --server is valid (resolves the saved target)', () => {
  const a = parseQuerySqlArgv(['SELECT 1', '--server'])
  assert.ok(a.ok && a.serverGiven === true && a.server === undefined)
  // followed by another flag is also "bare"
  const b = parseQuerySqlArgv(['SELECT 1', '--server', '--format', 'json'])
  assert.ok(b.ok && b.serverGiven === true && b.server === undefined && b.format === 'json')
})

test('parseQuerySqlArgv: no --server means local (serverGiven false)', () => {
  const a = parseQuerySqlArgv(['SELECT 1', '--refresh', 'always'])
  assert.ok(a.ok && a.serverGiven === false && a.server === undefined && a.refreshGiven === true)
})
