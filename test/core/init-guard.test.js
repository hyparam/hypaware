// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'

// `init` writes the user-owned local layer; the overwrite guard is the
// non-destructive half of #111. @ref LLP 0031#local-layer-writers [tests]

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-init-guard-'))
  const stdout = makeBuf()
  const stderr = makeBuf()
  return {
    hypHome,
    stdout,
    stderr,
    opts: {
      stdout,
      stderr,
      stdin: /** @type {any} */ ({ isTTY: true }),
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    },
  }
}

const EXISTING = { version: 2, plugins: [{ name: '@hypaware/otel' }] }
const INCOMING = { version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] }

/** @param {string} hypHome */
async function writeFromFile(hypHome) {
  const p = path.join(hypHome, 'incoming.json')
  await fs.writeFile(p, JSON.stringify(INCOMING) + '\n')
  return p
}

test('init --from-file into a fresh home writes the config', async () => {
  const { hypHome, opts } = await makeHome()
  const fromFile = await writeFromFile(hypHome)
  const code = await dispatch(['init', '--from-file', fromFile], opts)
  assert.equal(code, 0)
  const written = JSON.parse(await fs.readFile(path.join(hypHome, 'hypaware-config.json'), 'utf8'))
  assert.deepEqual(written.plugins, INCOMING.plugins)
})

test('init --from-file refuses to clobber an existing local config without --force', async () => {
  const { hypHome, stderr, opts } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')
  const fromFile = await writeFromFile(hypHome)

  const code = await dispatch(['init', '--from-file', fromFile], opts)
  assert.equal(code, 1)
  assert.match(stderr.text(), /refusing to overwrite/)
  // The existing config is untouched.
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins, EXISTING.plugins)
})

test('init --from-file --force backs up then overwrites', async () => {
  const { hypHome, stdout, opts } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')
  const fromFile = await writeFromFile(hypHome)

  const code = await dispatch(['init', '--from-file', fromFile, '--force'], opts)
  assert.equal(code, 0, stdout.text())

  // New content written.
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins, INCOMING.plugins)

  // A timestamped backup of the old config exists with the old content.
  const backups = (await fs.readdir(hypHome)).filter((n) => n.startsWith('hypaware-config.json.bak-'))
  assert.equal(backups.length, 1)
  const backup = JSON.parse(await fs.readFile(path.join(hypHome, backups[0]), 'utf8'))
  assert.deepEqual(backup.plugins, EXISTING.plugins)
  assert.match(stdout.text(), /backed up existing config/i)
})

test('init --yes refuses to clobber an existing local config without --force', async () => {
  const { hypHome, stderr, opts } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')

  // --no-daemon keeps the finale from touching the system; the guard
  // refuses at the write step before any finale work runs.
  const code = await dispatch(['init', '--yes', '--no-daemon', '--source', 'otel'], opts)
  assert.equal(code, 1)
  assert.match(stderr.text(), /refusing to overwrite/)
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins, EXISTING.plugins)
})

// The interactive (TTY) half of the guard: prompt → decline aborts with
// no write; confirm backs up then writes. Driving runPickerWalkthrough
// with an injected `prompt` keeps `interactive = true` (no pre-baked
// picks) without driving the TUI, and an injected `confirmOverwrite`
// stub stands in for the readline prompt.

/** @param {string} hypHome */
function interactiveOpts(hypHome) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  return {
    stdout,
    stderr,
    opts: {
      capabilities: /** @type {any} */ ({}),
      stdout,
      stderr,
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      detect: async () => new Set(),
      prompt: async () => [],
      retentionPrompt: async () => 30,
    },
  }
}

test('interactive init: declining the overwrite prompt aborts with the config intact', async () => {
  const { hypHome } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')

  const { stderr, opts } = interactiveOpts(hypHome)
  const result = await runPickerWalkthrough({
    ...opts,
    confirmOverwrite: async () => false,
  })

  assert.equal(result.exitCode, 1)
  assert.match(stderr.text(), /keeping existing config/)
  // The existing config is untouched and no backup was written.
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins, EXISTING.plugins)
  const backups = (await fs.readdir(hypHome)).filter((n) => n.startsWith('hypaware-config.json.bak-'))
  assert.equal(backups.length, 0)
})

test('interactive init: confirming the overwrite prompt backs up then writes', async () => {
  const { hypHome } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')

  const { stdout, stderr, opts } = interactiveOpts(hypHome)
  const result = await runPickerWalkthrough({
    ...opts,
    confirmOverwrite: async () => true,
  })

  assert.equal(result.exitCode, 0, stderr.text())
  assert.match(stdout.text(), /Backed up existing config/)
  // A timestamped backup with the OLD content exists.
  const backups = (await fs.readdir(hypHome)).filter((n) => n.startsWith('hypaware-config.json.bak-'))
  assert.equal(backups.length, 1)
  const backup = JSON.parse(await fs.readFile(path.join(hypHome, backups[0]), 'utf8'))
  assert.deepEqual(backup.plugins, EXISTING.plugins)
  // The config was rewritten (no longer the old content).
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.notDeepEqual(after.plugins ?? [], EXISTING.plugins)
})
