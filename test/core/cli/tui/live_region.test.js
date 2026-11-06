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

test('an unchanged head is written once, and later draws rewrite only the rows below it', () => {
  const { chunks, stdout } = recorder()
  const region = createLiveRegion(stdout)
  const head = 'visit:\n  ' + 'u'.repeat(15) + '\n'
  region.draw('a\n', 10, head)
  region.draw('b\n', 10, head)
  region.draw('c\n', 10, 'code: X\n')
  region.clear()
  assert.deepEqual(chunks, [
    `${head}a\n`,
    '\x1b[1A\r\x1b[Jb\n',
    // A new head redraws the whole region: one row for `visit:`, two for the
    // wrapped URL, one for the frame.
    '\x1b[4A\r\x1b[Jcode: X\nc\n',
    '\x1b[2A\r\x1b[J',
  ])
})
