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
import { runPluginInfo } from '../../src/core/commands/plugin.js'
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

// A bundled name in `V1_EXCLUDED_FROM_DEFAULT` read as a positive record while
// `plugin list` named it under no heading at all: on a clean HYP_HOME it is
// neither active, installed, nor failed, so the surface `plugin info` points an
// operator at said nothing to contradict the record (issue #1599). Both
// directions in one test, because the positive half alone does not pin the
// fix: a line printed for every bundled plugin would pass it and would tell an
// operator the opposite of the truth about `@hypaware/ai-gateway`.
test('plugin info says a V1-excluded bundled plugin activates only when configured', async () => {
  const hypHome = await makeHome('hyp-plugin-info-excluded-')
  try {
    const list = runCli(hypHome, ['plugin', 'list'])
    assert.equal(list.status, 0, `expected exit 0, got ${list.status}: ${list.stderr}`)
    assert.doesNotMatch(
      list.stdout,
      /@hypaware\/central/,
      'fixture must be a boot where plugin list says nothing about the excluded name'
    )

    const excluded = runCli(hypHome, ['plugin', 'info', '@hypaware/central'])
    assert.equal(excluded.status, 0, `expected exit 0, got ${excluded.status}: ${excluded.stderr}`)
    assert.match(
      excluded.stdout,
      /^ {2}activation: {4}only when plugins\[\] names it; the default profiles never activate it$/m
    )

    // The allowlisted half, and the reason the line is conditional: this one
    // does activate by default, so carrying the same line would be false.
    const allowlisted = runCli(hypHome, ['plugin', 'info', '@hypaware/ai-gateway'])
    assert.equal(allowlisted.status, 0, `expected exit 0, got ${allowlisted.status}: ${allowlisted.stderr}`)
    assert.doesNotMatch(allowlisted.stdout, /activation:/)
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
        + '  activation:    only when plugins[] names it; the default profiles never activate it\n'
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

// Discovery that degraded, rather than a name that is genuinely unknown. The
// miss message used to assert what the package contains, and discovery cannot
// support that claim: it degrades to a short map (a workspace that will not
// enumerate throws and is caught, a plugin directory whose manifest will not
// load routes to `failed`), so a bundled name missing from the map is not
// evidence the package lacks it (issue #1600).
//
// These drive the command function rather than the CLI, because the CLI cannot
// reach the thrown half: `bootKernel` runs the same discovery first and dies on
// it. The `failed` half does reach a booted CLI, and both arrive here through
// the same seam, so one fixture shape covers both.

/**
 * A minimal `CommandRunContext`: the argv parse and the state-dir resolution
 * are all `runPluginInfo` reads before it answers.
 *
 * @param {string} hypHome
 */
function makeInfoCtx(hypHome) {
  return /** @type {any} */ ({
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    stdout: makeStreamBuf(),
    stderr: makeStreamBuf(),
  })
}

function makeStreamBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/**
 * Drop every permission bit on `dir` and report whether that actually made it
 * unreadable. Running as root defeats the mode bits, and a filesystem may too,
 * so the caller skips rather than asserting something the machine cannot stage.
 *
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function makeUnreadable(dir) {
  await fs.chmod(dir, 0o000)
  try {
    await fs.readdir(dir)
    return false
  } catch {
    return true
  }
}

/**
 * A manifest `validateManifest` accepts, under whatever name the caller wants.
 *
 * @param {string} dir
 * @param {string} name
 */
function writeManifest(dir, name) {
  return fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '9.9.9',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
    })
  )
}

/**
 * Stage a bundled workspace holding one loadable plugin and one directory the
 * caller is about to make unreadable, then run `fn` against it. Restores the
 * mode before removing the tree so a failed assertion cannot leave an
 * undeletable directory behind for the next run.
 *
 * `badDir` is staged with no manifest at all, which is a state in its own right:
 * `src/core/manifest.js` routes the missing file to the same `manifest_invalid`
 * failure a corrupt one gets, so a caller that never chmods still reaches the
 * `failed` bucket, and reaches it as root (issue #1842).
 *
 * @param {(dirs: { workspaceDir: string, badDir: string, unknownDir: string, hypHome: string }) => Promise<void>} fn
 * @param {{ unknownName?: string }} [opts] With `unknownName`, stage a third
 *   directory whose valid manifest declares that name. A name in neither the
 *   allowlist nor the exclude set routes to `unknown`, which is the state
 *   `plugin info` used to flatly deny (issue #1843).
 */
