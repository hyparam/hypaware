// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadClientConfigLayers } from '../../src/core/config/grep_migration.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { bootKernel, resolveLayeredConfigForDaemon } from '../../src/core/runtime/boot.js'

/** @import { TestContext } from 'node:test' */
const GRAPH = '@hypaware/graph-cache'
const connected = {
  version: 2, plugins: [{ name: '@hypaware/central' }],
  sinks: { central: { plugin: '@hypaware/central', config: { url: 'https://example.invalid', identity: {} } } },
}
const existing = { version: 2, auto_update: false, plugins: [{ name: '@hypaware/grep' }] }

/** @param {TestContext} t */
async function fixture(t) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-cache-migration-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  const stateRoot = path.join(hypHome, 'hypaware')
  const centralConfigPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(centralConfigPath), { recursive: true })
  return {
    hypHome, configPath, stateRoot, centralConfigPath,
    /** @param {unknown} value */
    local: value => fs.writeFile(configPath, JSON.stringify(value), { mode: 0o600 }),
    /** @param {unknown} value */
    central: value => fs.writeFile(centralConfigPath, JSON.stringify(value)),
    migrate: () => loadClientConfigLayers({ configPath, centralConfigPath, migrateGraphCache: true }),
  }
}

// @ref LLP 0490#activation [tests]: both enrollment and existing-client boot/reload get the same guarded migration
test('connected upgrade persists once, backs up, preserves fields, and registers the renamed commands', async t => {
  const f = await fixture(t)
  await f.local(existing)
  await f.central(connected)
  const original = await fs.readFile(f.configPath, 'utf8')
  const centralBefore = await fs.readFile(f.centralConfigPath, 'utf8')
  const boot = await bootKernel({ hypHome: f.hypHome, configPath: f.configPath, env: { ...process.env, HYP_HOME: f.hypHome } })
  assert.equal(boot.runtime.commands.get('query team-graph discover')?.plugin, GRAPH)
  assert.ok(boot.runtime.sources.list().some(s => s.name === 'team-graph-replica'))
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')), { ...existing, plugins: [...existing.plugins, { name: GRAPH }] })
  const backups = (await fs.readdir(f.hypHome)).filter(n => n.includes('.bak-'))
  assert.equal(backups.length, 1)
  assert.equal(await fs.readFile(path.join(f.hypHome, backups[0]), 'utf8'), original)
  assert.equal((await fs.stat(f.configPath)).mode & 0o777, 0o600)
  const before = await fs.stat(f.configPath)
  const reload = await resolveLayeredConfigForDaemon({ stateRoot: f.stateRoot, configPath: f.configPath })
  assert.ok(reload.effective?.plugins?.some(p => p.name === GRAPH))
  assert.equal((await fs.stat(f.configPath)).mtimeMs, before.mtimeMs)
  assert.equal(await fs.readFile(f.centralConfigPath, 'utf8'), centralBefore)
})

test('new central-only enrollment activates without creating a local picker answer', async t => {
  const f = await fixture(t)
  await f.central(connected)
  const reload = await resolveLayeredConfigForDaemon({ stateRoot: f.stateRoot, configPath: f.configPath })
  assert.ok(reload.effective?.plugins?.some(p => p.name === GRAPH))
  await assert.rejects(fs.stat(f.configPath), { code: 'ENOENT' })
})

for (const layer of ['local', 'central']) {
  for (const name of [GRAPH, '@hypaware/fastask']) {
    test(`explicit ${name} disable in ${layer} survives upgrade`, async t => {
      const f = await fixture(t)
      await f.local({ ...existing, plugins: [...existing.plugins, ...(layer === 'local' ? [{ name, enabled: false }] : [])] })
      await f.central({ ...connected, plugins: [...connected.plugins, ...(layer === 'central' ? [{ name, enabled: false }] : [])] })
      const centralBefore = await fs.readFile(f.centralConfigPath, 'utf8')
      const migrated = await f.migrate()
      const governing = layer === 'local' ? migrated.local : migrated.central
      assert.deepEqual(governing?.ok && governing.config.plugins?.find(p => p.name === GRAPH), { name: GRAPH, enabled: false })
      assert.equal(await fs.readFile(f.centralConfigPath, 'utf8'), centralBefore)
      const boot = await bootKernel({ hypHome: f.hypHome, configPath: f.configPath, env: { ...process.env, HYP_HOME: f.hypHome } })
      assert.equal(boot.runtime.commands.get('query team-graph discover'), undefined)
    })
  }
}

test('a local-only or query-only remote install stays without graph-cache', async t => {
  const f = await fixture(t)
  await f.central({ version: 2, plugins: [] })
  for (const query of [undefined, { default_remote: 'team', remotes: { team: { url: 'https://example.invalid' } } }]) {
    await f.local({ ...existing, query })
    const migrated = await f.migrate()
    assert.ok(migrated.local?.ok)
    assert.equal(migrated.local.config.plugins?.some(p => p.name === GRAPH), false)
  }
})

test('unreadable central config prevents automatic enablement; a disabled central plugin wins over local', async t => {
  const f = await fixture(t)
  await f.local({ ...connected, auto_update: false })
  await fs.writeFile(f.centralConfigPath, '{broken')
  let migrated = await f.migrate()
  assert.equal(migrated.local?.ok && migrated.local.config.plugins?.some(p => p.name === GRAPH), false)
  await f.central({ ...connected, plugins: [{ name: '@hypaware/central', enabled: false }] })
  migrated = await f.migrate()
  assert.equal(migrated.local?.ok && migrated.local.config.plugins?.some(p => p.name === GRAPH), false)
})

test('a local symlink to the central document is composed in memory without rewriting it', async t => {
  const f = await fixture(t)
  await f.central(connected)
  await fs.symlink(f.centralConfigPath, f.configPath)
  const before = await fs.readFile(f.centralConfigPath, 'utf8')
  const migrated = await f.migrate()
  assert.ok(migrated.local?.ok && migrated.local.config.plugins?.some(p => p.name === GRAPH))
  assert.ok((await fs.lstat(f.configPath)).isSymbolicLink())
  assert.equal(await fs.readFile(f.centralConfigPath, 'utf8'), before)
})


test('a hand-authored local forwarding sink does not count as central enrollment', async t => {
  const f = await fixture(t)
  await f.local(connected)
  await f.central({ version: 2, plugins: [] })
  const migrated = await f.migrate()
  assert.equal(migrated.local?.ok && migrated.local.config.plugins?.some(p => p.name === GRAPH), false)
})
