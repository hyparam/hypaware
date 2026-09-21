// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadClientConfigLayers } from '../../src/core/config/grep_migration.js'
import { runWizardPick } from '../../src/core/cli/wizard/pick.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { configRecordsPickAnswer } from '../../src/core/config/schema.js'
import { bootKernel, resolveLayeredConfigForDaemon } from '../../src/core/runtime/boot.js'
import { createMcpServer } from '../../src/core/mcp/server.js'
import { withFileLock } from '../../src/core/util/file_lock.js'

/** @import { TestContext } from 'node:test' */

const grep = { name: '@hypaware/grep' }

/** The bundled catalog the picker renders its rows from. */
async function realCatalog() {
  const bundled = await discoverBundledPlugins()
  return buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
}

function makeBuf() {
  return { write() { return true } }
}

/**
 * Capture the question the picker asks and answer it with a fixed set of ids.
 * @param {string[]} answer
 */
function capturingPrompt(answer) {
  /** @type {{ question: any }} */
  const state = { question: null }
  /** @type {any} */
  const prompt = async (/** @type {any} */ question) => {
    state.question = question
    return answer
  }
  return { prompt, state }
}

/** @param {TestContext} t */
async function fixture(t) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-grep-migration-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  const stateRoot = path.join(hypHome, 'hypaware')
  const centralConfigPath = centralSeedPath(stateRoot)
  const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath }
  return {
    hypHome, configPath, stateRoot, centralConfigPath, env,
    /** @param {unknown} config */
    local: (config) => fs.writeFile(configPath, JSON.stringify(config) + '\n', { mode: 0o600 }),
    /** @param {unknown} config */
    central: async (config) => {
      await fs.mkdir(path.dirname(centralConfigPath), { recursive: true })
      await fs.writeFile(centralConfigPath, JSON.stringify(config) + '\n')
    },
    migrate: () => loadClientConfigLayers({ configPath, centralConfigPath, migrateGrep: true }),
  }
}

test('legacy client boot persists grep once, preserves config and exposes the MCP tool', async (t) => {
  const f = await fixture(t)
  const original = { version: 2, plugins: [{ name: '@hypaware/format-jsonl', enabled: false }], auto_update: false }
  await f.local(original)
  const before = await fs.readFile(f.configPath, 'utf8')
  const boot = await bootKernel({ hypHome: f.hypHome, env: f.env })
  assert.equal(boot.runtime.verbs.getByTool('grep_search')?.plugin, grep.name)
  assert.ok(boot.runtime.commands.get('query grep'))
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')), { ...original, plugins: [...original.plugins, grep] })
  assert.equal((await fs.stat(f.configPath)).mode & 0o777, 0o600)
  const backups = (await fs.readdir(f.hypHome)).filter((name) => name.includes('.bak-'))
  assert.equal(backups.length, 1)
  assert.equal(await fs.readFile(path.join(f.hypHome, backups[0]), 'utf8'), before)
  const stat = await fs.stat(f.configPath)
  await bootKernel({ hypHome: f.hypHome, env: f.env })
  assert.equal((await fs.stat(f.configPath)).mtimeMs, stat.mtimeMs)
  assert.deepEqual((await fs.readdir(f.hypHome)).filter((name) => name.includes('.bak-')), backups)
  const mcp = createMcpServer({
    verbs: boot.runtime.verbs, query: boot.runtime.query, transport: 'stdio', allowOperator: false,
    runTool: (verb, params) => Promise.resolve(verb.operation(params, /** @type {any} */ ({ storage: boot.runtime.storage }))),
  })
  const response = /** @type {any} */ (await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  assert.ok(response.result.tools.some((/** @type {any} */ tool) => tool.name === 'grep_search'))
})

// The local config this lane would have to create holds nothing but the
// compatibility entry, and a `plugins` array is what every other reader takes
// for a recorded pick answer, so the entry stays in memory here.
// @ref LLP 0418#no-forged-answer [tests]: a central-only install gains search without gaining a local layer
test('central-only clients get search in memory; reload agrees and no local config appears', async (t) => {
  const f = await fixture(t)
  await f.central({ version: 2, plugins: [] })
  const before = await fs.readFile(f.centralConfigPath, 'utf8')
  const resolved = await resolveLayeredConfigForDaemon(f)
  assert.deepEqual(resolved.effective?.plugins, [grep])
  await assert.rejects(fs.access(f.configPath), { code: 'ENOENT' }, 'no local layer is written')
  assert.equal(await fs.readFile(f.centralConfigPath, 'utf8'), before)
})

// The enrolled-but-never-picked window: the seed `hyp join` / an enrolling
// `hyp remote login` writes names only the enrollment plugin, so the fleet has
// not answered the pick question either, and nothing on the machine may claim
// it did.
// @ref LLP 0418#no-forged-answer [tests]: an enrolled machine that never picked still seeds onboarding from detection
test('an enrolled machine that never picked keeps no pick answer and seeds init from detection', async (t) => {
  const f = await fixture(t)
  await f.central({
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    sinks: { central: { plugin: '@hypaware/central', config: { url: 'https://example.invalid', identity: {} } } },
  })

  const resolved = await resolveLayeredConfigForDaemon(f)
  assert.equal(resolved.effective?.plugins?.some((p) => p.name === grep.name), true, 'search is preserved')

  const report = await collectHypAwareStatus({ env: f.env })
  assert.equal(report.layered?.hasCentral, true, 'enrolled')
  assert.equal(report.configRecordsAnswer, false, 'but nobody answered the pick question')

  const catalog = await realCatalog()
  const { prompt, state } = capturingPrompt(['claude', 'codex'])
  const result = await runWizardPick(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), catalog, prompt,
    env: { ...f.env, HOME: f.hypHome, HYP_NO_TUI: '1' },
    detect: async () => new Set(['claude', 'codex']),
    confirmOverwrite: async () => true,
  }))
  const checked = state.question.options
    .filter((/** @type {any} */ o) => o.checked)
    .map((/** @type {any} */ o) => o.value)
  assert.deepEqual(checked.sort(), ['claude', 'codex'], 'detection seeds the first run')
  assert.deepEqual([...result.sourcesPicked].sort(), ['claude', 'codex'])
})

