// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildPlist } from '../../src/core/daemon/macos.js'
import { buildUnit } from '../../src/core/daemon/linux.js'
import { defaultPlistDir, defaultUnitDir, plistFileName, unitFileName } from '../../src/core/daemon/platform.js'
import { nodeRuntimePaths } from '../../src/core/update/node_runtime.js'
import { handOverNodeRuntime, nodeRuntimeHandoverCommand, replaceServiceNode, repointNodeRuntime } from '../../src/core/update/node_runtime_handover.js'

/** @import { TestContext } from 'node:test' */

const oldNodePath = '/original node/bin/node'
const nodePath = '/private runtime/a&b/node'
const binPath = '/original node/bin/hyp'

test('Linux handover escapes the service control group before the worker can stop it', () => {
  const args = [binPath, '__node_runtime_repoint', oldNodePath, '123']
  const linux = nodeRuntimeHandoverCommand('linux', nodePath, args)
  assert.equal(linux.command, 'systemd-run')
  assert.ok(linux.args.includes('--user'))
  assert.ok(linux.args.includes('--scope'), 'setsid alone cannot survive systemd stopping the old service')
  assert.deepEqual(linux.args.slice(linux.args.indexOf('--') + 1), [nodePath, ...args], 'paths with spaces stay separate arguments')
  const mac = nodeRuntimeHandoverCommand('darwin', nodePath, args)
  assert.equal(mac.command, nodePath)
  assert.deepEqual(mac.args, args)
})

test('a recently restored service defers another handover so capture can re-exec instead of looping', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-node-deferred-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const env = { HOME: root, HYP_HOME: path.join(root, '.hyp') }
  const file = process.platform === 'darwin'
    ? path.join(defaultPlistDir(root), plistFileName())
    : path.join(defaultUnitDir(root), unitFileName())
  await fs.mkdir(path.dirname(file), { recursive: true })
  const original = definition(process.platform)
  await fs.writeFile(file, original)
  const paths = nodeRuntimePaths(env)
  await fs.mkdir(paths.root, { recursive: true })
  await fs.writeFile(path.join(paths.root, 'handover.pending'), '')
  const events = []
  const result = await handOverNodeRuntime({ oldNodePath, nodePath, binPath, env, log: (event, fields) => events.push({ event, ...fields }) })
  assert.equal(result, undefined, 'the caller must keep running through the verified child')
  assert.equal(await fs.readFile(file, 'utf8'), original)
  assert.ok(events.some(event => event.error_kind === 'recent_handover_attempt'))
})

/** @param {string} platform */
function definition(platform) {
  const options = { nodePath: oldNodePath, binPath, configPath: '/custom/config.json', logDir: '/custom/logs', env: { CUSTOM: 'preserve-me' } }
  return platform === 'darwin' ? buildPlist(options) : buildUnit(options)
}

for (const platform of ['darwin', 'linux']) {
  test(`${platform}: repoint changes only the interpreter and is idempotent`, () => {
    const original = definition(platform)
    const updated = replaceServiceNode(original, platform, oldNodePath, nodePath, binPath)
    assert.notEqual(updated, original)
    assert.ok(updated.includes('preserve-me'))
    assert.ok(updated.includes('/custom/config.json'))
    assert.equal(replaceServiceNode(updated, platform, nodePath, oldNodePath, binPath), original)
    assert.equal(replaceServiceNode(updated, platform, oldNodePath, nodePath, binPath), updated)
    assert.throws(() => replaceServiceNode(original, platform, '/another/node', nodePath, binPath), /service_mismatch/)
    assert.throws(() => replaceServiceNode(original, platform, oldNodePath, nodePath, '/another/hyp'), /service_mismatch/)
  })

  test(`${platform}: the service is switched before restart and success waits for health`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-node-handover-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const file = path.join(root, 'service')
    const original = definition(platform)
    await fs.writeFile(file, original)
    const calls = []
    await repointNodeRuntime({
      platform, file, oldNodePath, nodePath, binPath, oldPid: 123, env: { HYP_HOME: root },
      stop: async () => { calls.push('stop'); assert.notEqual(await fs.readFile(file, 'utf8'), original) },
      reload: async () => { calls.push('reload') },
      start: async () => { calls.push('start') },
      healthy: async () => { calls.push('healthy') },
      log: event => { calls.push(event) },
    })
    assert.deepEqual(calls, ['stop', 'reload', 'start', 'healthy', 'node_runtime.daemon_repointed'])
    assert.equal(await fs.readFile(file, 'utf8'), replaceServiceNode(original, platform, oldNodePath, nodePath, binPath))
  })

  test(`${platform}: failed replacement health restores the original service and starts it`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-node-rollback-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const file = path.join(root, 'service')
    const original = definition(platform)
    await fs.writeFile(file, original)
    const calls = []
    await assert.rejects(repointNodeRuntime({
      platform, file, oldNodePath, nodePath, binPath, oldPid: 123, env: { HYP_HOME: root },
      stop: async () => { calls.push('stop') },
      reload: async () => { calls.push('reload') },
      start: async () => { calls.push('start') },
      healthy: async () => { throw new Error('no heartbeat') },
      log: event => { calls.push(event) },
    }), /no heartbeat/)
    assert.equal(await fs.readFile(file, 'utf8'), original)
    assert.deepEqual(calls, ['stop', 'reload', 'start', 'stop', 'reload', 'start', 'node_runtime.handover_restored', 'node_runtime.handover_failed'])
  })
}

test('a mismatched service never reaches a stop or rewrite', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-node-mismatch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'service')
  const original = definition('linux')
  await fs.writeFile(file, original)
  let stopped = false
  await assert.rejects(repointNodeRuntime({
    platform: 'linux', file, oldNodePath, nodePath, binPath: '/someone-else/hyp', oldPid: 123,
    env: { HYP_HOME: root }, stop: async () => { stopped = true },
  }), /service_mismatch/)
  assert.equal(stopped, false)
  assert.equal(await fs.readFile(file, 'utf8'), original)
})
