// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildNodeTestArgs } from '../../scripts/run-tests.js'

test('run-tests forwards node --test flags before discovered test files', () => {
  assert.deepEqual(
    buildNodeTestArgs(
      ['test/a.test.js', 'test/b.test.js'],
      ['--test-name-pattern', 'runtime', '--test-reporter', 'spec'],
    ),
    [
      '--test',
      '--test-name-pattern',
      'runtime',
      '--test-reporter',
      'spec',
      'test/a.test.js',
      'test/b.test.js',
    ],
  )
})

test('run-tests appends discovered test files when no flags are forwarded', () => {
  assert.deepEqual(
    buildNodeTestArgs(['test/a.test.js']),
    ['--test', 'test/a.test.js'],
  )
})
