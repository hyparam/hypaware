// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { validateManifest } from '../../src/core/manifest.js'
import { activate as activateClaudeAccount } from '../../hypaware-core/plugins-workspace/claude-account/src/index.js'
import { activate as activateClaudeDesktop } from '../../hypaware-core/plugins-workspace/claude-desktop/src/index.js'

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    write(/** @type {string} */ chunk) {
      chunks.push(chunk)
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}

/**
 * Read a first-party plugin manifest off disk.
 *
 * @param {string} dirName
 * @returns {any}
 */
function readPluginManifest(dirName) {
  return JSON.parse(fsSync.readFileSync(
    new URL(`../../hypaware-core/plugins-workspace/${dirName}/hypaware.plugin.json`, import.meta.url),
    'utf8'
  ))
}

/**
 * Activate a plugin against a stub context and collect its command
 * registrations by name.
 *
 * @param {(ctx: any) => Promise<void>} activate
 * @returns {Promise<Map<string, any>>}
 */
async function collectRegisteredCommands(activate) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-cmd-visibility-'))
  /** @type {Map<string, any>} */
  const registered = new Map()
  await activate(/** @type {any} */ ({
    config: {},
    paths: { stateDir },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    configRegistry: { registerSection() {} },
    provideCapability() {},
    commands: { register: (/** @type {any} */ cmd) => { registered.set(cmd.name, cmd) } },
    requireCapability: (/** @type {string} */ name) => (
      name === 'hypaware.anthropic-credential'
        ? { mode: 'org_key', helperCommandArgs: ['claude-account', 'credential'] }
        : {}
    ),
  }))
  return registered
}

/**
 * Stage a synthetic bundled plugin whose manifest declares the given
 * commands verbatim, so help discovery reads them without booting.
 *
 * @param {{ workspaceDir: string, name: string, commands: unknown[] }} args
 */
async function stageBundledPlugin({ workspaceDir, name, commands }) {
  const dir = path.join(workspaceDir, name.replace(/^@hypaware\//, ''))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '0.0.1',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      contributes: { commands },
    })
  )
  await fs.writeFile(path.join(dir, 'index.js'), 'export async function activate() {}\n')
}

test('manifest hidden commands stay out of pre-boot top-level help', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-help-hidden-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/gascity',
    commands: [
      { name: 'demo run', summary: 'Public workflow row' },
      { name: 'demo plumbing', summary: 'Internal mechanism row', hidden: true },
    ],
  })
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/gascity' }] })
  )
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
  })

  assert.equal(code, 0)
  const out = stdout.text()
  assert.match(out, /demo\s+Subcommands: run/)
  assert.equal(out.includes('plumbing'), false, 'a hidden manifest command must not reach top-level help')
})

test('manifest command hidden must be a boolean', () => {
  const base = {
    schema_version: 1,
    name: '@hypaware/gascity',
    version: '0.0.1',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  const bad = validateManifest({
    ...base,
    contributes: { commands: [{ name: 'demo plumbing', hidden: 'yes' }] },
  })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.message : '', /hidden must be a boolean/)

  const good = validateManifest({
    ...base,
    contributes: { commands: [{ name: 'demo plumbing', summary: 's', hidden: true }] },
  })
  assert.equal(good.ok, true)
})

test('the credential helper contract is an internal mechanism in manifest and registry alike', async () => {
  const manifest = readPluginManifest('claude-account')
  const declared = manifest.contributes.commands.find((/** @type {any} */ c) => c.name === 'claude-account credential')
  assert.ok(declared, 'the helper contract stays declared so a dispatch miss can still name its plugin')
  assert.equal(declared.hidden, true, 'the helper contract must be marked hidden in the manifest')

  const registered = await collectRegisteredCommands(activateClaudeAccount)
  const credential = registered.get('claude-account credential')
  assert.ok(credential, 'the helper contract stays dispatchable: the Desktop wrapper execs it')
  assert.equal(credential.hidden, true, 'the helper contract must be hidden in the runtime registry too')

  // Public claude-account surfaces stay visible.
  for (const name of ['claude-account login', 'claude-account logout', 'claude-account status']) {
    assert.notEqual(registered.get(name)?.hidden, true, `${name} is a public surface`)
  }
})

test('every claude-desktop and claude-account command declares the same visibility in manifest and registry', async () => {
  for (const [dirName, activate] of /** @type {[string, any][]} */ ([
    ['claude-account', activateClaudeAccount],
    ['claude-desktop', activateClaudeDesktop],
  ])) {
    const manifest = readPluginManifest(dirName)
    const registered = await collectRegisteredCommands(activate)
    for (const declared of manifest.contributes.commands) {
      const cmd = registered.get(declared.name)
      assert.ok(cmd, `${declared.name}: declared but never registered`)
      assert.equal(
        cmd.hidden === true,
        declared.hidden === true,
        `${declared.name}: manifest and registry disagree on visibility`
      )
    }
  }
})

test('public diagnostics carry long help', async () => {
  const desktop = await collectRegisteredCommands(activateClaudeDesktop)
  const account = await collectRegisteredCommands(activateClaudeAccount)
  for (const cmd of [
    desktop.get('claude-desktop status'),
    account.get('claude-account status'),
  ]) {
    assert.ok(cmd, 'diagnostic command missing')
    assert.equal(typeof cmd.help, 'string', `${cmd.name}: a visible diagnostic needs long help`)
    assert.ok(cmd.help.length > 0, `${cmd.name}: long help must not be empty`)
  }
})

test('group help hides the credential helper but keeps the public claude-account surfaces', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-group-hidden-'))
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/claude-account' }] })
  )
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['claude-account', '--help'], {
    stdout,
    stderr,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
  })

  assert.equal(code, 0)
  const out = stdout.text()
  assert.match(out, /^\s+login\s/m)
  assert.match(out, /^\s+logout\s/m)
  assert.match(out, /^\s+status\s/m)
  // The word appears in the status summary, so match the subcommand column only.
  assert.doesNotMatch(out, /^\s+credential\s/m, 'group help must not advertise the helper contract')
})

test('the hidden credential helper still dispatches', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hidden-dispatch-'))
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/claude-account' }] })
  )
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['claude-account', 'credential'], {
    stdout,
    stderr,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
  })

  // Hiding is a help filter, not a deregistration: the wrapper Desktop execs
  // must still reach the command body. Signed out, the body reports it (1),
  // which is not the dispatcher's unknown/unavailable exit (2).
  assert.equal(code, 1)
  assert.match(stderr.text(), /^claude-account credential: /)
  assert.equal(stderr.text().includes('unknown command'), false)
})