async function withStagedWorkspace(fn, opts = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-plugin-info-unread-'))
  const workspaceDir = path.join(root, 'plugins-workspace')
  const goodDir = path.join(workspaceDir, 'ai-gateway')
  const badDir = path.join(workspaceDir, 'claude')
  const unknownDir = path.join(workspaceDir, 'mystery')
  const hypHome = path.join(root, 'home')
  await fs.mkdir(goodDir, { recursive: true })
  await fs.mkdir(badDir, { recursive: true })
  await writeManifest(goodDir, '@hypaware/ai-gateway')
  if (opts.unknownName) {
    await fs.mkdir(unknownDir, { recursive: true })
    await writeManifest(unknownDir, opts.unknownName)
  }
  try {
    await fn({ workspaceDir, badDir, unknownDir, hypHome })
  } finally {
    await fs.chmod(workspaceDir, 0o755).catch(() => {})
    await fs.chmod(badDir, 0o755).catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  }
}

// The reachable half. The workspace enumerates, so boot survives and the
// command runs; one bundled plugin's directory does not, so its name is in no
// map and the old wording denied the package ships it.
test('plugin info does not deny a bundled name when a plugin directory would not load', async (t) => {
  await withStagedWorkspace(async ({ workspaceDir, badDir, hypHome }) => {
    if (!await makeUnreadable(badDir)) {
      t.skip('cannot stage an unreadable directory here (running as root?)')
      return
    }
    const ctx = makeInfoCtx(hypHome)
    assert.equal(await runPluginInfo(['@hypaware/claude'], ctx, { workspaceDir }), 1)
    assert.equal(ctx.stdout.text(), '')
    const lines = ctx.stderr.text().split('\n')
    assert.equal(
      lines[0],
      "hyp plugin info: no plugin named '@hypaware/claude' is installed, and the plugins bundled"
        + ' with this package could not all be read, so whether this package ships one is unknown'
    )
    // The operator gets the directory to go and look at, not just a hedge.
    assert.equal(lines[1], `  the bundled plugin directory ${badDir} did not yield a usable manifest`)
    // The claim the fix exists to remove.
    assert.equal(ctx.stderr.text().includes('or bundled with this package'), false)

    // Discovery was partial, not dead: the sibling that did load still answers,
    // so the hedge above is driven by the degrade and not applied blanket.
    const okCtx = makeInfoCtx(hypHome)
    assert.equal(await runPluginInfo(['@hypaware/ai-gateway'], okCtx, { workspaceDir }), 0)
    assert.match(okCtx.stdout.text(), /^@hypaware\/ai-gateway@9\.9\.9$/m)
  })
})

// The half the CLI cannot reach on its own, kept because it is the one the
// acceptance condition names: the workspace directory itself is unreadable, so
// discovery throws and the caught degrade is total.
test('plugin info does not deny a bundled name when the workspace will not enumerate', async (t) => {
  await withStagedWorkspace(async ({ workspaceDir, hypHome }) => {
    if (!await makeUnreadable(workspaceDir)) {
      t.skip('cannot stage an unreadable directory here (running as root?)')
      return
    }
    const ctx = makeInfoCtx(hypHome)
    assert.equal(await runPluginInfo(['@hypaware/claude'], ctx, { workspaceDir }), 1)
    const lines = ctx.stderr.text().split('\n')
    assert.match(lines[0], /^hyp plugin info: no plugin named '@hypaware\/claude' is installed, and the plugins bundled with this package could not all be read/)
    assert.match(lines[1], /^ {2}the bundled plugins directory could not be read: .*EACCES/)
    assert.equal(ctx.stderr.text().includes('or bundled with this package'), false)
  })
})

// The hedge is not the new default: a workspace this process can read in full
// still gets the flat claim, which is true there and is what the existing
// CLI-level unknown-name test asserts against the shipped workspace.
test('plugin info keeps the flat miss message when discovery saw the whole workspace', async () => {
  await withStagedWorkspace(async ({ workspaceDir, badDir, hypHome }) => {
    // Give the second directory a manifest too, so nothing is in `failed`.
    await writeManifest(badDir, '@hypaware/claude')
    const ctx = makeInfoCtx(hypHome)
    assert.equal(await runPluginInfo(['@nope/nothing'], ctx, { workspaceDir }), 1)
    assert.equal(
      ctx.stderr.text(),
      "hyp plugin info: no plugin named '@nope/nothing' is installed or bundled with this package\n"
    )
  })
})

