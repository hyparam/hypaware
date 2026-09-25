// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createLiveRegion } from '../../../../src/core/cli/tui/live_region.js'

function recorder() {
  /** @type {string[]} */
  const chunks = []
  return { chunks, stdout: { write: (/** @type {string} */ chunk) => { chunks.push(chunk); return true } } }
}

test('each draw erases exactly the rows the previous frame took, wraps included', () => {
  const { chunks, stdout } = recorder()
  const region = createLiveRegion(stdout)
  region.draw('one\n' + 'x'.repeat(25) + '\n', 10)
  region.draw('next\n', 10)
  assert.deepEqual(chunks, ['one\n' + 'x'.repeat(25) + '\n', '\x1b[4A\r\x1b[Jnext\n'])
})

test('clear erases the last frame once, and is a no-op before any draw', () => {
  const { chunks, stdout } = recorder()
  const region = createLiveRegion(stdout)
  region.clear()
  region.draw('a\nb\n', 80)
  region.clear()
  region.clear()
  assert.deepEqual(chunks, ['a\nb\n', '\x1b[2A\r\x1b[J'])
})
