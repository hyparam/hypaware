// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { lockKeyLines } from '../../src/core/plugin_install/lock.js'

// The scanner behind the #2115 repair line: it must give each plugins key the
// line it is written on, and nothing else in the file.
test('lockKeyLines maps each plugins key to its line in file order', () => {
  const text = [
    '{',
    '  "schema_version": 1,',
    '  "other": { "decoy": { "name": "x" } },',
    '  "plugins": {',
    '    "@a/healthy": {',
    '      "name": "@a/healthy",',
    '      "source": { "kind": "local-dir", "tags": ["{", "\\"q"] }',
    '    },',
    '    "42": null,',
    '    "x\\"; rm \\\\ {": 7,',
    '    "__proto__": []',
    '  }',
    '}',
  ].join('\n')
  JSON.parse(text)
  const lines = lockKeyLines(text)
  assert.deepEqual([...lines.entries()], [
    ['@a/healthy', 5],
    ['42', 9],
    ['x"; rm \\ {', 10],
    ['__proto__', 11],
  ])
})

test('lockKeyLines keeps the occurrence JSON.parse keeps', () => {
  const text = '{"plugins":{"a":1,"b":2},\n"plugins":{\n"b":3,\n"a":4,\n"a":5}}'
  assert.deepEqual([...lockKeyLines(text).entries()], [['b', 3], ['a', 5]])
})

test('lockKeyLines is empty when there is no plugins object', () => {
  assert.equal(lockKeyLines('{"schema_version":1,"plugins":[]}').size, 0)
  assert.equal(lockKeyLines('{"schema_version":1}').size, 0)
})
