// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { computeDesiredPlistContent, residueDirPath } from '../../hypaware-core/plugins-workspace/claude-desktop/src/install.js'
import { resolveInputs } from '../../hypaware-core/plugins-workspace/claude-desktop/src/inputs.js'
import { renderCredentialHelperScript } from '../../hypaware-core/plugins-workspace/claude-desktop/src/profile.js'
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

/**
 * Write a credential wrapper the way `install-helper` does, with the two
 * baked paths under the test's control. Defaults to a wrapper that works:
 * this interpreter and a CLI entry script that is really on disk.
 *
 * @param {{ stateDir: string, nodeBin?: string, hypBin?: string, env?: Record<string, string> }} opts
 * @returns {string} the wrapper's path
 */
function writeHelper(opts) {
  let hypBin = opts.hypBin
  if (hypBin === undefined) {
    hypBin = path.join(opts.stateDir, 'hypaware.js')
    fs.writeFileSync(hypBin, '// stand-in CLI entry\n')
  }
  const helperPath = path.join(opts.stateDir, 'credential-helper.sh')
  fs.writeFileSync(helperPath, renderCredentialHelperScript({
    nodeBin: opts.nodeBin ?? process.execPath,
    hypBin,
    args: ['claude-account', 'credential'],
    env: opts.env,
  }), { mode: 0o755 })
  return helperPath
}

test('verify: missing plist and clean residue is incomplete but not thrown', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const managedPlistPath = path.join(stateDir, 'managed.plist')

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

  assert.equal(code, 1)
  assert.match(bufs.stdout.text(), /MISSING/)
  assert.match(bufs.stdout.text(), /dialog residue: clear/)
  assert.match(bufs.stdout.text(), /in-app check/)
  assert.match(bufs.stdout.text(), /entrypoint 'local-agent'/)
  assert.match(bufs.stdout.text(), /claude-desktop-3p/)
})

test('verify: up-to-date plist, live wrapper and clean residue is a green exit code', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))
  writeHelper({ stateDir })

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

  assert.equal(code, 0, bufs.stdout.text())
  assert.match(bufs.stdout.text(), /present, up to date/)
  // The point of the whole check: a working machine must not be told to
  // re-run install, or operators learn to ignore the line that matters.
  assert.match(bufs.stdout.text(), /credential wrapper: .*\(installed\)/)
  assert.doesNotMatch(bufs.stdout.text(), /STALE/)
})

// @ref LLP 0116#helper-contract [tests]: the plist names only the wrapper's path, so a rotted bake renders an identical plist and only reading the wrapper can see it
test('verify: a wrapper whose baked CLI path is gone is STALE despite an up-to-date plist', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))
  writeHelper({ stateDir, hypBin: path.join(stateDir, 'pruned', 'hypaware.js') })

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

  assert.equal(code, 1, bufs.stdout.text())
  assert.match(bufs.stdout.text(), /present, up to date/)
  assert.match(bufs.stdout.text(), /credential wrapper: .*installed but STALE: baked CLI path no longer exists/)
  assert.match(bufs.stdout.text(), /re-run 'hyp client claude-desktop install'/)
})

test('verify: a wrapper whose baked interpreter is gone is STALE (the node-version-switch case)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))
  writeHelper({ stateDir, nodeBin: path.join(stateDir, 'nvm', 'v20.0.0', 'bin', 'node') })

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

  assert.equal(code, 1, bufs.stdout.text())
  assert.match(bufs.stdout.text(), /installed but STALE: baked interpreter path no longer exists/)
})

// The one case that is stale while still on disk today: npm owns the cache
// and prunes it on its own schedule, the same reasoning core applies to the
// sibling Claude hook in `markerRecordsEphemeralHookBin`.
test('verify: a baked _npx CLI path is STALE even while it still resolves', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))
  const npxBin = path.join(stateDir, '_npx', 'ab12', 'node_modules', 'hypaware', 'bin', 'hypaware.js')
  fs.mkdirSync(path.dirname(npxBin), { recursive: true })
  fs.writeFileSync(npxBin, '// still cached, for now\n')
  writeHelper({ stateDir, hypBin: npxBin })

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

  assert.ok(fs.existsSync(npxBin), 'the cached CLI is still on disk')
  assert.equal(code, 1, bufs.stdout.text())
  assert.match(bufs.stdout.text(), /installed but STALE: baked CLI path is in npm's _npx cache/)
  // The generic re-run cannot clear this one: under the same npx it bakes the
  // same cache path back in, so the line has to name the durable install.
  assert.match(bufs.stdout.text(), /install a durable CLI first with 'npm install -g hypaware'/)
})

