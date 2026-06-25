// @ts-check

import { createRequire } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')

function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

function makeDispatchOpts() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  const stdout = makeBuf()
  const stderr = makeBuf()
  return {
    stdout,
    stderr,
    env: { ...process.env, HYP_HOME: '/tmp/hyp-version-test' },
    registry,
    kernel,
  }
}

test('hyp --version prints version and exits 0', async () => {
  const opts = makeDispatchOpts()
  const code = await dispatch(['--version'], opts)
  assert.equal(code, 0)
  assert.equal(opts.stdout.text(), `hypaware ${pkg.version}\n`)
})

test('hyp -V prints version and exits 0', async () => {
  const opts = makeDispatchOpts()
  const code = await dispatch(['-V'], opts)
  assert.equal(code, 0)
  assert.equal(opts.stdout.text(), `hypaware ${pkg.version}\n`)
})

test('hyp version prints version info and exits 0', async () => {
  const opts = makeDispatchOpts()
  const code = await dispatch(['version'], opts)
  assert.equal(code, 0)
  const out = opts.stdout.text()
  assert.ok(out.startsWith(`hypaware ${pkg.version}\n`))
  assert.ok(out.includes('node:'))
  assert.ok(out.includes('platform:'))
  assert.ok(out.includes('hyp_home:'))
})

test('version string matches package.json', async () => {
  const opts = makeDispatchOpts()
  const code = await dispatch(['--version'], opts)
  assert.equal(code, 0)
  const version = opts.stdout.text().trim().replace('hypaware ', '')
  assert.equal(version, pkg.version)
})
