// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { batchTestFiles, buildNodeTestArgs, toNodeArg } from '../../scripts/run-tests.js'

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

test('toNodeArg shortens a file under cwd to a relative path, and only when shorter', (t) => {
  const cwd = process.cwd()
  const under = path.join(cwd, 'test', 'core', 'x.test.js')
  // A file under cwd becomes the (shorter) relative path node resolves the same.
  assert.equal(toNodeArg(under), path.relative(cwd, under))
  assert.ok(toNodeArg(under).length < under.length)
  // A path outside cwd (relative would climb with `..`) keeps the absolute form,
  // so the command line is never made longer.
  const outside = path.join(cwd, '..', 'elsewhere', 'y.test.js')
  assert.equal(toNodeArg(path.resolve(outside)), path.resolve(outside))
})

test('run-tests keeps a single batch under an infinite command-line limit', () => {
  const files = Array.from({ length: 700 }, (_, i) => `test/suite-${i}.test.js`)
  assert.deepEqual(batchTestFiles(files, [], Infinity), [files])
})

test('run-tests splits batches at the command-line limit without losing or reordering files', () => {
  const files = Array.from({ length: 50 }, (_, i) => `test/suite-${String(i).padStart(3, '0')}.test.js`)
  const batches = batchTestFiles(files, ['--test-reporter', 'spec'], process.execPath.length + 200)
  assert.ok(batches.length > 1, 'a tight limit must produce more than one batch')
  assert.deepEqual(batches.flat(), files)
})

test('run-tests batching keeps an oversized single file instead of dropping it', () => {
  const files = ['test/' + 'x'.repeat(500) + '.test.js', 'test/b.test.js']
  const batches = batchTestFiles(files, [], process.execPath.length + 100)
  assert.deepEqual(batches.flat(), files)
  assert.deepEqual(batches[0], [files[0]])
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
test('a temp root that cannot be removed warns without masking the suite result', {
  skip: process.platform === 'win32'
    ? 'chmod 0o000 does not make a directory unremovable on Windows'
    : process.getuid?.() === 0 && 'needs an unprivileged uid',
}, t => {
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
