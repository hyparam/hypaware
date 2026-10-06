// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { bootKernel } from '../../src/core/runtime/boot.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { resolveDependencies } from '../../src/core/dep_graph.js'
import { discoverInstalledPlugins } from '../../src/core/runtime/installed.js'
import {
  firstPartyPluginMetadata,
  mergeInstalledManifestsIntoKnown,
  validateConfig,
} from '../../src/core/config/validate.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'
import { removePlugin } from '../../src/core/plugin_install/install.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'

/**
 * @import { PluginManifest } from '../../hypaware-plugin-kernel-types.js'
 */

/**
 * Materialise an installed-plugin fixture under `<hypHome>/hypaware/plugins`
 * and register it in `plugin-lock.json`. Mirrors what `hyp plugin install`
 * lands on disk but skips the actual install pipeline so tests stay fast.
 *
 * @param {object} args
 * @param {string} args.hypHome
 * @param {string} args.name
 * @param {string} args.version
 * @param {object} [args.manifestExtras]
 * @param {string} [args.entrypointBody]
 * @returns {Promise<{ installDir: string }>}
 */
async function stageInstalledPlugin({
  hypHome,
  name,
  version,
  manifestExtras = {},
  entrypointBody,
}) {
  const stateDir = path.join(hypHome, 'hypaware')
  const installDir = path.join(stateDir, 'plugins', name)
  await fs.mkdir(installDir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name,
    version,
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    ...manifestExtras,
  }
  await fs.writeFile(
    path.join(installDir, 'hypaware.plugin.json'),
    JSON.stringify(manifest, null, 2)
  )
  await fs.writeFile(
    path.join(installDir, 'index.js'),
    entrypointBody ??
      `// ${name} fixture\nexport async function activate(ctx) {\n  ctx.commands.register({\n    name: ${JSON.stringify(name.replace(/^@hypaware\//, '').replace(/[^a-z0-9]/gi, '-'))},\n    plugin: ${JSON.stringify(name)},\n    summary: 'fixture command',\n    usage: 'fixture',\n    async run() { return 0 },\n  })\n}\n`
  )
  return { installDir }
}

/**
 * @param {string} hypHome
 * @param {Array<{ name: string, version: string, installDir: string }>} entries
 */
async function writeFixtureLock(hypHome, entries) {
  const stateDir = path.join(hypHome, 'hypaware')
  /** @type {Record<string, any>} */
  const plugins = {}
  for (const e of entries) {
    plugins[e.name] = {
      name: e.name,
      version: e.version,
      source: { kind: 'local-dir', raw: e.installDir, path: e.installDir },
      install_dir: e.installDir,
      content_hash: 'a'.repeat(64),
      manifest_hash: 'b'.repeat(64),
      installed_at: '2026-05-21T00:00:00.000Z',
    }
  }
  await writeLock(stateDir, { schema_version: 1, plugins })
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function dirExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

function bufferWriter() {
  let out = ''
  return {
    write(chunk) {
      out += String(chunk)
    },
    text() {
      return out
    },
  }
}

test('discoverInstalledPlugins returns loaded manifests from the lock', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-installed-disc-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@hypaware/third-fixture',
      version: '0.1.0',
    })
    await writeFixtureLock(hypHome, [
      { name: '@hypaware/third-fixture', version: '0.1.0', installDir },
    ])
    const result = await discoverInstalledPlugins({ stateDir: path.join(hypHome, 'hypaware') })
    assert.equal(result.loaded.length, 1)
    assert.equal(result.loaded[0].manifest.name, '@hypaware/third-fixture')
    assert.equal(result.failed.length, 0)
    assert.equal(result.lockEntries.length, 1)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('discoverInstalledPlugins flags manifest/lock name mismatch as failed', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-installed-mismatch-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@hypaware/declared',
      version: '0.1.0',
    })
    // Lock claims a different name than what the manifest actually says.
    await writeFixtureLock(hypHome, [
      { name: '@hypaware/imposter', version: '0.1.0', installDir },
    ])
    const result = await discoverInstalledPlugins({ stateDir: path.join(hypHome, 'hypaware') })
    assert.equal(result.loaded.length, 0)
    assert.equal(result.failed.length, 1)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('bootKernel merges bundled and installed manifest pools', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-installed-merge-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/echo',
      version: '0.1.0',
    })
    await writeFixtureLock(hypHome, [
      { name: '@third-party/echo', version: '0.1.0', installDir },
    ])

    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        plugins: [{ name: '@third-party/echo' }],
      })
    )

    const boot = await bootKernel({
      hypHome,
      configPath,
      mode: 'smoke',
      runId: 'test-merge',
      env: { ...process.env, HYP_HOME: hypHome },
      // Empty bundled workspace keeps the pool predictable.
      workspaceDir: path.join(hypHome, 'no-bundled'),
    })

    assert.equal(boot.activePlugins.length, 1)
    assert.equal(boot.activePlugins[0].name, '@third-party/echo')
    assert.equal(boot.skipped.length, 0)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('bootKernel does not activate installed plugins under all-bundled', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-installed-allbundled-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/echo',
      version: '0.1.0',
    })
    await writeFixtureLock(hypHome, [
      { name: '@third-party/echo', version: '0.1.0', installDir },
    ])

    const boot = await bootKernel({
      hypHome,
      mode: 'init',
      runId: 'test-allbundled',
      bootProfile: 'all-bundled',
      env: { ...process.env, HYP_HOME: hypHome },
      workspaceDir: path.join(hypHome, 'no-bundled'),
    })

    assert.equal(boot.activePlugins.find((p) => p.name === '@third-party/echo'), undefined)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// @ref LLP 0380#bundled-copy-wins [tests]: the bundled copy activates, the installed shadow never does, and boot does not reject
