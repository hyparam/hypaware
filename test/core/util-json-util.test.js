// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalJson,
  errCode,
  isPlainObject,
  parseMaybeJson,
  sha256Hex,
  sortKeys,
  stringValue,
} from '../../src/core/util/json_util.js'

test('isPlainObject accepts records, rejects null/arrays/primitives', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject({ a: 1 }), true)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject('x'), false)
  assert.equal(isPlainObject(42), false)
  assert.equal(isPlainObject(undefined), false)
})

test('stringValue passes through non-empty strings only', () => {
  assert.equal(stringValue('abc'), 'abc')
  assert.equal(stringValue(''), undefined)
  assert.equal(stringValue(7), undefined)
  assert.equal(stringValue(null), undefined)
})

test('parseMaybeJson parses strings, passes everything else through', () => {
  assert.deepEqual(parseMaybeJson('{"a":1}'), { a: 1 })
  assert.equal(parseMaybeJson('not json'), 'not json')
  const obj = { already: true }
  assert.equal(parseMaybeJson(obj), obj)
  assert.equal(parseMaybeJson(5), 5)
})

test('canonicalJson is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  // Arrays keep their order; only object keys sort.
  assert.equal(canonicalJson([{ b: 1, a: 2 }, 'x']), '[{"a":2,"b":1},"x"]')
})

test('sortKeys deep-copies without mutating the input', () => {
  const input = { b: [{ z: 1, y: 2 }], a: 1 }
  const out = /** @type {Record<string, unknown>} */ (sortKeys(input))
  assert.deepEqual(Object.keys(out), ['a', 'b'])
  assert.deepEqual(Object.keys(input), ['b', 'a'])
})

test('sha256Hex matches the known digest of an empty string', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('errCode extracts string codes and nothing else', () => {
  const err = Object.assign(new Error('x'), { code: 'ENOENT' })
  assert.equal(errCode(err), 'ENOENT')
  assert.equal(errCode(new Error('x')), undefined)
  assert.equal(errCode(Object.assign(new Error('x'), { code: 42 })), undefined)
  assert.equal(errCode(null), undefined)
  assert.equal(errCode('ENOENT'), undefined)
})
