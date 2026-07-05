// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { readAttachPolicy } from '../../src/core/config/attach_policy.js'

/**
 * @import { PluginConfigInstance } from '../../hypaware-plugin-kernel-types.d.ts'
 */

/**
 * Build a minimal client adapter plugin entry whose `config.attach` block is
 * exactly `attach`.
 * @param {unknown} attach
 * @returns {PluginConfigInstance}
 */
function entryWithAttach(attach) {
  return /** @type {PluginConfigInstance} */ ({
    name: '@hypaware/claude',
    config: { attach },
  })
}

test('readAttachPolicy: no entry → default-on (onJoin undefined)', () => {
  assert.deepEqual(readAttachPolicy(undefined), { onJoin: undefined })
})

test('readAttachPolicy: entry with no config → default-on', () => {
  const entry = /** @type {PluginConfigInstance} */ ({ name: '@hypaware/claude' })
  assert.deepEqual(readAttachPolicy(entry), { onJoin: undefined })
})

test('readAttachPolicy: absent attach block → default-on (onJoin undefined)', () => {
  const entry = /** @type {PluginConfigInstance} */ ({
    name: '@hypaware/claude',
    config: { proxy: '@hypaware/ai-gateway' },
  })
  assert.deepEqual(readAttachPolicy(entry), { onJoin: undefined })
})

test('readAttachPolicy: present block with no on_join → default-on', () => {
  assert.deepEqual(readAttachPolicy(entryWithAttach({})), { onJoin: undefined })
})

test('readAttachPolicy: on_join: true → opt-in', () => {
  assert.deepEqual(readAttachPolicy(entryWithAttach({ on_join: true })), {
    onJoin: true,
  })
})

test('readAttachPolicy: on_join: false → opt-out', () => {
  assert.deepEqual(readAttachPolicy(entryWithAttach({ on_join: false })), {
    onJoin: false,
  })
})

test('readAttachPolicy: present-but-malformed on_join → fail-safe opt-out', () => {
  // The JSON-typo case: a string "false" is not "default on"; do not fail open.
  assert.deepEqual(readAttachPolicy(entryWithAttach({ on_join: 'false' })), {
    onJoin: false,
  })
  assert.deepEqual(readAttachPolicy(entryWithAttach({ on_join: 'true' })), {
    onJoin: false,
  })
  assert.deepEqual(readAttachPolicy(entryWithAttach({ on_join: 1 })), {
    onJoin: false,
  })
  assert.deepEqual(readAttachPolicy(entryWithAttach({ on_join: null })), {
    onJoin: false,
  })
})

test('readAttachPolicy: attach block that is an array → default-on (ignored)', () => {
  assert.deepEqual(readAttachPolicy(entryWithAttach(['on_join'])), {
    onJoin: undefined,
  })
})

test('readAttachPolicy: attach block that is a scalar → default-on (ignored)', () => {
  assert.deepEqual(readAttachPolicy(entryWithAttach('true')), {
    onJoin: undefined,
  })
})

test('readAttachPolicy: off switch reads as onJoin !== false', () => {
  // The contract both consumers (handler T6 / status T9) rely on: default and
  // explicit-true both mean "attach"; only an explicit/coerced false opts out.
  assert.equal(readAttachPolicy(undefined).onJoin !== false, true)
  assert.equal(readAttachPolicy(entryWithAttach({ on_join: true })).onJoin !== false, true)
  assert.equal(readAttachPolicy(entryWithAttach({ on_join: false })).onJoin !== false, false)
  assert.equal(readAttachPolicy(entryWithAttach({ on_join: 'false' })).onJoin !== false, false)
})