test('verify: a missing wrapper is reported, not passed over', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

  assert.equal(code, 1)
  assert.match(bufs.stdout.text(), /credential wrapper: .*\(NOT installed/)
})

test('verify: a wrapper this plugin did not generate is left alone, not judged stale', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))
  // A `claude_desktop.helper_path` may name the operator's own script, whose
  // paths are none of this check's business even when they do not resolve.
  fs.writeFileSync(
    path.join(stateDir, 'credential-helper.sh'),
    `#!/bin/sh\nexec ${path.join(stateDir, 'gone', 'my-node')} ${path.join(stateDir, 'gone', 'my-cli')}\n`,
    { mode: 0o755 },
  )

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

  assert.equal(code, 0, bufs.stdout.text())
  assert.doesNotMatch(bufs.stdout.text(), /STALE/)
})

test('verify: a wrapper whose baked paths hold quotes and spaces is read back correctly', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-desktop-verify-o'dd "))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))
  const hypBin = path.join(stateDir, "hyp aware's.js")
  fs.writeFileSync(hypBin, '// stand-in CLI entry\n')
  writeHelper({ stateDir, hypBin })

  const okCode = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })
  assert.equal(okCode, 0, bufs.stdout.text())

  fs.rmSync(hypBin)
  const { cmdCtx: ctx2, bufs: bufs2 } = fixture({ stateDir })
  const staleCode = await runVerify([], ctx2, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })
  assert.equal(staleCode, 1, bufs2.stdout.text())
  assert.match(bufs2.stdout.text(), /baked CLI path no longer exists/)
})

test('verify: an exec line inside a quoted env value is not mistaken for the baked command', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))
  // `shellQuote` renders a newline in HYP_HOME as a quoted value spanning
  // lines, so a line the shell only ever reads as more of the value can look
  // like the baked command. Judging it would report a live wrapper broken.
  writeHelper({ stateDir, env: { HYP_HOME: `${stateDir}\nexec /nope/node /nope/hypaware.js` } })

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

  assert.equal(code, 0, bufs.stdout.text())
  assert.doesNotMatch(bufs.stdout.text(), /STALE/)
})

test('verify: a wrapper longer than the bounded read is left alone, not cut into a false STALE', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))
  // Pad the embedded env until the 4096-byte cap lands 60 bytes into the
  // baked CLI path. A half-read path is still absolute and still absent,
  // which is a live wrapper reported broken: the cap may cost a verdict,
  // never invent one.
  const hypBin = path.join(stateDir, `${'c'.repeat(120)}.js`)
  fs.writeFileSync(hypBin, '// stand-in CLI entry\n')
  const args = ['claude-account', 'credential']
  const probe = renderCredentialHelperScript({ nodeBin: process.execPath, hypBin, args, env: { HYP_HOME: '/x' } })
  const pad = 4096 - 60 - probe.indexOf(hypBin)
  assert.ok(pad > 0, 'the unpadded wrapper already overruns the cap')
  writeHelper({ stateDir, hypBin, env: { HYP_HOME: `/x${'d'.repeat(pad)}` } })

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

  assert.equal(code, 0, bufs.stdout.text())
  assert.doesNotMatch(bufs.stdout.text(), /STALE/)
})

test('verify: a present but stale plist is reported STALE and fails', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, 'stale content')

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

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

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, managedPlistPath, platform: 'darwin' })

  assert.equal(code, 1)
  assert.match(bufs.stdout.text(), /dialog residue: PRESENT/)
})

test('verify: refuses cleanly (no throw) on an ephemeral gateway listen', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({
    stateDir,
    hypConfig: { version: 2, plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:0' } }] },
  })

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, platform: 'darwin' })

  assert.equal(code, 1)
  assert.match(bufs.stderr.text(), /ephemeral/)
})

test('verify: refuses on a non-macOS platform instead of reporting MISSING', async () => {
  // @ref LLP 0139#macos-only [tests]: off-platform the checks would answer for paths that mean nothing, so verify refuses like install
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-verify-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })

  const code = await runVerify([], cmdCtx, { sectionConfig, credential, stateDir, platform: 'linux' })

  assert.equal(code, 1)
  assert.match(bufs.stderr.text(), /unsupported platform 'linux'/)
  assert.doesNotMatch(bufs.stdout.text(), /MISSING/)
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
