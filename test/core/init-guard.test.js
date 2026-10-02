// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { runWizardPick } from '../../src/core/cli/wizard/pick.js'

// `init` writes the user-owned local layer; the overwrite guard is the
// non-destructive half of #111. @ref LLP 0031#local-layer-writers [tests]:

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

test('init --from-file --dry-run into a fresh home writes nothing', async () => {
  const { hypHome, stdout, opts } = await makeHome()
  const fromFile = await writeFromFile(hypHome)
  const code = await dispatch(['init', '--from-file', fromFile, '--dry-run'], opts)
  assert.equal(code, 0)
  assert.match(stdout.text(), /\(dry-run\) Would write /)
  await assert.rejects(fs.access(path.join(hypHome, 'hypaware-config.json')))
})

test('init --from-file --dry-run --force leaves the existing config and makes no backup', async () => {
  const { hypHome, stdout, opts } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')
  const fromFile = await writeFromFile(hypHome)

  const code = await dispatch(['init', '--from-file', fromFile, '--dry-run', '--force'], opts)
  assert.equal(code, 0, stdout.text())
  assert.match(stdout.text(), /\(dry-run\) would back up existing config/)
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins, EXISTING.plugins)
  const backups = (await fs.readdir(hypHome)).filter((n) => n.startsWith('hypaware-config.json.bak-'))
  assert.equal(backups.length, 0)
})

test('init --yes --dry-run writes no config', async () => {
  const { hypHome, stdout, stderr, opts } = await makeHome()
  // This run reaches the finale, so HOME goes to the tmp dir with HYP_HOME.
  const code = await dispatch(
    ['init', '--yes', '--no-daemon', '--source', 'otel', '--dry-run'],
    { ...opts, env: { ...opts.env, HOME: hypHome } }
  )
  assert.equal(code, 0, stderr.text())
  assert.match(stdout.text(), /\(dry-run\) Would save settings/)
  await assert.rejects(fs.access(path.join(hypHome, 'hypaware-config.json')))
})

// A preset is the third non-interactive init form (LLP 0011
// #non-interactive-entry), so it owes the same refuse / --force / backup
// contract as `--from-file` and `--yes`.

test('init <preset> refuses to clobber an existing local config without --force', async () => {
  const { hypHome, stderr, opts } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')

  const code = await dispatch(['init', 'claude-and-otel-local'], opts)
  assert.equal(code, 1)
  assert.match(stderr.text(), /refusing to overwrite/)
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins, EXISTING.plugins)
})

test('init <preset> --force backs up then overwrites', async () => {
  const { hypHome, stdout, stderr, opts } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')

  const code = await dispatch(['init', 'claude-and-otel-local', '--force'], opts)
  assert.equal(code, 0, stderr.text())

  // The preset's config landed, so the backup was taken before the write.
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.notDeepEqual(after.plugins, EXISTING.plugins)

  // A timestamped backup of the old config exists with the old content.
  const backups = (await fs.readdir(hypHome)).filter((n) => n.startsWith('hypaware-config.json.bak-'))
  assert.equal(backups.length, 1)
  const backup = JSON.parse(await fs.readFile(path.join(hypHome, backups[0]), 'utf8'))
  assert.deepEqual(backup.plugins, EXISTING.plugins)
  assert.match(stdout.text(), /backed up existing config/i)
})

test('init <preset> --dry-run --force leaves the existing config and makes no backup', async () => {
  const { hypHome, stdout, stderr, opts } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')

  const code = await dispatch(['init', 'claude-and-otel-local', '--dry-run', '--force'], opts)
  assert.equal(code, 0, stderr.text())
  // The dry run reports the backup it would make, never one it made.
  assert.match(stdout.text(), /\(dry-run\) would back up existing config/)
  assert.deepEqual(
    (await fs.readdir(hypHome)).filter((n) => n.startsWith('hypaware-config.json.bak-')),
    []
  )
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins, EXISTING.plugins)
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

// The interactive (TTY) half of the guard: no prompt, back up then write
// (LLP 0433). Driving runWizardPick with an injected `prompt` keeps
// `interactive = true` (no pre-baked picks) without driving the TUI.

/** @param {string} hypHome */
function interactiveOpts(hypHome) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  return {
    stdout,
    stderr,
    opts: {
      stdout,
      stderr,
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      detect: async () => new Set(),
      prompt: async () => [],
    },
  }
}

