// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import * as direct from '../../../../src/core/cli/tui/index.js'
import * as viaPackage from 'hypaware/tui'

test('package export "hypaware/tui" resolves to the same module', () => {
  assert.equal(typeof viaPackage.multiselect, 'function')
  assert.equal(typeof viaPackage.select, 'function')
  assert.equal(typeof viaPackage.text, 'function')
  assert.equal(typeof viaPackage.confirm, 'function')
  assert.equal(typeof viaPackage.PromptCancelledError, 'function')
  // The identical function references prove the exports point at the
  // very same module instance, a sibling package importing
  // 'hypaware/tui' gets the same code.
  assert.strictEqual(viaPackage.multiselect, direct.multiselect)
  assert.strictEqual(viaPackage.PromptCancelledError, direct.PromptCancelledError)
})
