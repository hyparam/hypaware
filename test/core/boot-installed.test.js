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
import { defaultConfigPath } from '../../src/core/config/schema.js'

/**
 * @import { PluginManifest } from '../../collectivus-plugin-kernel-types.js'
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

test('bootKernel rejects installed plugins that shadow bundled first-party names', async () => {
  // Use a tiny synthetic "bundled" workspace so we control collision
  // surface without depending on the real V1 set.
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

    // Install a shadowing copy of @hypaware/ai-gateway.
    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@hypaware/ai-gateway',
      version: '0.2.0',
    })
    await writeFixtureLock(hypHome, [
      { name: '@hypaware/ai-gateway', version: '0.2.0', installDir },
    ])

    await assert.rejects(
      bootKernel({
        hypHome,
        mode: 'smoke',
        runId: 'test-shadow',
        bootProfile: 'config',
        workspaceDir,
        env: { ...process.env, HYP_HOME: hypHome },
      }),
      (err) => {
        assert.equal(
          /** @type {{hypErrorKind?: string}} */ (err).hypErrorKind,
          'installed_shadows_bundled'
        )
        assert.match(
          /** @type {Error} */ (err).message,
          /@hypaware\/ai-gateway/
        )
        return true
      }
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('bootKernel lets installed plugins replace excluded bundled skeletons and exposes their init presets', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-boot-installed-excluded-shadow-'))
  try {
    const workspaceDir = path.join(hypHome, 'bundled-workspace')
    const bundledDir = path.join(workspaceDir, 'gascity')
    await fs.mkdir(bundledDir, { recursive: true })
    await fs.writeFile(
      path.join(bundledDir, 'hypaware.plugin.json'),
      JSON.stringify({
        schema_version: 1,
        name: '@hypaware/gascity',
        version: '0.0.1',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
      })
    )
    await fs.writeFile(
      path.join(bundledDir, 'index.js'),
      'export async function activate() { throw new Error("excluded bundled skeleton should not activate") }\n'
    )

    const { installDir } = await stageInstalledPlugin({
      hypHome,
      name: '@hypaware/gascity',
      version: '1.0.0',
      entrypointBody:
        "export async function activate(ctx) {\n" +
        "  ctx.initPresets.register({ name: 'gascity', plugin: '@hypaware/gascity', summary: 'fixture preset', async run() { return 0 } })\n" +
        "}\n",
    })
    await writeFixtureLock(hypHome, [
      { name: '@hypaware/gascity', version: '1.0.0', installDir },
    ])

    const boot = await bootKernel({
      hypHome,
      mode: 'init',
      runId: 'test-excluded-shadow',
      bootProfile: 'all-available',
      workspaceDir,
      env: { ...process.env, HYP_HOME: hypHome },
    })

    assert.equal(boot.activePlugins.length, 1)
    assert.equal(boot.activePlugins[0].name, '@hypaware/gascity')
    assert.equal(boot.activePlugins[0].rootDir, installDir)
    assert.equal(boot.runtime.initPresets.get('gascity')?.plugin, '@hypaware/gascity')
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
