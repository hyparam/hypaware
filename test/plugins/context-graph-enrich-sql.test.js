// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { isMissingDatasetError, runSql, sqlQuote } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/sql.js'

/** @param {(args: { query: string }) => Promise<{ rows: Record<string, unknown>[] }>} execSql */
function rt(execSql) {
  return /** @type {any} */ ({ execSql })
}

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

test('runSql tolerates a missing dataset only when allowMissing is set (else fail-fast)', async () => {
  const missing = async () => { throw new Error('unknown dataset: enrichment_prospects') }
  // Default (the source-dataset read): a missing/misspelled dataset must surface.
  await assert.rejects(runSql(rt(missing), 'SELECT 1 FROM enrichment_prospects'), /unknown dataset/)
  // Opt-in (a plugin-owned table not yet written): benign, returns [].
  assert.deepEqual(await runSql(rt(missing), 'SELECT 1 FROM enrichment_prospects', { allowMissing: true }), [])
})

test('runSql rethrows non-missing errors even with allowMissing', async () => {
  const boom = async () => { throw new Error('syntax error near WHERE') }
  await assert.rejects(runSql(rt(boom), 'SELECT bad', { allowMissing: true }), /syntax error/)
})

test('runSql returns the executor rows on success', async () => {
  const rows = [{ n: 3 }]
  assert.deepEqual(await runSql(rt(async () => ({ rows })), 'SELECT COUNT(*) AS n FROM node'), rows)
})
