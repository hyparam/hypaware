// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { getActiveSpan, runRoot } from '../../src/core/observability/index.js'
import { TracerProvider, SpanStatusCode } from '../../src/core/observability/runtime.js'
import { asyncRow } from 'squirreling'
import { executeQuerySql, streamQuerySql, QueryExecutionBudgetError } from '../../src/core/query/sql.js'

/**
 * @param {number} count
 * @returns {{ args: any, state: { pulled: number, closed: boolean, spans: (string | undefined)[] } }}
 */
function fixture(count = 5000) {
  const state = { pulled: 0, closed: false, spans: /** @type {(string | undefined)[]} */ ([]) }
  const source = {
    columns: ['a'],
    scan() {
      return {
        appliedWhere: false, appliedLimitOffset: false,
        async *rows() {
          try {
            for (let a = 0; a < count; a++) {
              if (a % 1024 === 0) state.spans.push(getActiveSpan()?.name)
              state.pulled++
              yield asyncRow({ a }, ['a'])
            }
          } finally { state.closed = true; state.spans.push(getActiveSpan()?.name) }
        },
      }
    },
  }
  const dataset = { discoverPartitions: async () => [], createDataSource: async () => source }
  return {
    state,
    args: {
      query: 'SELECT a FROM t',
      registry: { getDataset: () => dataset, listDatasets: () => [{ name: 'one' }, { name: 'two' }] },
      storage: { cacheRoot: '/tmp/hypaware-stream-test', pendingInfo: async () => ({ pending: false }) },
      maxHeapBytes: 0, includeLocalOnly: true, refresh: 'never',
    },
  }
}

test('early break closes the source without pulling the rest', async () => {
  const { args, state } = fixture()
  for await (const batch of streamQuerySql(args)) {
    assert.deepEqual(batch.rows.slice(0, 2), [{ a: 0 }, { a: 1 }])
    assert.deepEqual(batch.columns, ['a'])
    assert.deepEqual(batch.datasets, ['t'])
    break
  }
  assert.equal(state.pulled, 1024)
  assert.equal(state.closed, true)
})

test('consumer failure closes the source', async () => {
  const { args, state } = fixture()
  await assert.rejects(async () => {
    for await (const _batch of streamQuerySql(args)) throw new Error('consumer failed')
  }, { message: 'consumer failed' })
  assert.equal(state.closed, true)
})

test('manually pulled iterator closes on return', async () => {
  const { args, state } = fixture()
  const batches = streamQuerySql(args)
  await batches.next()
  await batches.return(undefined)
  assert.equal(state.closed, true)
})

test('upstream cancellation remains active through early closure', async () => {
  const { args, state } = fixture()
  const controller = new AbortController()
  const batches = streamQuerySql({ ...args, signal: controller.signal })
  await batches.next()
  controller.abort(new Error('consumer cancelled'))
  await assert.rejects(batches.return(undefined), { message: 'consumer cancelled' })
  assert.equal(state.closed, true)
})

test('uncapped callers still collect their complete result', async () => {
  const { args, state } = fixture()
  const result = await executeQuerySql(args)
  assert.equal(result.rows.length, 5000)
  assert.equal(state.pulled, 5000)
  assert.equal(state.closed, true)
})

test('empty results retain columns and metadata', async () => {
  const { args } = fixture(0)
  const result = await executeQuerySql(args)
  assert.deepEqual(result.rows, [])
  assert.deepEqual(result.columns, ['a'])
  assert.deepEqual(result.datasets, ['t'])
})

test('SHOW TABLES streams the registry without scanning', async () => {
  const { args, state } = fixture()
  for await (const batch of streamQuerySql({ ...args, query: 'SHOW TABLES' })) {
    assert.deepEqual(batch.rows, [{ name: 'one' }, { name: 'two' }])
    assert.deepEqual(batch.columns, ['name'])
  }
  assert.equal(state.pulled, 0)
})

test('the terminal memory guard covers retained consumer output on early break', async () => {
  const { args, state } = fixture(1)
  let retained
  await assert.rejects(async () => {
    for await (const _batch of streamQuerySql({ ...args, maxHeapBytes: 1 })) {
      retained = Array.from({ length: 50000 }, (_, i) => ({ text: `value-${i}-${'x'.repeat(1000)}` }))
      break
    }
  }, QueryExecutionBudgetError)
  assert.equal(retained?.length, 50000)
  assert.equal(state.closed, true)
})

test('query span stays open through pulls and closes without leaking context', async () => {
  /** @type {any[]} */
  const captured = []
  const provider = new TracerProvider({
    resource: { attributes: {} },
    exporters: [{ exportBatch(spans) { captured.push(...spans) } }],
  })
  provider.register()
  try {
    await runRoot('consumer', { status: 'ok' }, async () => {
      const { args, state } = fixture()
      const batches = streamQuerySql(args)
      const parent = getActiveSpan()
      await batches.next()
      assert.equal(getActiveSpan(), parent)
      assert.equal(captured.some(span => span.name === 'query.execute_sql'), false)
      await batches.next()
      await batches.return(undefined)
      assert.equal(getActiveSpan(), parent)
      assert.deepEqual(state.spans, ['query.execute_sql', 'query.execute_sql', 'query.execute_sql'])
    })
  } finally {
    await provider.shutdown()
  }
  const query = captured.find(span => span.name === 'query.execute_sql')
  assert.equal(query.status.code, SpanStatusCode.OK)
  assert.equal(query.attributes.row_count, 2048)
})

test('throwing into the iterator propagates failure and closes the source', async () => {
  const { args, state } = fixture()
  const batches = streamQuerySql(args)
  await batches.next()
  await assert.rejects(batches.throw(new Error('stream failed')), { message: 'stream failed' })
  assert.equal(state.closed, true)
})