test('interactive init: an existing config is backed up then rewritten without asking', async () => {
  const { hypHome } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')

  const { stdout, stderr, opts } = interactiveOpts(hypHome)
  const result = await runWizardPick(opts)

  assert.equal(result.exitCode, 0, stderr.text())
  assert.match(stdout.text(), /Saved settings \(previous config backed up\)/)
  // A timestamped backup with the OLD content exists.
  const backups = (await fs.readdir(hypHome)).filter((n) => n.startsWith('hypaware-config.json.bak-'))
  assert.equal(backups.length, 1)
  const backup = JSON.parse(await fs.readFile(path.join(hypHome, backups[0]), 'utf8'))
  assert.deepEqual(backup.plugins, EXISTING.plugins)
  // The config was rewritten (no longer the old content).
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.notDeepEqual(after.plugins ?? [], EXISTING.plugins)
})

test('init rejects an unrecognized flag as a flag, not a preset', async () => {
  const { stderr, opts } = await makeHome()
  const code = await dispatch(['init', '--bogus'], opts)
  assert.equal(code, 2)
  assert.match(stderr.text(), /unknown flag '--bogus'/)
  assert.doesNotMatch(stderr.text(), /unknown preset/)
})

// Regression: the preset dispatch (argv[0] not starting with '-') runs
// before flag parsing, so `hyp setup claude-and-otel-local --dry-run`
// reached the preset's own argv.includes('--force') check with no
// awareness of --dry-run at all, and it wrote the config unconditionally.
test('setup claude-and-otel-local --dry-run writes no config', async () => {
  const { hypHome, stdout, opts } = await makeHome()
  const code = await dispatch(['setup', 'claude-and-otel-local', '--dry-run'], opts)
  assert.equal(code, 0, stdout.text())
  assert.match(stdout.text(), /\(dry-run\) Would write /)
  await assert.rejects(fs.access(path.join(hypHome, 'hypaware-config.json')))
})

// The preset reads --dry-run out of its own raw argv (it is dispatched
// before flag parsing), and the CLI codec accepts the inline-boolean
// spelling for any boolean flag elsewhere (--flag=true / --flag=false),
// so the preset needs to honor that spelling too, not just the bare flag.
test('setup claude-and-otel-local --dry-run=true writes no config', async () => {
  const { hypHome, stdout, opts } = await makeHome()
  const code = await dispatch(['setup', 'claude-and-otel-local', '--dry-run=true'], opts)
  assert.equal(code, 0, stdout.text())
  assert.match(stdout.text(), /\(dry-run\) Would write /)
  await assert.rejects(fs.access(path.join(hypHome, 'hypaware-config.json')))
})

test('setup claude-and-otel-local --dry-run=false writes the config', async () => {
  const { hypHome, stdout, opts } = await makeHome()
  const code = await dispatch(['setup', 'claude-and-otel-local', '--dry-run=false'], opts)
  assert.equal(code, 0, stdout.text())
  assert.match(stdout.text(), /✓ Wrote /)
  await assert.doesNotReject(fs.access(path.join(hypHome, 'hypaware-config.json')))
})

// `--force` is read out of the same raw argv as `--dry-run`, so it owes
// the same inline-boolean spelling. `--force=true` used to be inert: the
// preset refused and left the config byte-identical (#2439).
test('setup claude-and-otel-local --force=true backs up then overwrites', async () => {
  const { hypHome, stdout, stderr, opts } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')

  const code = await dispatch(['setup', 'claude-and-otel-local', '--force=true'], opts)
  assert.equal(code, 0, stderr.text())

  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.notDeepEqual(after.plugins, EXISTING.plugins)

  // The newly enabled overwrite still backs up first: one timestamped
  // .bak carrying the prior content.
  const backups = (await fs.readdir(hypHome)).filter((n) => n.startsWith('hypaware-config.json.bak-'))
  assert.equal(backups.length, 1)
  const backup = JSON.parse(await fs.readFile(path.join(hypHome, backups[0]), 'utf8'))
  assert.deepEqual(backup.plugins, EXISTING.plugins)
  assert.match(stdout.text(), /backed up existing config/i)
})

test('setup claude-and-otel-local --force=false refuses to clobber an existing config', async () => {
  const { hypHome, stderr, opts } = await makeHome()
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify(EXISTING) + '\n')

  const code = await dispatch(['setup', 'claude-and-otel-local', '--force=false'], opts)
  assert.equal(code, 1)
  assert.match(stderr.text(), /refusing to overwrite/)
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins, EXISTING.plugins)
  assert.deepEqual(
    (await fs.readdir(hypHome)).filter((n) => n.startsWith('hypaware-config.json.bak-')),
    []
  )
})
