// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { isValidRange, isValidSemver } from '../../src/core/semver.js'

test('isValidSemver accepts X.Y.Z and rejects junk', () => {
  assert.equal(isValidSemver('1.0.0'), true)
  assert.equal(isValidSemver('0.1.2-beta.1'), true)
  assert.equal(isValidSemver('1.0'), false)
  assert.equal(isValidSemver('not-semver'), false)
  assert.equal(isValidSemver(''), false)
  assert.equal(isValidSemver(undefined), false)
})

test('isValidRange accepts the operators the kernel matcher understands', () => {
  for (const r of ['*', 'x', '1.0.0', '=1.0.0', '^1.2.3', '~1.2.0', '>=1.0.0', '<=2.0.0', '>1.0.0', '<2.0.0']) {
    assert.equal(isValidRange(r), true, `${r} should be valid`)
  }
})

test('isValidRange rejects empty and unparseable ranges', () => {
  assert.equal(isValidRange(''), false)
  assert.equal(isValidRange('^garbage'), false)
  assert.equal(isValidRange('1.x'), false)
  assert.equal(isValidRange(undefined), false)
})
