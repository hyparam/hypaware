// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { computeDesiredPlistContent, residueDirPath } from '../../hypaware-core/plugins-workspace/claude-desktop/src/install.js'
import { resolveInputs } from '../../hypaware-core/plugins-workspace/claude-desktop/src/inputs.js'
import { checkInstallState, runVerify } from '../../hypaware-core/plugins-workspace/claude-desktop/src/verify.js'

/**
 * @import { AnthropicCredentialCapability } from '../../hypaware-core/plugins-workspace/claude-account/src/types.js'
 */

function makeBufs() {
  let out = ''
  let err = ''
  return {
    stdout: { write: (/** @type {string} */ s) => { out += s; return true }, text: () => out },
    stderr: { write: (/** @type {string} */ s) => { err += s; return true }, text: () => err },
  }
}

/** @param {{ stateDir: string, hypConfig?: any }} opts */
function fixture(opts) {
  const bufs = makeBufs()
  /** @type {AnthropicCredentialCapability} */
  const credential = { mode: 'org_key', helperCommandArgs: ['claude-account', 'credential'] }
  const cmdCtx = /** @type {any} */ ({
    ...bufs,
    env: { HOME: opts.stateDir },
    config: opts.hypConfig ?? { version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] },
  })
  return { cmdCtx, bufs, credential, sectionConfig: {}, stateDir: opts.stateDir }
}

test('verify: missing plist and clean residue is incomplete but not thrown', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const managedPlistPath = path.join(stateDir, 'managed.plist')

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath })

  assert.equal(code, 1)
  assert.match(bufs.stdout.text(), /MISSING/)
  assert.match(bufs.stdout.text(), /dialog residue: clear/)
  assert.match(bufs.stdout.text(), /in-app check/)
  assert.match(bufs.stdout.text(), /claude-desktop-3p/)
})

test('verify: up-to-date plist and clean residue is a green exit code', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath })

  assert.equal(code, 0, bufs.stdout.text())
  assert.match(bufs.stdout.text(), /present, up to date/)
})

test('verify: a present but stale plist is reported STALE and fails', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, 'stale content')

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath })

  assert.equal(code, 1)
  assert.match(bufs.stdout.text(), /STALE/)
})

test('verify: leftover dialog residue fails even with a correct plist', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))
  fs.mkdirSync(residueDirPath(cmdCtx.env), { recursive: true })

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath })

  assert.equal(code, 1)
  assert.match(bufs.stdout.text(), /dialog residue: PRESENT/)
})

test('verify: refuses cleanly (no throw) on an ephemeral gateway listen', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({
    stateDir,
    hypConfig: { version: 2, plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:0' } }] },
  })

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir })

  assert.equal(code, 1)
  assert.match(bufs.stderr.text(), /ephemeral/)
})

test('checkInstallState is a pure read: never mutates the residue directory or plist', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, credential, sectionConfig } = fixture({ stateDir })
  const residueDir = residueDirPath(cmdCtx.env)
  fs.mkdirSync(residueDir, { recursive: true })
  fs.writeFileSync(path.join(residueDir, 'config.json'), '{}')

  const result = checkInstallState({ sectionConfig, credential, stateDir }, cmdCtx)

  assert.equal(result.residueCleared, false)
  assert.ok(fs.existsSync(residueDir), 'verify never clears residue itself')
})
