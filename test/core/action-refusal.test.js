// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { markActionRefused, isActionRefused } from '../../src/core/config/action_refusal.js'

test('a thrown, marked Error round-trips through isActionRefused as true', () => {
  try {
    throw markActionRefused(new Error('permanent precondition failure'))
  } catch (err) {
    assert.equal(isActionRefused(err), true)
  }
})

test('a plain Error reads as not refused', () => {
  assert.equal(isActionRefused(new Error('transient failure')), false)
})

test('a non-Error throw reads as not refused', () => {
  try {
    throw 'a plain string throw'
  } catch (err) {
    assert.equal(isActionRefused(err), false)
  }
})