test('existing enabled and disabled entries in either layer are untouched', async (t) => {
  for (const layer of ['local', 'central']) {
    for (const enabled of [true, false]) {
      const f = await fixture(t)
      await f.local({ version: 2, plugins: layer === 'local' ? [{ ...grep, enabled }] : [] })
      await f.central({ version: 2, plugins: layer === 'central' ? [{ ...grep, enabled }] : [] })
      const before = await fs.readFile(f.configPath, 'utf8')
      await f.migrate()
      assert.equal(await fs.readFile(f.configPath, 'utf8'), before)
      assert.equal((await fs.readdir(f.hypHome)).some((name) => name.includes('.bak-')), false)
      const resolved = await resolveLayeredConfigForDaemon(f)
      assert.equal(resolved.effective?.plugins?.find((p) => p.name === grep.name)?.enabled, enabled)
    }
  }
})

test('read-only config retains search without modifying disk or making backups', async (t) => {
  const f = await fixture(t)
  await f.local({ version: 2, plugins: [] })
  await fs.chmod(f.configPath, 0o400)
  t.after(() => fs.chmod(f.configPath, 0o600).catch(() => {}))
  const before = await fs.readFile(f.configPath, 'utf8')
  const boot = await bootKernel({ hypHome: f.hypHome, env: f.env })
  assert.ok(boot.runtime.verbs.getByTool('grep_search'))
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before)
  assert.equal((await fs.readdir(f.hypHome)).some((name) => name.includes('.bak-')), false)
})

test('missing and malformed layers are not replaced', async (t) => {
  const f = await fixture(t)
  const fresh = await bootKernel({ hypHome: f.hypHome, env: f.env })
  assert.equal(fresh.runtime.verbs.getByTool('grep_search'), undefined)
  await assert.rejects(fs.access(f.configPath), { code: 'ENOENT' })
  await fs.writeFile(f.configPath, '{broken')
  await f.central({ version: 2, plugins: [] })
  await f.migrate()
  assert.equal(await fs.readFile(f.configPath, 'utf8'), '{broken')
  await f.local({ version: 2, plugins: [] })
  await fs.writeFile(f.centralConfigPath, '{broken')
  await f.migrate()
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins, [])
})

