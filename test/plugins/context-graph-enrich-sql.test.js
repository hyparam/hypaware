// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { isMissingDatasetError, sqlQuote } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/sql.js'

test('sqlQuote doubles single quotes and is idempotent under the doubling', () => {
  assert.equal(sqlQuote("a'b"), "a''b")
  assert.equal(sqlQuote("o'br'ien"), "o''br''ien")
  assert.equal(sqlQuote('no quotes'), 'no quotes')
  assert.equal(sqlQuote(''), '')
  // Doubling once is enough to make the value safe inside a single-quoted literal.
  assert.equal(`'${sqlQuote("x'; DROP TABLE node--")}'`, "'x''; DROP TABLE node--'")
})

test('isMissingDatasetError matches ENOENT and "unknown dataset", not arbitrary errors', () => {
  assert.equal(isMissingDatasetError(Object.assign(new Error('nope'), { code: 'ENOENT' })), true)
  assert.equal(isMissingDatasetError(new Error('unknown dataset: enrichment_prospects')), true)
  assert.equal(isMissingDatasetError(new Error('syntax error near WHERE')), false)
  assert.equal(isMissingDatasetError(null), false)
  assert.equal(isMissingDatasetError('a string'), false)
})
