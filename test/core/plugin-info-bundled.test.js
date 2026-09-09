// @ts-check

// `runPluginInfo` answered from the install lock alone, and a bundled plugin is
// never in the lock, so every bundled name got `is not installed` whatever its
// state: a healthy `@hypaware/ai-gateway` on a clean install said it, and so did
// the one `hyp plugin list` had just named as failed to activate (issue #1578).
//
// These drive the real CLI rather than the command function, because the defect
// is what an operator reads: the repro is two consecutive `hyp` invocations
// against one HYP_HOME, and only a spawn proves both come from the same boot.

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

/**
 * Run the packaged CLI against `hypHome`. The dev-telemetry and OTLP variables
 * are stripped so the run stands on a default install's footing, and `HYP_CONFIG`
 * with it so the only config that can reach the boot is the one the fixture
 * wrote under `hypHome`.
 *
 * @param {string} hypHome
 * @param {string[]} argv
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCli(hypHome, argv) {
  /** @type {Record<string, string|undefined>} */
  const env = { ...process.env, HYP_HOME: hypHome }
  delete env.HYP_CONFIG
  delete env.HYP_DEV_TELEMETRY
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete env.DEV_RUN_ID
  const out = spawnSync(process.execPath, [BIN, ...argv], { env, encoding: 'utf8' })
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
 * @param {{ lock?: Record<string, any>, config?: unknown }} [fixture]
 */
async function makeHome(prefix, fixture = {}) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const stateDir = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateDir, { recursive: true })
  if (fixture.lock) await writeLock(stateDir, { schema_version: 1, plugins: fixture.lock })
  if (fixture.config) {
    await fs.writeFile(
      path.join(hypHome, 'hypaware-config.json'),
      JSON.stringify(fixture.config, null, 2) + '\n'
    )
  }
  return hypHome
}

/**
 * A lock entry with every field `plugin info` prints, so the installed-plugin
 * block can be asserted whole rather than by fragments.
 *
 * @param {string} name
 * @param {string} version
 */
function lockEntry(name, version) {
  return {
    name,
    version,
    source: { kind: 'local-dir', raw: `/fixtures/${name}`, path: `/fixtures/${name}` },
    install_dir: `/fixtures/${name}`,
    content_hash: 'a'.repeat(64),
    manifest_hash: 'b'.repeat(64),
    installed_at: '2026-09-01T00:00:00.000Z',
  }
}

