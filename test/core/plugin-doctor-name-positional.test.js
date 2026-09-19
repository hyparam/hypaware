// @ts-check

// `hyp plugin doctor` takes a directory, and a plugin name is not one, so a
// name was joined to the cwd and diagnosed as a phantom: a header naming a path
// that never existed, a `manifest_invalid` for it, and two repair hints written
// for a plugin the operator is authoring rather than a first-party adapter the
// package ships (issue #1584). The operator arrives here off `hyp plugin list`
// naming a bundled plugin this boot did not activate, so the name is a bundled
// one and the dead end is the end of that path.
//
// These drive the real CLI rather than the command function, because the defect
// is what an operator reads, and because the directory half has to be shown
// unchanged through the same dispatch that resolves a relative path.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = path.join(REPO_ROOT, 'bin', 'hypaware.js')
const USAGE = 'usage: hyp plugin doctor [dir] [--json]\n'

/**
 * Run the packaged CLI against `hypHome` from `cwd`. Dev-telemetry, OTLP and
 * `HYP_CONFIG` are stripped so the run stands on a default install's footing.
 *
 * @param {string} hypHome
 * @param {string[]} argv
 * @param {string} [cwd]
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCli(hypHome, argv, cwd) {
  /** @type {Record<string, string|undefined>} */
  const env = { ...process.env, HYP_HOME: hypHome }
  delete env.HYP_CONFIG
  delete env.HYP_DEV_TELEMETRY
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete env.DEV_RUN_ID
  const out = spawnSync(process.execPath, [BIN, ...argv], { env, cwd, encoding: 'utf8' })
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

/** The manifest the package actually ships for a bundled name, so nothing below pins a release. */
async function bundledManifest(/** @type {string} */ name) {
  const bundled = await discoverBundledPlugins()
  const entry = [...bundled.loaded, ...bundled.excluded].find((m) => m.manifest.name === name)
  assert.ok(entry, `expected the package to bundle ${name}`)
  return entry
}

/**
 * @param {string} prefix
 * @param {{ lock?: Record<string, any> }} [fixture]
 */
async function makeHome(prefix, fixture = {}) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const stateDir = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateDir, { recursive: true })
  if (fixture.lock) await writeLock(stateDir, { schema_version: 1, plugins: fixture.lock })
  return hypHome
}