test('bootKernel activates the bundled copy when an installed plugin shadows a bundled first-party name', async () => {
  // Use a tiny synthetic "bundled" workspace so we control collision
  // surface without depending on the real V1 set. Boot used to reject here;
  // the reject stopped every command (dispatch boots first, `hyp plugin
  // remove` included) and respawned the supervised daemon into the same
  // throw forever, so the bundled copy now wins and the shadow is reported.
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-installed-shadow-'))
  try {
    const workspaceDir = path.join(hypHome, 'bundled-workspace')
    const bundledDir = path.join(workspaceDir, 'ai-gateway')
    await fs.mkdir(bundledDir, { recursive: true })
    await fs.writeFile(
      path.join(bundledDir, 'hypaware.plugin.json'),
      JSON.stringify({
        schema_version: 1,
        name: '@hypaware/ai-gateway',
        version: '0.0.1',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
      })
    )
    await fs.writeFile(
      path.join(bundledDir, 'index.js'),
      'export async function activate() {}\n'
    )

    // Install a shadowing copy of @hypaware/ai-gateway whose code must never run.
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@hypaware/ai-gateway',
      version: '0.2.0',
      entrypointBody: 'export async function activate() { throw new Error("the installed shadow must never activate") }\n',
    })
    await writeFixtureLock(hypHome, [
      { name: '@hypaware/ai-gateway', version: '0.2.0', installDir },
    ])

    // `all-bundled` is the profile that used to be fooled twice over: the
    // name was "installed", so the bundled plugin was dropped from the
    // default surface as well.
    const boot = await bootKernel({
      hypHome,
      mode: 'smoke',
      runId: 'test-shadow',
      bootProfile: 'all-bundled',
      workspaceDir,
      env: { ...process.env, HYP_HOME: hypHome },
    })
    const gateway = boot.activePlugins.find((p) => p.name === '@hypaware/ai-gateway')
    assert.ok(gateway, 'the bundled plugin activates')
    assert.equal(gateway.rootDir, bundledDir)
    assert.equal(gateway.version, '0.0.1')
    assert.equal(boot.activePlugins.filter((p) => p.name === '@hypaware/ai-gateway').length, 1)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// @ref LLP 0380#bundled-copy-wins [tests]: an excluded bundled name is a bundled name; the installed copy never activates under any profile
test('bootKernel activates the bundled copy when an installed plugin shadows a V1-excluded bundled plugin', async () => {
  // Regression: the shadow rule compared installed names only against the
  // allowlisted bundled bucket, so an installed copy of a bundled plugin in
  // `V1_EXCLUDED_FROM_DEFAULT` (`@hypaware/github`, `@hypaware/claude-desktop`)
  // replaced the bundled code silently. A pre-bundling install of the GitHub
  // source then kept running months-old code across every release that fixed
  // the bundled copy, with nothing on any surface saying so. An excluded
  // bundled name is a bundled name: the bundled copy is what activates when
  // the config names it, and the installed copy activates under no profile,
  // `all-available` included (it used to select every installed name).
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-installed-excluded-shadow-'))
  try {
    const workspaceDir = path.join(hypHome, 'bundled-workspace')
    const bundledDir = path.join(workspaceDir, 'github')
    await fs.mkdir(bundledDir, { recursive: true })
    await fs.writeFile(
      path.join(bundledDir, 'hypaware.plugin.json'),
      JSON.stringify({
        schema_version: 1,
        name: '@hypaware/github',
        version: '0.0.1',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
      })
    )
    await fs.writeFile(path.join(bundledDir, 'index.js'), 'export async function activate() {}\n')

    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@hypaware/github',
      version: '1.0.0',
      entrypointBody: 'export async function activate() { throw new Error("the installed shadow must never activate") }\n',
    })
    await writeFixtureLock(hypHome, [
      { name: '@hypaware/github', version: '1.0.0', installDir },
    ])
    // Named in config, the way an operator who installed it pre-bundling has it.
    await fs.writeFile(
      defaultConfigPath(hypHome),
      JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/github' }] })
    )

    // `config`: the config names the excluded plugin, so the bundled copy is
    // the explicit opt-in that activates, from the bundled root.
    const configBoot = await bootKernel({
      hypHome,
      mode: 'smoke',
      runId: 'test-excluded-shadow-config',
      bootProfile: 'config',
      workspaceDir,
      env: { ...process.env, HYP_HOME: hypHome },
    })
    const github = configBoot.activePlugins.find((p) => p.name === '@hypaware/github')
    assert.ok(github, 'the bundled excluded plugin activates when the config names it')
    assert.equal(github.rootDir, bundledDir)
    assert.equal(github.version, '0.0.1')

    // `all-available`: an excluded plugin stays out of the default surface,
    // and the installed shadow must not smuggle it back in as "installed".
    const allAvailable = await bootKernel({
      hypHome,
      mode: 'smoke',
      runId: 'test-excluded-shadow-all-available',
      bootProfile: 'all-available',
      workspaceDir,
      env: { ...process.env, HYP_HOME: hypHome },
    })
    assert.equal(allAvailable.activePlugins.find((p) => p.name === '@hypaware/github'), undefined)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('dispatch routes hyp init <installed-preset> even when preset args include --yes', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-init-installed-preset-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/init-fixture',
      version: '0.1.0',
      entrypointBody:
        "export async function activate(ctx) {\n" +
        "  ctx.initPresets.register({ name: 'fixture', plugin: '@third-party/init-fixture', summary: 'fixture preset', async run(argv, runCtx) { runCtx.stdout.write(`preset:${argv.join(',')}\\n`); return 0 } })\n" +
        "}\n",
    })
    await writeFixtureLock(hypHome, [
      { name: '@third-party/init-fixture', version: '0.1.0', installDir },
    ])
    const stdout = bufferWriter()
    const stderr = bufferWriter()

    const exitCode = await dispatch(['init', 'fixture', 'target', '--yes'], {
      env: { ...process.env, HYP_HOME: hypHome },
      stdout,
      stderr,
      cwd: hypHome,
      workspaceDir: path.join(hypHome, 'no-bundled'),
    })

    assert.equal(exitCode, 0)
    assert.equal(stdout.text(), 'preset:target,--yes\n')
    assert.equal(stderr.text(), '')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('resolveDependencies works over a merged bundled+installed manifest pool', async () => {
  /** @type {PluginManifest[]} */
  const manifests = [
    {
      schema_version: 1,
      name: '@hypaware/bundled-host',
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      provides: { capabilities: { 'fixture.host': '1.0.0' } },
    },
    {
      schema_version: 1,
      name: '@third-party/needs-host',
      version: '0.1.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      requires: { capabilities: { 'fixture.host': '^1.0.0' } },
    },
  ]

  const resolution = await resolveDependencies(manifests)
  assert.deepEqual(resolution.unsatisfied, [])
  assert.deepEqual(resolution.order, ['@hypaware/bundled-host', '@third-party/needs-host'])
})

test('mergeInstalledManifestsIntoKnown propagates capability provides/requires', () => {
  const known = mergeInstalledManifestsIntoKnown([
    {
      ok: true,
      manifest: /** @type {any} */ ({
        schema_version: 1,
        name: '@third-party/cap-provider',
        version: '0.1.0',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
        provides: { capabilities: { 'fixture.cap': '1.0.0' } },
        requires: { capabilities: { 'hypaware.ai-gateway': '^1.0.0' } },
      }),
      manifestPath: '/tmp/fixture/hypaware.plugin.json',
      rootDir: '/tmp/fixture',
    },
  ])

  assert.equal(known.has('@third-party/cap-provider'), true)
  const meta = /** @type {{provides?: Record<string,string>, requires?: Record<string,string>}} */ (
    known.get('@third-party/cap-provider')
  )
  assert.equal(meta?.provides?.['fixture.cap'], '1.0.0')
  assert.equal(meta?.requires?.['hypaware.ai-gateway'], '^1.0.0')
})

test('mergeInstalledManifestsIntoKnown does not override first-party metadata', () => {
  const first = firstPartyPluginMetadata()
  const originalProvides = /** @type {{provides?: Record<string,string>}} */ (
    first.get(/** @type {any} */ ('@hypaware/local-fs'))
  )?.provides
  const merged = mergeInstalledManifestsIntoKnown([
    {
      ok: true,
      manifest: /** @type {any} */ ({
        schema_version: 1,
        name: '@hypaware/local-fs',
        version: '99.0.0',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
        provides: { capabilities: { 'evil.capability': '1.0.0' } },
      }),
      manifestPath: '/tmp/imposter/hypaware.plugin.json',
      rootDir: '/tmp/imposter',
    },
  ])
  const after = /** @type {{provides?: Record<string,string>}} */ (
    merged.get(/** @type {any} */ ('@hypaware/local-fs'))
  )?.provides
  assert.deepEqual(after, originalProvides)
})

test('the all-available boot (hyp init profile) registers bundled backfill providers including codex', async () => {
  // `hyp init` boots with bootProfile=all-available, which activates the
  // real bundled plugin surface. The picker finale's onboarding backfill
  // step reads ctx.backfills.list(); codex must appear there so a codex
  // pick actually imports local history during onboarding (bead 4 provider
  // + bead 5 onboarding integration). This is the real-wiring counterpart
  // to the mocked runner tests in walkthrough-backfill.test.js.
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-backfill-providers-'))
  let boot
  try {
    boot = await bootKernel({
      hypHome,
      mode: 'init',
      runId: 'test-backfill-providers',
      bootProfile: 'all-available',
      // Real bundled workspace (no workspaceDir override) so the actual
      // @hypaware/codex and @hypaware/claude plugins activate.
      env: { ...process.env, HOME: hypHome, HYP_HOME: hypHome },
    })
    const providerNames = boot.runtime.backfills.list().map((p) => p.name).sort()
    assert.ok(
      providerNames.includes('codex'),
      `expected a codex backfill provider, got: ${providerNames.join(', ') || '(none)'}`
    )
    assert.ok(
      providerNames.includes('claude'),
      `expected a claude backfill provider, got: ${providerNames.join(', ') || '(none)'}`
    )
  } finally {
    // Activation only registers contributions, but stop defensively in
    // case a bundled plugin started anything, then remove the temp home.
    await boot?.runtime?.sources?.stopAll?.()
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('validateConfig does not flag installed plugin names as plugin_unknown', async () => {
  const knownPlugins = mergeInstalledManifestsIntoKnown([
    {
      ok: true,
      manifest: /** @type {any} */ ({
        schema_version: 1,
        name: '@third-party/installed',
        version: '0.1.0',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
      }),
      manifestPath: '/tmp/installed/hypaware.plugin.json',
      rootDir: '/tmp/installed',
    },
  ])

  const result = await validateConfig(
    {
      version: 2,
      plugins: [{ name: /** @type {any} */ ('@third-party/installed') }],
    },
    { knownPlugins }
  )

  const unknownErrors = result.errors.filter((e) => e.errorKind === 'plugin_unknown')
  assert.equal(unknownErrors.length, 0)
})

// Issue #1958. `plugin-lock.json` is hand-editable and `readLock` validates
// only the container, so an entry with no `install_dir` reached `path.join`
// inside `loadManifest` and took down every kernel-booting command - `hyp
// status` and `hyp plugin list` included - on "The \"path\" argument must be
// of type string. Received undefined", which named neither the lock file nor
// the entry. The module already promised the opposite posture for a manifest
// that will not load ("per-entry manifest failures are surfaced via
// failed[]"); the entry-shape case simply never got it.

/**
 * Write a lock containing one well-formed entry and one raw entry exactly as
 * given, so a test can stage a hand-edited shape `writeFixtureLock` cannot.
 *
 * @param {string} hypHome
 * @param {{ name: string, version: string, installDir: string }} good
 * @param {string} brokenName
 * @param {unknown} brokenEntry
 */
async function writeHandEditedLock(hypHome, good, brokenName, brokenEntry) {
  const stateDir = path.join(hypHome, 'hypaware')
  await writeFixtureLock(hypHome, [good])
  const lockPath = path.join(stateDir, 'plugin-lock.json')
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'))
  lock.plugins[brokenName] = brokenEntry
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2))
  return lockPath
}

test('a lock entry with no install_dir degrades to malformed[] and the well-formed entries still load', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-lock-entry-invalid-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/healthy',
      version: '0.1.0',
    })
    // The reported shape: every other field present, `install_dir` deleted.
    await writeHandEditedLock(
      hypHome,
      { name: '@third-party/healthy', version: '0.1.0', installDir },
      '@third-party/broken',
      {
        name: '@third-party/broken',
        version: '1.0.0',
        source: { kind: 'local-dir', raw: '/nowhere', path: '/nowhere' },
        content_hash: 'c'.repeat(64),
        manifest_hash: 'd'.repeat(64),
        installed_at: '2026-05-21T00:00:00.000Z',
      }
    )

    const result = await discoverInstalledPlugins({ stateDir: path.join(hypHome, 'hypaware') })
    assert.deepEqual(result.malformed, ['@third-party/broken'])
    // The neighbour is untouched, which is the whole point of degrading.
    assert.equal(result.loaded.length, 1)
    assert.equal(result.loaded[0].manifest.name, '@third-party/healthy')
    assert.equal(result.failed.length, 0)
    // Not in `lockEntries`: every consumer of that list dereferences a
    // well-formed entry, and `failed[]` cannot hold it either - a
    // `FailedManifest` is a directory plus a reason and this has no directory.
    assert.deepEqual(result.lockEntries.map((e) => e.name), ['@third-party/healthy'])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a lock entry that is not an object degrades the same way', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-lock-entry-null-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/healthy',
      version: '0.1.0',
    })
    await writeHandEditedLock(
      hypHome,
      { name: '@third-party/healthy', version: '0.1.0', installDir },
      '@third-party/nulled',
      null
    )

    const result = await discoverInstalledPlugins({ stateDir: path.join(hypHome, 'hypaware') })
    // Named by the lock key, the only identity this entry still has.
    assert.deepEqual(result.malformed, ['@third-party/nulled'])
    assert.equal(result.loaded.length, 1)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('hyp status names the bad lock entry and hyp plugin list still lists the others', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-lock-entry-status-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/healthy',
      version: '0.1.0',
    })
    const lockPath = await writeHandEditedLock(
      hypHome,
      { name: '@third-party/healthy', version: '0.1.0', installDir },
      '@third-party/broken',
      {
        name: '@third-party/broken',
        version: '1.0.0',
        source: { kind: 'local-dir', raw: '/nowhere', path: '/nowhere' },
        content_hash: 'c'.repeat(64),
        manifest_hash: 'd'.repeat(64),
        installed_at: '2026-05-21T00:00:00.000Z',
      }
    )
    const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }

    const report = await collectHypAwareStatus({ env })
    const diag = report.diagnostics.find((d) => d.kind === 'plugin_lock_entry_invalid')
    assert.ok(diag, 'the bad lock entry is reported')
    assert.equal(diag.severity, 'error')
    // Names the entry AND the file, the two things the TypeError did not.
    assert.equal(
      diag.message,
      `plugin-lock.json entry '@third-party/broken' has no usable install_dir,`
        + ` so nothing it installed is running: ${lockPath}`
    )
    // The repair runs: `removePlugin` falls back to the conventional install
    // directory when the entry carries none, so it clears the lock row.
    assert.deepEqual(diag.repair, ['hyp plugin remove @third-party/broken'])

    // The commands that used to exit 1 on a bare TypeError.
    const stdout = bufferWriter()
    const stderr = bufferWriter()
    const exitCode = await dispatch(['plugin', 'list'], {
      env,
      stdout,
      stderr,
      cwd: hypHome,
      workspaceDir: path.join(hypHome, 'no-bundled'),
    })
    assert.equal(exitCode, 0)
    assert.match(stdout.text(), /@third-party\/healthy@0\.1\.0/)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a well-formed lock is unchanged: nothing malformed, no new diagnostic', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-lock-entry-healthy-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/healthy',
      version: '0.1.0',
    })
    await writeFixtureLock(hypHome, [
      { name: '@third-party/healthy', version: '0.1.0', installDir },
    ])
    const stateDir = path.join(hypHome, 'hypaware')

    const result = await discoverInstalledPlugins({ stateDir })
    assert.deepEqual(result.malformed, [])
    assert.equal(result.failed.length, 0)
    assert.deepEqual(result.loaded.map((m) => m.manifest.name), ['@third-party/healthy'])
    assert.deepEqual(result.lockEntries.map((e) => e.name), ['@third-party/healthy'])
    assert.deepEqual(result.lockEntries.map((e) => e.install_dir), [installDir])

    const report = await collectHypAwareStatus({ env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' } })
    assert.equal(report.diagnostics.some((d) => d.kind === 'plugin_lock_entry_invalid'), false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a malformed lock entry reaches unavailablePlugins, so the client-asset prune stands down', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-lock-entry-unavailable-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/healthy',
      version: '0.1.0',
    })
    await writeHandEditedLock(
      hypHome,
      { name: '@third-party/healthy', version: '0.1.0', installDir },
      '@third-party/broken',
      {
        name: '@third-party/broken',
        version: '1.0.0',
        source: { kind: 'local-dir', raw: '/nowhere', path: '/nowhere' },
        content_hash: 'c'.repeat(64),
        manifest_hash: 'd'.repeat(64),
        installed_at: '2026-05-21T00:00:00.000Z',
      }
    )
    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(
      configPath,
      JSON.stringify({ version: 2, plugins: [{ name: '@third-party/healthy' }] }, null, 2)
    )

    const boot = await bootKernel({
      hypHome,
      configPath,
      mode: 'smoke',
      runId: 'test-lock-entry-unavailable',
      env: { ...process.env, HYP_HOME: hypHome },
      workspaceDir: path.join(hypHome, 'no-bundled'),
    })
    // A boot that came up short of its plugin set says so in the one list the
    // delete path reads (LLP 0219 #incomplete-activation-prunes-nothing). An
    // entry whose `install_dir` points at a missing directory already did;
    // one carrying no `install_dir` at all leaves the same hole.
    assert.ok(
      boot.unavailablePlugins.includes('@third-party/broken'),
      `expected the malformed lock key in unavailablePlugins, got ${JSON.stringify(boot.unavailablePlugins)}`
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('hyp plugin remove clears a lock row that is not an object, so the diagnostic repair runs', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-lock-entry-remove-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/healthy',
      version: '0.1.0',
    })
    const lockPath = await writeHandEditedLock(
      hypHome,
      { name: '@third-party/healthy', version: '0.1.0', installDir },
      '@third-party/nulled',
      null
    )
    const stateDir = path.join(hypHome, 'hypaware')

    // The lock has a row for this name, so the repair `hyp status` prints for
    // it must be able to act on it - it used to answer "plugin not installed"
    // and leave an error-severity diagnostic no operator could clear.
    const result = await removePlugin({
      name: /** @type {any} */ ('@third-party/nulled'),
      stateDir,
    })
    assert.equal(result.ok, true)
    const after = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    assert.deepEqual(Object.keys(after.plugins), ['@third-party/healthy'])

    const report = await collectHypAwareStatus({
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    })
    assert.equal(report.diagnostics.some((d) => d.kind === 'plugin_lock_entry_invalid'), false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// A lock key is a map key, not a validated plugin name, and `hyp status`
// prints `hyp plugin remove <key>` as the repair for a malformed row, so a
// key containing `..` turned the printed repair into a recursive delete
// outside `<stateDir>/plugins` (issue #1967). Everything these tests can
// delete is staged inside their own temp HYP_HOME.
test('hyp plugin remove leaves a directory outside the plugins root alone and still clears the row', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-lock-entry-traversal-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/healthy',
      version: '0.1.0',
    })
    const lockPath = await writeHandEditedLock(
      hypHome,
      { name: '@third-party/healthy', version: '0.1.0', installDir },
      '../../victim',
      {}
    )
    const stateDir = path.join(hypHome, 'hypaware')
    const victimDir = path.join(hypHome, 'victim')
    // The traversal lands on the victim, and the victim is inside this test's
    // own temp root: proven before the name reaches a recursive delete.
    assert.equal(path.resolve(stateDir, 'plugins', '../../victim'), victimDir)
    await fs.mkdir(victimDir, { recursive: true })
    await fs.writeFile(path.join(victimDir, 'keep.txt'), 'precious\n')

    const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
    const stdout = bufferWriter()
    const stderr = bufferWriter()
    const exitCode = await dispatch(['plugin', 'remove', '../../victim'], {
      env,
      stdout,
      stderr,
      cwd: hypHome,
      workspaceDir: path.join(hypHome, 'no-bundled'),
    })
    assert.equal(exitCode, 0, stderr.text())
    assert.deepEqual(await fs.readdir(victimDir), ['keep.txt'])

    // And the repair the diagnostic prints still does its job: the row is gone
    // and the error-severity diagnostic with it.
    const after = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    assert.deepEqual(Object.keys(after.plugins), ['@third-party/healthy'])
    const report = await collectHypAwareStatus({ env })
    assert.equal(report.diagnostics.some((d) => d.kind === 'plugin_lock_entry_invalid'), false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('hyp plugin remove deletes neither an escaping install_dir nor the plugins root itself', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-lock-entry-escape-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/healthy',
      version: '0.1.0',
    })
    const stateDir = path.join(hypHome, 'hypaware')
    const outsideDir = path.join(hypHome, 'outside')
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.writeFile(path.join(outsideDir, 'keep.txt'), 'precious\n')
    const lockPath = await writeHandEditedLock(
      hypHome,
      { name: '@third-party/healthy', version: '0.1.0', installDir },
      '@third-party/escaping',
      { name: '@third-party/escaping', version: '1.0.0', install_dir: outsideDir }
    )
    // An absolute `install_dir` outside the root is the other way in: the
    // fallback join is not the only unvalidated source of the directory.
    const escaped = await removePlugin({
      name: /** @type {any} */ ('@third-party/escaping'),
      stateDir,
    })
    assert.equal(escaped.ok, true)
    assert.deepEqual(await fs.readdir(outsideDir), ['keep.txt'])

    // '.' resolves to the plugins root itself, which would take every
    // installed plugin with it.
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    lock.plugins['.'] = {}
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2))
    const dot = await removePlugin({ name: /** @type {any} */ ('.'), stateDir })
    assert.equal(dot.ok, true)
    assert.equal(await dirExists(installDir), true)
    const after = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    assert.deepEqual(Object.keys(after.plugins), ['@third-party/healthy'])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('hyp plugin remove still deletes exactly the directory a contained entry names', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-lock-entry-legit-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/healthy',
      version: '0.1.0',
    })
    const other = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/neighbour',
      version: '0.1.0',
    })
    await writeFixtureLock(hypHome, [
      { name: '@third-party/healthy', version: '0.1.0', installDir },
      { name: '@third-party/neighbour', version: '0.1.0', installDir: other.installDir },
    ])
    const stateDir = path.join(hypHome, 'hypaware')
    const removed = await removePlugin({
      name: /** @type {any} */ ('@third-party/healthy'),
      stateDir,
    })
    assert.equal(removed.ok, true)
    assert.equal(await dirExists(installDir), false)
    assert.equal(await dirExists(other.installDir), true)

    // A key that normalizes back inside the root is still a contained delete.
    const nestedDir = path.join(stateDir, 'plugins', 'nested')
    await fs.mkdir(nestedDir, { recursive: true })
    const lockPath = path.join(stateDir, 'plugin-lock.json')
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    lock.plugins['elsewhere/../nested'] = {}
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2))
    const normalized = await removePlugin({
      name: /** @type {any} */ ('elsewhere/../nested'),
      stateDir,
    })
    assert.equal(normalized.ok, true)
    assert.equal(await dirExists(nestedDir), false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('hyp plugin remove still refuses a name the lock has no row for', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-lock-entry-absent-'))
  try {
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@third-party/healthy',
      version: '0.1.0',
    })
    await writeFixtureLock(hypHome, [
      { name: '@third-party/healthy', version: '0.1.0', installDir },
    ])
    const result = await removePlugin({
      name: /** @type {any} */ ('@third-party/never-installed'),
      stateDir: path.join(hypHome, 'hypaware'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, 'plugin_not_installed')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
