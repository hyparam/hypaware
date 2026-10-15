// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { executeQuerySql } from '../../src/core/query/sql.js'

const storage = /** @type {any} */ ({ cacheRoot: '/tmp/hypaware-test', pendingInfo: async () => ({ pending: false }) })

test('SHOW TABLES lists the registry datasets, sorted, without opening any', async () => {
  let opened = 0
  const dataset = (/** @type {string} */ name) => ({
    name,
    discoverPartitions: async () => { opened += 1; return [] },
    createDataSource: async () => { throw new Error('not opened') },
  })
  const datasets = [dataset('messages'), dataset('ai_gateway_messages'), dataset('sessions')]
  const result = await executeQuerySql({
    query: 'SHOW TABLES',
    registry: /** @type {any} */ ({ getDataset: () => undefined, listDatasets: () => datasets }),
    storage,
  })
  assert.deepEqual(result.columns, ['name'])
  assert.deepEqual(result.rows, [{ name: 'ai_gateway_messages' }, { name: 'messages' }, { name: 'sessions' }])
  assert.deepEqual(result.datasets, [])
  assert.equal(opened, 0)
})

test('SHOW TABLES over an empty registry answers no rows', async () => {
  const result = await executeQuerySql({
    query: 'show tables',
    registry: /** @type {any} */ ({ getDataset: () => undefined, listDatasets: () => [] }),
    storage,
  })
  assert.deepEqual(result.rows, [])
})
