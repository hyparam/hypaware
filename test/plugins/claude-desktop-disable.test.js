// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { validateManifest } from '../../src/core/manifest.js'
import { runDisable } from '../../hypaware-core/plugins-workspace/claude-desktop/src/disable.js'

function buffers() {
  let out = ''
  let err = ''
  return {
    cmdCtx: /** @type {any} */ ({
      stdout: { write(value) { out += String(value) } },
      stderr: { write(value) { err += String(value) } },
    }),
    stdout: () => out,
    stderr: () => err,
  }
}

test('disable is idempotent when the retired managed plist is absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-disable-'))
  const plist = path.join(dir, 'missing.plist')
  const bufs = buffers()
  let spawned = false
  const code = await runDisable([], bufs.cmdCtx, {
    managedPlistPath: plist,
    platform: 'darwin',
    spawnSyncImpl: () => { spawned = true; return /** @type {any} */ ({ status: 0 }) },
  })

  assert.equal(code, 0)
  assert.equal(spawned, false)
  assert.match(bufs.stdout(), /already disabled/)
})

// @ref LLP 0295#existing-installs [tests]: recovery removes only the exact retired plist, then asks for an app restart
test('disable removes the managed plist and flushes preferences', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-disable-'))
  const plist = path.join(dir, 'managed.plist')
  fs.writeFileSync(plist, 'old profile')
  const bufs = buffers()
  /** @type {Array<{ cmd: string, args: string[] }>} */
  const calls = []
  const code = await runDisable([], bufs.cmdCtx, {
    managedPlistPath: plist,
    platform: 'darwin',
    spawnSyncImpl: (cmd, args) => {
      calls.push({ cmd, args: [...args] })
      if (cmd === 'sudo') fs.unlinkSync(plist)
      return /** @type {any} */ ({ status: 0 })
    },
  })

  assert.equal(code, 0)
  assert.equal(fs.existsSync(plist), false)
  assert.deepEqual(calls, [
    { cmd: 'sudo', args: ['rm', '-f', plist] },
    { cmd: 'killall', args: ['cfprefsd'] },
  ])
  assert.match(bufs.stdout(), /Quit and reopen Claude Desktop/)
})

test('disable --print-commands has no side effects and works off macOS', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-disable-'))
  const plist = path.join(dir, 'managed plist.plist')
  fs.writeFileSync(plist, 'old profile')
  const bufs = buffers()
  let spawned = false
  const code = await runDisable(['--print-commands'], bufs.cmdCtx, {
    managedPlistPath: plist,
    platform: 'linux',
    spawnSyncImpl: () => { spawned = true; return /** @type {any} */ ({ status: 0 }) },
  })

  assert.equal(code, 0)
  assert.equal(spawned, false)
  assert.equal(fs.readFileSync(plist, 'utf8'), 'old profile')
  assert.match(bufs.stdout(), /sudo rm -f '.*managed plist\.plist'/)
  assert.match(bufs.stdout(), /killall cfprefsd/)
})

test('disable reports a failed sudo removal and does not flush preferences', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-disable-'))
  const plist = path.join(dir, 'managed.plist')
  fs.writeFileSync(plist, 'old profile')
  const bufs = buffers()
  const calls = []
  const code = await runDisable([], bufs.cmdCtx, {
    managedPlistPath: plist,
    platform: 'darwin',
    spawnSyncImpl: (cmd) => {
      calls.push(cmd)
      return /** @type {any} */ ({ status: 1 })
    },
  })

  assert.equal(code, 1)
  assert.deepEqual(calls, ['sudo'])
  assert.equal(fs.existsSync(plist), true)
  assert.match(bufs.stderr(), /did not succeed/)
})

// `retired` decides whether `hyp status` runs the live-route diagnostics or
// the residue check, so a malformed block must refuse the manifest rather
// than be dropped: dropping it removes the only surface that tells an
// affected user their app is still redirected, on exactly the machines that
// need it (LLP 0268 makes the same argument for a command's `hidden`).
// @ref LLP 0295#status-surface [tests]: a malformed retirement block is refused, never silently dropped
test('a malformed retired block is refused, not dropped', async () => {
  const base = {
    schema_version: 1,
    name: '@test/retired',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  /** @param {unknown} retired */
  const withRetired = (retired) => validateManifest({
    ...base,
    contributes: { client: { name: 'c', skill_dir: '.c/skills', retired } },
  })

  assert.equal(withRetired({ reason: 'gone' }).ok, true, 'a reason alone is a complete retirement')
  assert.equal(withRetired('gone').ok, false, 'a non-object block')
  assert.equal(withRetired({}).ok, false, 'no reason')
  assert.equal(withRetired({ reason: '' }).ok, false, 'an empty reason')
  assert.equal(withRetired({ reason: 'gone', residue_path: 42 }).ok, false, 'a non-string path')
  // The pair is the unit: either half alone describes recoverable state it
  // cannot actually report.
  assert.equal(withRetired({ reason: 'gone', residue_path: '/x' }).ok, false, 'a residue with no repair')
  assert.equal(withRetired({ reason: 'gone', repair_command: 'x y' }).ok, false, 'a repair with no residue')
  assert.equal(
    withRetired({ reason: 'gone', residue_path: '/x', repair_command: 'x y' }).ok,
    true,
    'both halves together'
  )
})
