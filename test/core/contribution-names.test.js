// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { isSafeContributionName, isWithinDir } from '../../src/core/runtime/contribution_names.js'

test('isSafeContributionName accepts plain basenames', () => {
  for (const name of ['hypaware-analyst', 'test-analyst', 'foo.bar', 'a', 'A_1', '..foo']) {
    assert.equal(isSafeContributionName(name), true, `expected ${name} to be safe`)
  }
})

test('isSafeContributionName rejects traversal and separators', () => {
  for (const name of [
    '',
    '.',
    '..',
    '../evil',
    '../../etc/cron.d/x',
    'a/b',
    'a\\b',
    '/abs',
    '/etc/passwd',
    'foo/../bar',
    'with\0null',
  ]) {
    assert.equal(isSafeContributionName(name), false, `expected ${JSON.stringify(name)} to be unsafe`)
  }
})

test('isSafeContributionName rejects non-strings', () => {
  for (const v of [undefined, null, 42, {}, []]) {
    assert.equal(isSafeContributionName(/** @type {any} */ (v)), false)
  }
})

test('isWithinDir accepts the base dir and paths beneath it', () => {
  const base = '/home/u/.claude/agents'
  assert.equal(isWithinDir(base, base), true)
  assert.equal(isWithinDir(path.join(base, 'analyst.md'), base), true)
  assert.equal(isWithinDir(path.join(base, 'nested', 'x.md'), base), true)
})

test('isWithinDir rejects paths that escape the base dir', () => {
  const base = '/home/u/.claude/agents'
  // The shape a traversal name would collapse to once joined.
  assert.equal(isWithinDir(path.join(base, '..', 'evil.md'), base), false)
  assert.equal(isWithinDir('/home/u/.claude/evil.md', base), false)
  assert.equal(isWithinDir('/etc/passwd', base), false)
  // A sibling sharing a name prefix must not be treated as contained.
  assert.equal(isWithinDir('/home/u/.claude/agents-evil/x.md', base), false)
})
