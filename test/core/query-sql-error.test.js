// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { executeQuerySql } from '../../src/core/query/sql.js'

/** Minimal registry/storage stubs: parse failures fire before either is used. */
const registry = { getDataset: () => null, listDatasets: () => [] }
const storage = { cacheRoot: '/tmp/hypaware-test', pendingInfo: async () => ({ pending: false }) }

/** @param {string} query */
async function runExpectError(query) {
  try {
    await executeQuerySql({ query, registry: /** @type {any} */ (registry), storage: /** @type {any} */ (storage) })
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error(`expected ${JSON.stringify(query)} to throw`)
}

test('parse errors surface the squirreling message verbatim, unwrapped', async () => {
  const message = await runExpectError('SELECT foo(1)')
  assert.match(message, /Unknown function "foo"/)
  assert.doesNotMatch(message, /single read-only SELECT/)
})

test('non-SELECT statements surface the parser message without extra framing', async () => {
  const message = await runExpectError('INSERT INTO t VALUES (1)')
  assert.match(message, /Expected SELECT but found "INSERT"/)
  assert.doesNotMatch(message, /single read-only SELECT/)
})

test('empty SQL is reported as required', async () => {
  const message = await runExpectError('   ')
  assert.match(message, /SQL query is required/)
})
