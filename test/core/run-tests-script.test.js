// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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

for (const fails of [false, true]) {
  test(`run-tests removes leaked fixtures when a test ${fails ? 'fails' : 'passes'}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cleanup-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, 'test'))
    const temp = path.join(root, 'temp with spaces')
    fs.mkdirSync(temp)
    fs.writeFileSync(path.join(temp, 'unrelated'), 'keep')
    fs.writeFileSync(path.join(root, 'test', 'leak.test.js'), `
      const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaked-fixture-'))
      fs.writeFileSync(path.join(dir, 'data'), 'fixture')
      fs.writeFileSync('observed-root', dir)
      require('node:test')('fixture', () => { if (${fails}) throw new Error('intentional failure') })
    `)
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/run-tests.js', import.meta.url))], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, TMPDIR: temp, TMP: temp, TEMP: temp },
    })
    assert.equal(result.status, fails ? 1 : 0, result.stderr)
    assert.equal(fs.existsSync(fs.readFileSync(path.join(root, 'observed-root'), 'utf8')), false)
    assert.deepEqual(fs.readdirSync(temp), ['unrelated'])
  })
}
