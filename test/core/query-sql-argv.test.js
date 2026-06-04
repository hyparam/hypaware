// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_QUERY_MAX_BYTES,
  DEFAULT_QUERY_MAX_CELL,
  parseQuerySqlArgv,
} from '../../src/core/cli/core_commands.js'

/** @param {ReturnType<typeof parseQuerySqlArgv>} p */
const ok = (p) => {
  assert.equal(p.ok, true)
  return /** @type {Extract<typeof p, { ok: true }>} */ (p)
}

test('defaults: cell + byte caps on, no output, table format', () => {
  const p = ok(parseQuerySqlArgv(['SELECT 1']))
  assert.equal(p.sql, 'SELECT 1')
  assert.equal(p.format, 'table')
  assert.equal(p.output, undefined)
  assert.equal(p.maxCell, DEFAULT_QUERY_MAX_CELL)
  assert.equal(p.maxBytes, DEFAULT_QUERY_MAX_BYTES)
})

test('--output / -o capture a path', () => {
  assert.equal(ok(parseQuerySqlArgv(['SELECT 1', '--output', '/tmp/x.jsonl'])).output, '/tmp/x.jsonl')
  assert.equal(ok(parseQuerySqlArgv(['SELECT 1', '-o', '/tmp/y.jsonl'])).output, '/tmp/y.jsonl')
})

test('--max-cell / --max-bytes override, including 0 to disable', () => {
  const p = ok(parseQuerySqlArgv(['SELECT 1', '--max-cell', '0', '--max-bytes', '500']))
  assert.equal(p.maxCell, 0)
  assert.equal(p.maxBytes, 500)
})

test('flags compose in any order with multi-token SQL', () => {
  const p = ok(parseQuerySqlArgv(['--format', 'json', 'SELECT', 'a,', 'b', '--max-cell', '120']))
  assert.equal(p.sql, 'SELECT a, b')
  assert.equal(p.format, 'json')
  assert.equal(p.maxCell, 120)
})

test('--output without a value is rejected', () => {
  const p = parseQuerySqlArgv(['SELECT 1', '--output'])
  assert.equal(p.ok, false)
})

test('--max-cell rejects negative and non-integer values', () => {
  assert.equal(parseQuerySqlArgv(['SELECT 1', '--max-cell', '-5']).ok, false)
  assert.equal(parseQuerySqlArgv(['SELECT 1', '--max-bytes', 'abc']).ok, false)
})

test('missing SQL is a usage error mentioning the new flags', () => {
  const p = parseQuerySqlArgv(['--format', 'json'])
  assert.equal(p.ok, false)
  assert.match(/** @type {Extract<typeof p, { ok: false }>} */ (p).error, /--output/)
})
