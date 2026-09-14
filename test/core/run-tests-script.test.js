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
    // Pin the fixture's module system. With a repo-local TMPDIR this root sits
    // under the repo's own `"type": "module"` package.json, where the CommonJS
    // body below would not parse and the failure would surface as an opaque
    // missing observed-root rather than as the fixture's own error.
    fs.writeFileSync(path.join(root, 'package.json'), '{ "type": "commonjs" }\n')
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

// A fixture the suite left unreadable must not replace the run's exit status.
// Root ignores directory permissions, so only an unprivileged run can build one.
test('a temp root that cannot be removed warns without masking the suite result', { skip: process.getuid?.() === 0 ? 'needs an unprivileged uid' : false }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-unremovable-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'test'))
  fs.writeFileSync(path.join(root, 'package.json'), '{ "type": "commonjs" }\n')
  const temp = path.join(root, 'temp')
  fs.mkdirSync(temp)
  fs.writeFileSync(path.join(root, 'test', 'locked.test.js'), `
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-fixture-'))
    fs.writeFileSync(path.join(dir, 'data'), 'fixture')
    fs.writeFileSync('observed-root', dir)
    fs.chmodSync(dir, 0o000)
    require('node:test')('fixture', () => {})
  `)
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/run-tests.js', import.meta.url))], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, TMPDIR: temp, TMP: temp, TEMP: temp },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /could not remove the test temp root/)
  fs.chmodSync(fs.readFileSync(path.join(root, 'observed-root'), 'utf8'), 0o700)
})
