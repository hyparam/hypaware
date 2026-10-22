// @ts-check

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'
import { matchesSemverRange } from '../../src/core/semver.js'
import { supportsApplicationNode } from '../../src/core/update/node_runtime.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')
const bin = fileURLToPath(new URL('../../bin/hypaware.js', import.meta.url))

test('the bootstrap accepts older customers but application execution requires patched Node', () => {
  assert.equal(matchesSemverRange('22.12.0', pkg.engines.node), true)
  assert.equal(matchesSemverRange('24.2.0', pkg.engines.node), true)
  for (const version of ['22.23.4', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0']) {
    assert.equal(supportsApplicationNode(version), true, version)
  }
  for (const version of ['20.20.0', '22.12.0', '22.23.3', '23.11.0', '24.2.0', '24.22.0', '25.9.0', '26.12.0']) {
    assert.equal(supportsApplicationNode(version), false, version)
  }
})

test('an unsafe Node reaches the runtime bootstrap before the application dispatcher', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-node-floor-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = isolatedClientEnv(process.env, home)
  delete env.CURSOR_VERSION

  for (const version of ['22.23.3', '24.2.0', '24.22.0', '25.9.0', '26.12.0', '26.12.1-rc.1']) {
    const preload = `
      import { registerHooks } from 'node:module'
      Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} })
      registerHooks({ load(url, context, next) {
        if (url.endsWith('/src/core/update/node_runtime.js')) {
          return { format: 'module', source: 'export async function bootstrapNodeRuntime() { throw new Error("runtime bootstrap reached") }', shortCircuit: true }
        }
        if (url.endsWith('/src/core/cli/dispatch.js')) {
          throw new Error('unsafe runtime reached boot')
        }
        return next(url, context)
      } })
    `
    const run = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      bin, 'daemon', 'run', '--foreground',
    ], { env, encoding: 'utf8', timeout: 10000 })
    assert.ifError(run.error)
    assert.equal(run.status, 1, version)
    assert.match(run.stderr, /runtime bootstrap reached/, version)
    assert.doesNotMatch(run.stderr, /unsafe runtime reached boot/, version)
  }
  assert.deepEqual(fs.readdirSync(home), [], 'refusal does not write user state')
})

test('old updater version preflight never downloads or loads application code', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-node-preflight-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const preload = `
    import { registerHooks } from 'node:module'
    Object.defineProperty(process.versions, 'node', { value: '24.2.0' })
    registerHooks({ load(url, context, next) {
      if (url.endsWith('/src/core/update/node_runtime.js') || url.endsWith('/src/core/cli/dispatch.js')) throw new Error('preflight loaded application')
      return next(url, context)
    } })
  `
  for (const flag of ['--version', '-V']) {
    const run = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bin, flag], {
      env: isolatedClientEnv(process.env, home), encoding: 'utf8', timeout: 10000,
    })
    assert.ifError(run.error)
    assert.equal(run.status, 0)
    assert.equal(run.stdout, `hypaware ${pkg.version}\n`)
    assert.equal(run.stderr, '')
  }
  assert.deepEqual(fs.readdirSync(home), [])
})

test('inactive Claude hooks inherited by Cursor remain no-ops on an old Node', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-node-cursor-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const preload = "Object.defineProperty(process.versions, 'node', { value: '24.2.0' })"
  const run = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    bin, 'claude-hook', 'session-context',
  ], {
    env: { ...isolatedClientEnv(process.env, home), CURSOR_VERSION: '1.0.0' },
    encoding: 'utf8',
    timeout: 10000,
  })
  assert.ifError(run.error)
  assert.equal(run.status, 0)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr, '')
  assert.deepEqual(fs.readdirSync(home), [])
})
