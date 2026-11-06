// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSql } from 'squirreling'

import { executeQuerySql } from '../../src/core/query/sql.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'

const storage = /** @type {any} */ ({ cacheRoot: '/tmp/hypaware-test', pendingInfo: async () => ({ pending: false }) })

/**
 * A real kernel registry holding the named datasets, so the order under test
 * is the one `listDatasets()` gives every caller.
 *
 * @param {string[]} names
 */
function registryOf(names, onOpen = () => {}) {
  const registry = createQueryRegistry()
  for (const name of names) {
    registry.registerDataset(/** @type {any} */ ({
      name,
      discoverPartitions: async () => { onOpen(); return [] },
      createDataSource: async () => { throw new Error('not opened') },
    }))
  }
  return registry
}

test('SHOW TABLES lists the registry datasets, sorted, without opening any', async () => {
  let opened = 0
  const result = await executeQuerySql({
    query: 'SHOW TABLES',
    registry: registryOf(['messages', 'ai_gateway_messages', 'sessions'], () => { opened += 1 }),
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
    registry: registryOf([]),
    storage,
  })
  assert.deepEqual(result.rows, [])
})

test('SHOW TABLES matches in any case, with a trailing semicolon and whitespace', async () => {
  const registry = registryOf(['sessions', 'messages'])
  for (const query of ['show tables;', 'Show Tables', '  sHoW\n\tTaBlEs ;  ']) {
    const result = await executeQuerySql({ query, registry, storage })
    assert.deepEqual(result.columns, ['name'], query)
    assert.deepEqual(result.rows, [{ name: 'messages' }, { name: 'sessions' }], query)
  }
})

test('SHOW TABLES keeps the registry order and reads each name once, outside any comparator', async () => {
  let reads = 0
  const named = (/** @type {string} */ name) => ({ get name() { reads += 1; return name } })
  const registry = /** @type {any} */ ({ getDataset: () => undefined, listDatasets: () => [named('zeta'), named('alpha')] })
  const result = await executeQuerySql({ query: 'SHOW TABLES', registry, storage })
  assert.deepEqual(result.rows, [{ name: 'zeta' }, { name: 'alpha' }])
  assert.equal(reads, 2)
})

test('a statement that only starts with SHOW TABLES goes to the parser and fails as before', async () => {
  let listed = 0
  const registry = /** @type {any} */ ({ getDataset: () => undefined, listDatasets: () => { listed += 1; return [] } })
  for (const query of ['SHOW TABLES FROM messages', 'show tables; select 1', 'SHOW TABLES;;', 'SHOWTABLES']) {
    /** @type {unknown} */
    let parserError
    try {
      parseSql({ query })
    } catch (err) {
      parserError = err
    }
    assert.ok(parserError instanceof Error, query)
    await assert.rejects(executeQuerySql({ query, registry, storage }), { message: parserError.message }, query)
  }
  assert.equal(listed, 0)
})