test('an answer-less config keeps search without gaining a pick answer', async (t) => {
  const f = await fixture(t)
  // `hyp remote add` before the first `hyp init` (LLP 0277): no `plugins` key.
  const original = { version: 2, query: { remotes: { org: { url: 'https://example.com' } } } }
  await f.local(original)
  const before = await fs.readFile(f.configPath, 'utf8')
  const boot = await bootKernel({ hypHome: f.hypHome, env: f.env })
  assert.equal(boot.runtime.verbs.getByTool('grep_search')?.plugin, grep.name)
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before)
  assert.equal(configRecordsPickAnswer(JSON.parse(await fs.readFile(f.configPath, 'utf8'))), false)
  assert.equal((await fs.readdir(f.hypHome)).some((name) => name.includes('.bak-')), false)
})

test('concurrent migrations produce one entry and one backup', async (t) => {
  const f = await fixture(t)
  await f.local({ version: 2, plugins: [] })
  await Promise.all(Array.from({ length: 6 }, () => loadClientConfigLayers({
    configPath: f.configPath, centralConfigPath: null, migrateGrep: true,
  })))
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins, [grep])
  assert.equal((await fs.readdir(f.hypHome)).filter((name) => name.includes('.bak-')).length, 1)
})

test('a disable written while migration waits for the lock wins', { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  await f.local({ version: 2, plugins: [] })
  // Hold the real migration lock until a second process-equivalent reader
  // has read the old file and tried to acquire it.
  const waiting = Promise.withResolvers()
  let watching = false
  const originalOpen = fs.open.bind(fs)
  t.mock.method(fs, 'open', async (...args) => {
    if (watching && args[0] === `${f.configPath}.grep-migration.lock`) waiting.resolve(undefined)
    return originalOpen(...args)
  })
  let migration
  await withFileLock(`${f.configPath}.grep-migration.lock`, async () => {
    watching = true
    migration = loadClientConfigLayers({ configPath: f.configPath, centralConfigPath: null, migrateGrep: true })
    await waiting.promise
    await f.local({ version: 2, plugins: [{ ...grep, enabled: false }] })
  })
  const result = await migration
  assert.deepEqual(result?.local?.ok && result.local.config.plugins, [{ ...grep, enabled: false }])
  assert.equal((await fs.readdir(f.hypHome)).some((name) => name.includes('.bak-')), false)
})

test('a read-only config directory on a central-only install uses the memory fallback', async (t) => {
  const f = await fixture(t)
  await f.central({ version: 2, plugins: [] })
  const directory = path.join(f.hypHome, 'readonly')
  await fs.mkdir(directory, { mode: 0o500 })
  t.after(() => fs.chmod(directory, 0o700).catch(() => {}))
  const configPath = path.join(directory, 'config.json')
  const resolved = await resolveLayeredConfigForDaemon({ stateRoot: f.stateRoot, configPath })
  assert.deepEqual(resolved.effective?.plugins, [grep])
  assert.deepEqual(await fs.readdir(directory), [])
})

test('explicit host profiles leave config and the search registration available to the host', async (t) => {
  const f = await fixture(t)
  await f.local({ version: 2, plugins: [] })
  const before = await fs.readFile(f.configPath, 'utf8')
  const boot = await bootKernel({ hypHome: f.hypHome, env: f.env, bootProfile: { activate: [] } })
  assert.equal(boot.runtime.verbs.getByTool('grep_search'), undefined)
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before)
  boot.runtime.verbs.register({
    name: 'server-search', tool: 'grep_search', summary: 'Server search', authClass: 'read',
    inputSchema: { type: 'object', properties: {} }, operation: async () => ({}),
    render: () => ({ stdout: '', code: 0 }),
  })
  assert.ok(boot.runtime.verbs.getByTool('grep_search'))
})

test('symlinks and a local path naming the central layer never rewrite the central document', async (t) => {
  const f = await fixture(t)
  await f.central({ version: 2, plugins: [] })
  const before = await fs.readFile(f.centralConfigPath, 'utf8')
  await fs.symlink(f.centralConfigPath, f.configPath)
  const viaLink = await f.migrate()
  assert.deepEqual(viaLink.local?.ok && viaLink.local.config.plugins, [grep])
  assert.equal((await fs.lstat(f.configPath)).isSymbolicLink(), true)
  const direct = await loadClientConfigLayers({
    configPath: f.centralConfigPath, centralConfigPath: f.centralConfigPath, migrateGrep: true,
  })
  assert.deepEqual(direct.local?.ok && direct.local.config.plugins, [grep])
  assert.equal(await fs.readFile(f.centralConfigPath, 'utf8'), before)
})