// The issue's repro. The directory named has to be the one the package ships,
// read off the same discovery `plugin list` and `plugin info` read: a
// string-built guess at where a bundled plugin sits is the failure this invites.
test('plugin doctor refuses a bundled plugin name and names the directory it ships in', async () => {
  const claude = await bundledManifest('@hypaware/claude')
  const hypHome = await makeHome('hyp-doctor-name-bundled-')
  try {
    const out = runCli(hypHome, ['plugin', 'doctor', '@hypaware/claude'], os.tmpdir())
    assert.equal(out.status, 2, `expected exit 2, got ${out.status}: ${out.stderr}`)
    assert.equal(out.stdout, '')
    assert.equal(
      out.stderr,
      "hyp plugin doctor: '@hypaware/claude' is a plugin name; this command takes a plugin directory\n"
        + `  @hypaware/claude lives at ${claude.rootDir}\n`
        + `  run: hyp plugin doctor ${claude.rootDir}\n`
        + USAGE
    )
    // The cwd the old code would have joined the name to is never named.
    assert.ok(!out.stderr.includes(path.join(os.tmpdir(), '@hypaware')))
    // And the directory it does name is one doctor can actually be re-run on.
    await fs.stat(path.join(claude.rootDir, 'hypaware.plugin.json'))
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// A name with no bundled copy is answered from the lock, so the same refusal
// works for a third-party plugin the operator installed.
test('plugin doctor names the install directory for an installed-only plugin name', async () => {
  const installDir = path.join(os.tmpdir(), 'hyp-doctor-name-fixture', 'widget')
  const hypHome = await makeHome('hyp-doctor-name-installed-', {
    lock: {
      '@acme/hypaware-plugin-widget': {
        name: '@acme/hypaware-plugin-widget',
        version: '1.0.0',
        source: { kind: 'scoped-third-party', raw: '@acme/hypaware-plugin-widget' },
        install_dir: installDir,
        content_hash: 'a'.repeat(64),
        manifest_hash: 'b'.repeat(64),
        installed_at: '2026-09-01T00:00:00.000Z',
      },
    },
  })
  try {
    const out = runCli(hypHome, ['plugin', 'doctor', '@acme/hypaware-plugin-widget'], os.tmpdir())
    assert.equal(out.status, 2, `expected exit 2, got ${out.status}: ${out.stderr}`)
    assert.equal(
      out.stderr,
      "hyp plugin doctor: '@acme/hypaware-plugin-widget' is a plugin name; this command takes a plugin directory\n"
        + `  @acme/hypaware-plugin-widget lives at ${installDir}\n`
        + `  run: hyp plugin doctor ${installDir}\n`
        + USAGE
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// A name matching nothing is still a usage error, not a crash and not a
// diagnosis of a path that never existed.
test('plugin doctor refuses a name-shaped positional matching no plugin', async () => {
  const hypHome = await makeHome('hyp-doctor-name-unknown-')
  try {
    const out = runCli(hypHome, ['plugin', 'doctor', '@nope/missing'], os.tmpdir())
    assert.equal(out.status, 2, `expected exit 2, got ${out.status}: ${out.stderr}`)
    assert.equal(
      out.stderr,
      "hyp plugin doctor: '@nope/missing' is a plugin name; this command takes a plugin directory\n"
        + "  no plugin named '@nope/missing' is installed or bundled with this package,"
        + ' so there is no directory to diagnose\n'
        + USAGE
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The other half of the contract, asserted rather than assumed: the positional
// is still a directory and nothing about reading one changed.
test('plugin doctor still diagnoses a directory positional', async () => {
  const claude = await bundledManifest('@hypaware/claude')
  const hypHome = await makeHome('hyp-doctor-dir-ok-')
  try {
    const abs = runCli(hypHome, ['plugin', 'doctor', claude.rootDir], os.tmpdir())
    assert.equal(abs.status, 0, `expected exit 0, got ${abs.status}: ${abs.stderr}`)
    assert.match(abs.stdout, /^plugin doctor: @hypaware\/claude \(/)
    assert.ok(abs.stdout.includes(claude.rootDir))

    // Relative, and resolved against the cwd exactly as before.
    const rel = runCli(hypHome, ['plugin', 'doctor', path.basename(claude.rootDir)], path.dirname(claude.rootDir))
    assert.equal(rel.status, 0, `expected exit 0, got ${rel.status}: ${rel.stderr}`)
    assert.equal(rel.stdout, abs.stdout)

    // And with no positional at all.
    const here = runCli(hypHome, ['plugin', 'doctor'], claude.rootDir)
    assert.equal(here.status, 0, `expected exit 0, got ${here.status}: ${here.stderr}`)
    assert.equal(here.stdout, abs.stdout)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The refusal is narrow on purpose. A bare token is a directory name, including
// the `hypaware-plugin-<name>` shape `hyp plugin new` scaffolds into a directory
// of that name, so it still reaches the diagnosis it always did - here the
// missing-manifest report the issue quoted, which is correct for a path.
test('plugin doctor still treats a bare token as a directory', async () => {
  const hypHome = await makeHome('hyp-doctor-dir-bare-')
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-doctor-bare-cwd-'))
  try {
    for (const token of ['nosuchdir', 'hypaware-plugin-widget']) {
      const out = runCli(hypHome, ['plugin', 'doctor', token], cwd)
      assert.equal(out.status, 1, `expected exit 1, got ${out.status}: ${out.stderr}`)
      const joined = path.join(cwd, token)
      assert.ok(
        out.stdout.startsWith(`plugin doctor: ${joined}\n`),
        `expected the report header to name ${joined}, got: ${out.stdout}`
      )
      assert.ok(out.stdout.includes(`manifest not found at ${path.join(joined, 'hypaware.plugin.json')}`))
    }
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(cwd, { recursive: true, force: true })
  }
})
