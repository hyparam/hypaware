// @ts-check

// `bootKernel` has to be able to say, in one place, that this boot did not get
// its whole plugin set. Deriving that from the activation results alone answers
// only "whose `activate()` threw", and three other doors take a selected plugin
// out of the plan without it ever reaching an activation record: the dep graph
// eliminates it, the boot profile withholds it, or its manifest never loaded.
// The client-asset prune is a delete path that stands down on this list, so a
// hole it cannot see is a file it deletes (LLP 0219
// #incomplete-activation-prunes-nothing).
// @ref LLP 0219#incomplete-activation-prunes-nothing [tests]:

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { bootKernel } from '../../src/core/runtime/boot.js'

/**
 * Write one bundled-plugin fixture into a synthetic workspace directory.
 * Names must be real bundled names: the allowlist and the excluded set are
 * fixed name sets, and it is exactly that bucketing the profile tests read.
 *
 * @param {{
 *   workspaceDir: string,
 *   dir: string,
 *   name: string,
 *   requires?: Record<string, unknown>,
 *   provides?: Record<string, unknown>,
 * }} args
 * @returns {Promise<void>}
 */
async function writeBundledFixture({ workspaceDir, dir, name, requires, provides }) {
  const rootDir = path.join(workspaceDir, dir)
  await fs.mkdir(rootDir, { recursive: true })
  await fs.writeFile(
    path.join(rootDir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '2.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      ...(requires ? { requires } : {}),
      ...(provides ? { provides } : {}),
    })
  )
  await fs.writeFile(path.join(rootDir, 'index.js'), 'export async function activate() {}\n')
}

/**
 * @param {string} hypHome
 * @param {string[]} pluginNames
 * @returns {Promise<string>} the config path
 */
async function writeConfig(hypHome, pluginNames) {
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(
    configPath,
    JSON.stringify({ version: 2, plugins: pluginNames.map((name) => ({ name, config: {} })) })
  )
  return configPath
}

/** @returns {Promise<{ hypHome: string, workspaceDir: string }>} */
async function tmpBoot(label) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), `hyp-unavailable-${label}-`))
  return { hypHome, workspaceDir: path.join(hypHome, 'workspace') }
}