// A directory that holds nothing reaches `failed` exactly like one holding a
// corrupt manifest, because `src/core/manifest.js` maps the missing file to
// `manifest_invalid` too. The old reason line asserted the directory holds a
// manifest, which is false for this half, and no chmod is involved so this runs
// as root (issue #1842).
test('plugin info reason line does not claim a manifest in a directory that holds none', async () => {
  await withStagedWorkspace(async ({ workspaceDir, badDir, hypHome }) => {
    const ctx = makeInfoCtx(hypHome)
    assert.equal(await runPluginInfo(['@hypaware/claude'], ctx, { workspaceDir }), 1)
    const lines = ctx.stderr.text().split('\n')
    assert.equal(
      lines[0],
      "hyp plugin info: no plugin named '@hypaware/claude' is installed, and the plugins bundled"
        + ' with this package could not all be read, so whether this package ships one is unknown'
    )
    assert.equal(lines[1], `  the bundled plugin directory ${badDir} did not yield a usable manifest`)
    // The claim the fix exists to remove: nothing is in that directory.
    assert.equal(ctx.stderr.text().includes('holds a manifest'), false)
    assert.equal(ctx.stderr.text().includes('or bundled with this package'), false)
  })
})

// The third route short of the package, and the one the flat denial survived
// on: a valid manifest under a name in neither the allowlist nor the exclude
// set. No permissions involved, so the staged workspace runs anywhere (issue
// #1843).
test('plugin info does not deny a name whose bundled manifest this build does not recognize', async () => {
  await withStagedWorkspace(async ({ workspaceDir, badDir, unknownDir, hypHome }) => {
    // Nothing in `failed`, so the answer below cannot be coming from the hedge.
    await writeManifest(badDir, '@hypaware/claude')
    const ctx = makeInfoCtx(hypHome)
    assert.equal(await runPluginInfo(['@hypaware/mystery'], ctx, { workspaceDir }), 1)
    assert.equal(ctx.stdout.text(), '')
    const lines = ctx.stderr.text().split('\n')
    assert.equal(
      lines[0],
      "hyp plugin info: no plugin named '@hypaware/mystery' is installed, and the manifest this"
        + ' package bundles under that name is one this build does not recognize'
    )
    // The operator gets the directory to go and look at, and why it is inert.
    assert.equal(
      lines[1],
      `  the bundled plugin directory ${unknownDir} declares '@hypaware/mystery', a name in`
        + " neither this build's bundled plugin allowlist nor its excluded set, so nothing activates it"
    )
    // The claim the fix exists to remove.
    assert.equal(ctx.stderr.text().includes('or bundled with this package'), false)
    // And it is this name that is answered, not every name: a name the whole
    // workspace really lacks still gets the flat claim, which is true there.
    const missCtx = makeInfoCtx(hypHome)
    assert.equal(await runPluginInfo(['@nope/nothing'], missCtx, { workspaceDir }), 1)
    assert.equal(
      missCtx.stderr.text(),
      "hyp plugin info: no plugin named '@nope/nothing' is installed or bundled with this package\n"
    )
  }, { unknownName: '@hypaware/mystery' })
})

// The two shortfalls can hold at once, and then only one of them answers the
// name asked after. A manifest that parsed under an unrecognized name is known
// exactly, so it is said back even while some other directory sits in `failed`;
// reverse the order and the operator gets the hedge about a name discovery
// could have named. Nothing else pins that precedence: the sibling test above
// clears `failed` on purpose to prove the message's source (issue #1843).
test('plugin info answers the unrecognized name even when another directory is unread', async () => {
  await withStagedWorkspace(async ({ workspaceDir, badDir, unknownDir, hypHome }) => {
    // `badDir` keeps its staged state: no manifest, so it is in `failed` and
    // `unread` is set for the whole run below.
    const ctx = makeInfoCtx(hypHome)
    assert.equal(await runPluginInfo(['@hypaware/mystery'], ctx, { workspaceDir }), 1)
    const lines = ctx.stderr.text().split('\n')
    assert.equal(
      lines[0],
      "hyp plugin info: no plugin named '@hypaware/mystery' is installed, and the manifest this"
        + ' package bundles under that name is one this build does not recognize'
    )
    assert.equal(
      lines[1],
      `  the bundled plugin directory ${unknownDir} declares '@hypaware/mystery', a name in`
        + " neither this build's bundled plugin allowlist nor its excluded set, so nothing activates it"
    )
    // The hedge is available and still loses: it cannot name this plugin.
    assert.equal(ctx.stderr.text().includes('could not all be read'), false)

    // And it is the hedge that answers the name only the unread directory
    // could have held, which is the half that keeps both routes honest.
    const hedged = makeInfoCtx(hypHome)
    assert.equal(await runPluginInfo(['@hypaware/claude'], hedged, { workspaceDir }), 1)
    const hedgedLines = hedged.stderr.text().split('\n')
    assert.equal(
      hedgedLines[0],
      "hyp plugin info: no plugin named '@hypaware/claude' is installed, and the plugins bundled"
        + ' with this package could not all be read, so whether this package ships one is unknown'
    )
    assert.equal(hedgedLines[1], `  the bundled plugin directory ${badDir} did not yield a usable manifest`)
  }, { unknownName: '@hypaware/mystery' })
})