// The plain case, and the one that shows the reply was never about health: a
// clean install with no lock at all, and the flagship bundled plugin.
test('plugin info answers for a healthy bundled plugin on a clean install', async () => {
  const gateway = await bundledManifest('@hypaware/ai-gateway')
  const hypHome = await makeHome('hyp-plugin-info-clean-')
  try {
    const out = runCli(hypHome, ['plugin', 'info', '@hypaware/ai-gateway'])
    assert.equal(out.status, 0, `expected exit 0, got ${out.status}: ${out.stderr}`)
    assert.equal(out.stderr, '')
    assert.equal(
      out.stdout,
      `@hypaware/ai-gateway@${gateway.manifest.version}\n`
        + '  source:        bundled (ships with this package, so there is no install record)\n'
        + `  root_dir:      ${gateway.rootDir}\n`
    )
    // The directory named is the one the package ships, not a lock path that
    // was never written: a wrong `root_dir` is the failure this block invites.
    await fs.stat(path.join(gateway.rootDir, 'hypaware.plugin.json'))
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The repro in the issue, both halves in one HYP_HOME: `plugin list` names a
// bundled plugin this boot did not activate, and the obvious next command used
// to deny that the plugin existed. `@hypaware/vector-search` gets there without
// breaking anything: it is bundled, it requires `hypaware.embedder`, and no
// plugin in this config provides it, so the dep graph eliminates it and the
// name lands in `unavailablePlugins`.
test('plugin info answers for a bundled plugin the same boot did not activate', async () => {
  const vector = await bundledManifest('@hypaware/vector-search')
  const hypHome = await makeHome('hyp-plugin-info-failed-', {
    config: { version: 2, plugins: [{ name: '@hypaware/vector-search' }] },
  })
  try {
    const list = runCli(hypHome, ['plugin', 'list'])
    assert.equal(list.status, 0, `expected exit 0, got ${list.status}: ${list.stderr}`)
    assert.match(
      list.stdout,
      /^Plugins this boot did not activate:$/m,
      'fixture must produce a boot that came up short of @hypaware/vector-search'
    )
    assert.match(list.stdout, /^ {2}@hypaware\/vector-search@.+ {2}\(bundled\)$/m)

    const info = runCli(hypHome, ['plugin', 'info', '@hypaware/vector-search'])
    assert.equal(info.status, 0, `expected exit 0, got ${info.status}: ${info.stderr}`)
    assert.equal(
      info.stdout,
      `@hypaware/vector-search@${vector.manifest.version}\n`
        + '  source:        bundled (ships with this package, so there is no install record)\n'
        + `  root_dir:      ${vector.rootDir}\n`
    )
    // The two surfaces agree on the version of the copy in question, which is
    // the whole point of both reading the same bundled discovery.
    assert.match(list.stdout, new RegExp(`@hypaware/vector-search@${vector.manifest.version}\\b`))
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The command's existing job, byte for byte: a bundled fallback that changed
// this block would be a regression in the surface the command already served.
test('plugin info leaves the installed-plugin block unchanged', async () => {
  const hypHome = await makeHome('hyp-plugin-info-installed-', {
    lock: { '@third-party/echo': lockEntry('@third-party/echo', '0.2.0') },
  })
  try {
    const out = runCli(hypHome, ['plugin', 'info', '@third-party/echo'])
    assert.equal(out.status, 0, `expected exit 0, got ${out.status}: ${out.stderr}`)
    assert.equal(
      out.stdout,
      '@third-party/echo@0.2.0\n'
        + '  source:        local-dir (/fixtures/@third-party/echo)\n'
        + '  install_dir:   /fixtures/@third-party/echo\n'
        + `  content_hash:  ${'a'.repeat(64)}\n`
        + `  manifest_hash: ${'b'.repeat(64)}\n`
        + '  installed_at:  2026-09-01T00:00:00.000Z\n'
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// A lock entry under a bundled name is real, but it never runs: boot drops it
// from selection in favor of the bundled copy (LLP 0380). The install record on
// its own describes code the machine does not execute, and contradicts the
// `(shadowed by the bundled copy)` mark `plugin list` puts on the same entry.
// The line claims selection and not execution, which is what the manifest set
// settles: a boot can select the bundled copy and still fail to activate it.
test('plugin info says which copy boot selects when an install shadows a bundled name', async () => {
  const github = await bundledManifest('@hypaware/github')
  const hypHome = await makeHome('hyp-plugin-info-shadow-', {
    lock: { '@hypaware/github': lockEntry('@hypaware/github', '0.9.0') },
  })
  try {
    const info = runCli(hypHome, ['plugin', 'info', '@hypaware/github'])
    assert.equal(info.status, 0, `expected exit 0, got ${info.status}: ${info.stderr}`)
    // The install record is still there: it is what `hyp plugin remove` acts on.
    assert.match(info.stdout, /^@hypaware\/github@0\.9\.0$/m)
    assert.match(info.stdout, /^ {2}install_dir: {3}\/fixtures\/@hypaware\/github$/m)
    assert.equal(
      info.stdout.split('\n')[1],
      `  shadowed:      boot selects the bundled copy ${github.manifest.version} at ${github.rootDir};`
        + ' this install never runs (hyp plugin remove @hypaware/github)'
    )
    // The two surfaces reach the same verdict about the same lock entry.
    const list = runCli(hypHome, ['plugin', 'list'])
    assert.match(list.stdout, /^ {2}@hypaware\/github@0\.9\.0 {2}\(shadowed by the bundled copy; hyp plugin remove @hypaware\/github\)$/m)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// A name that really is neither. The reply has to stay true now that "not
// installed" is no longer the whole story, and it still has to fail: a script
// that branches on the exit code must not read "unknown plugin" as success.
test('plugin info still refuses a name that is neither installed nor bundled', async () => {
  const hypHome = await makeHome('hyp-plugin-info-unknown-', {
    lock: { '@third-party/echo': lockEntry('@third-party/echo', '0.2.0') },
  })
  try {
    const out = runCli(hypHome, ['plugin', 'info', '@nope/nothing'])
    assert.equal(out.status, 1)
    assert.equal(out.stdout, '')
    assert.equal(
      out.stderr,
      "hyp plugin info: no plugin named '@nope/nothing' is installed or bundled with this package\n"
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// `plugin info` has no machine form, and this fix did not give it one: the
// argument schema takes a single positional and refuses everything else, so a
// caller that assumed `--json` gets a usage error rather than a name lookup for
// the literal string `--json`.
test('plugin info has no --json form and says so', async () => {
  const hypHome = await makeHome('hyp-plugin-info-json-')
  try {
    const out = runCli(hypHome, ['plugin', 'info', '@hypaware/claude', '--json'])
    assert.equal(out.status, 2)
    assert.match(out.stderr, /--json/)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