test('a config-enabled plugin the boot profile drops is reported unavailable', async () => {
  const { hypHome, workspaceDir } = await tmpBoot('profile')
  try {
    await writeBundledFixture({ workspaceDir, dir: 'ai-gateway', name: '@hypaware/ai-gateway' })
    // Bundled but excluded from every default profile, and opt-in via config.
    await writeBundledFixture({ workspaceDir, dir: 'gascity', name: '@hypaware/gascity' })
    const configPath = await writeConfig(hypHome, ['@hypaware/ai-gateway', '@hypaware/gascity'])

    // What `hyp init` boots. `all-available` drops the excluded opt-in even
    // though the config enables it, so its contributions are missing from this
    // boot for a reason that has nothing to do with a retirement.
    const boot = await bootKernel({
      hypHome,
      configPath,
      workspaceDir,
      mode: 'smoke',
      runId: 'unavailable-profile',
      bootProfile: 'all-available',
      env: { ...process.env, HYP_HOME: hypHome },
    })

    assert.deepEqual(
      boot.activations.filter((r) => r.ok === false),
      [],
      'nothing threw: an activation-only derivation cannot see this hole at all'
    )
    assert.deepEqual([...boot.unavailablePlugins].sort(), ['@hypaware/gascity'])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('an ordinary config-profile boot reports nothing unavailable', async () => {
  const { hypHome, workspaceDir } = await tmpBoot('config')
  try {
    await writeBundledFixture({ workspaceDir, dir: 'ai-gateway', name: '@hypaware/ai-gateway' })
    await writeBundledFixture({ workspaceDir, dir: 'gascity', name: '@hypaware/gascity' })
    // In the pool, withheld by the `config` profile, and never asked for. If the
    // profile term were not intersected with what the config enables, this alone
    // would stand the prune down on every ordinary boot, forever.
    await writeBundledFixture({ workspaceDir, dir: 'otel', name: '@hypaware/otel' })
    const configPath = await writeConfig(hypHome, ['@hypaware/ai-gateway', '@hypaware/gascity'])

    const boot = await bootKernel({
      hypHome,
      configPath,
      workspaceDir,
      mode: 'smoke',
      runId: 'unavailable-config',
      env: { ...process.env, HYP_HOME: hypHome },
    })

    assert.deepEqual(boot.withheldByProfile, ['@hypaware/otel'])
    assert.deepEqual(
      boot.unavailablePlugins,
      [],
      'a plugin the user did not enable is not a hole in this boot'
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a plugin the dep graph eliminated is reported unavailable', async () => {
  const { hypHome, workspaceDir } = await tmpBoot('depgraph')
  try {
    // The shape a capability-version bump takes across an upgrade: both
    // skill-contributing bundled plugins require `hypaware.ai-gateway ^2.0.0`,
    // and a provider that no longer satisfies the range eliminates them from
    // `finalOrder` before `activatePlugins` is handed anything.
    await writeBundledFixture({
      workspaceDir,
      dir: 'ai-gateway',
      name: '@hypaware/ai-gateway',
      provides: { capabilities: { 'hypaware.ai-gateway': '1.4.0' } },
    })
    await writeBundledFixture({
      workspaceDir,
      dir: 'claude',
      name: '@hypaware/claude',
      requires: { capabilities: { 'hypaware.ai-gateway': '^2.0.0' } },
    })
    const configPath = await writeConfig(hypHome, ['@hypaware/ai-gateway', '@hypaware/claude'])

    const boot = await bootKernel({
      hypHome,
      configPath,
      workspaceDir,
      mode: 'smoke',
      runId: 'unavailable-depgraph',
      env: { ...process.env, HYP_HOME: hypHome },
    })

    assert.deepEqual(
      boot.activations.filter((r) => r.ok === false),
      [],
      'an eliminated plugin never reaches the activation array to be counted'
    )
    assert.deepEqual([...boot.unavailablePlugins].sort(), ['@hypaware/claude'])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a manifest that would not load is reported unavailable', async () => {
  const { hypHome, workspaceDir } = await tmpBoot('manifest')
  try {
    await writeBundledFixture({ workspaceDir, dir: 'ai-gateway', name: '@hypaware/ai-gateway' })
    const brokenDir = path.join(workspaceDir, 'broken')
    await fs.mkdir(brokenDir, { recursive: true })
    await fs.writeFile(path.join(brokenDir, 'hypaware.plugin.json'), '{ not json')
    const configPath = await writeConfig(hypHome, ['@hypaware/ai-gateway'])

    const boot = await bootKernel({
      hypHome,
      configPath,
      workspaceDir,
      mode: 'smoke',
      runId: 'unavailable-manifest',
      env: { ...process.env, HYP_HOME: hypHome },
    })

    assert.equal(boot.unavailablePlugins.length, 1)
    assert.match(String(boot.unavailablePlugins[0]), /broken/)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a boot that selected nothing still reports what it could not load', async () => {
  const { hypHome, workspaceDir } = await tmpBoot('empty')
  try {
    const brokenDir = path.join(workspaceDir, 'broken')
    await fs.mkdir(brokenDir, { recursive: true })
    await fs.writeFile(path.join(brokenDir, 'hypaware.plugin.json'), '{ not json')
    const configPath = await writeConfig(hypHome, [])

    const boot = await bootKernel({
      hypHome,
      configPath,
      workspaceDir,
      mode: 'smoke',
      runId: 'unavailable-empty',
      env: { ...process.env, HYP_HOME: hypHome },
    })

    assert.equal(boot.activePlugins.length, 0)
    assert.equal(boot.unavailablePlugins.length, 1, 'the early return must carry the field too')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
