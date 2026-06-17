// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { renderStatusJson, renderStatusText } from '../../src/core/cli/core_commands.js'

// `hyp status` on a centrally-managed host must restore inspectability of
// the merged config: per-entry provenance + the dropped-local section.
// @ref LLP 0031#status-provenance [tests]

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-layered-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

test('a never-joined host reports no layering (V1 surface unchanged)', async () => {
  const hypHome = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.layered, null)
  assert.deepEqual(report.activePlugins, ['@hypaware/ai-gateway'])
})

test('a joined host surfaces provenance and the dropped-local section', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')

  // Central seed (no apply yet): the authoritative central layer.
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/central' }, { name: '@hypaware/ai-gateway' }],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
    query: { cache: { dir: '/operator/path' } },
  }) + '\n')

  // Local layer: a colliding plugin (dropped) + an additive client.
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })

  // The effective (merged) plugin set: central wins, local claude adds.
  assert.deepEqual(report.activePlugins.sort(), [
    '@hypaware/ai-gateway',
    '@hypaware/central',
    '@hypaware/claude',
  ])

  assert.ok(report.layered)
  assert.equal(report.layered?.hasCentral, true)
  assert.deepEqual(report.layered?.centralPlugins.sort(), ['@hypaware/ai-gateway', '@hypaware/central'])
  assert.deepEqual(report.layered?.centralSinks, ['central'])
  assert.equal(report.layered?.centralQueryIgnored, true)
  assert.deepEqual(report.layered?.drops, [
    { section: 'plugins', key: '@hypaware/ai-gateway', reason: 'collides_with_central' },
  ])

  // A dropped local entry is its own section, never a diagnostic, and
  // never flips overall to degraded on its own.
  assert.ok(!report.diagnostics.some((d) => d.message.includes('collides_with_central')))
})

// The data-shape tests above prove the collector; these prove the
// rendering that turns it into the user-visible provenance tags, the
// dropped-local section (collision *and* invalid-merge), and the JSON
// `config_layers` block. Rendering off a collected report avoids booting
// the kernel. @ref LLP 0031#status-provenance [tests]

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/** @param {string} hypHome */
async function joinedHomeForRender(hypHome) {
  const stateRoot = path.join(hypHome, 'hypaware')
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  // Central: a request sink + the parquet encoder it locks, plus a
  // central-owned client (claude).
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude' },
      { name: '@hypaware/format-parquet' },
    ],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
    query: { cache: { dir: '/operator/path' } },
  }) + '\n')
  // Local: a colliding plugin (dropped), a second encoder that ties with
  // central (invalid-merge drop), additive otel + a local sink (kept).
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/otel' },
      { name: '@hypaware/format-jsonl' },
    ],
    sinks: { local_parquet: { writer: '@hypaware/format-parquet', destination: '@hypaware/local-fs' } },
  }) + '\n')
}

test('status JSON renders per-row provenance and the config_layers block', async () => {
  const hypHome = await makeHome()
  await joinedHomeForRender(hypHome)
  const report = await collectHypAwareStatus({ env: env(hypHome) })

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })

  // config_layers block.
  assert.equal(json.config_layers?.central, true)
  assert.deepEqual([...json.config_layers.central_plugins].sort(), [
    '@hypaware/ai-gateway', '@hypaware/central', '@hypaware/claude', '@hypaware/format-parquet',
  ])
  assert.deepEqual(json.config_layers.central_sinks, ['central'])
  assert.equal(json.config_layers.central_query_ignored, true)
  assert.deepEqual(json.config_layers.local_not_applied.sort((/** @type {any} */ a, /** @type {any} */ b) => a.key.localeCompare(b.key)), [
    { section: 'plugins', key: '@hypaware/ai-gateway', reason: 'collides_with_central' },
    { section: 'plugins', key: '@hypaware/format-jsonl', reason: 'invalid_merge', detail: 'capability_ambiguous' },
  ])

  // Per-row provenance: plugins, sources, sinks, clients.
  const provOf = (/** @type {any[]} */ rows, /** @type {string} */ key, /** @type {string} */ field) =>
    rows.find((r) => r[field] === key)?.provenance
  assert.equal(provOf(json.active_plugins, '@hypaware/central', 'name'), 'central')
  assert.equal(provOf(json.active_plugins, '@hypaware/otel', 'name'), 'local')
  assert.equal(provOf(json.sources, 'ai-gateway', 'name'), 'central')
  assert.equal(provOf(json.sources, 'otlp', 'name'), 'local')
  assert.equal(provOf(json.sinks, 'central', 'instance'), 'central')
  assert.equal(provOf(json.sinks, 'local_parquet', 'instance'), 'local')
  assert.equal(provOf(json.client_attach, 'claude', 'name'), 'central')
  assert.equal(provOf(json.client_attach, 'codex', 'name'), 'local')
})

test('status text renders provenance tags and the dropped-local section', async () => {
  const hypHome = await makeHome()
  await joinedHomeForRender(hypHome)
  const report = await collectHypAwareStatus({ env: env(hypHome) })

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()

  // Provenance tags on plugin, source, sink, client lines.
  assert.match(text, /@hypaware\/central\s+\[central · locked\]/)
  assert.match(text, /@hypaware\/otel\s+\[local\]/)
  assert.match(text, /ai-gateway.*\[central · locked\]/)
  assert.match(text, /otlp.*\[local\]/)
  assert.match(text, /local_parquet.*\[local\]/)

  // The dropped-local section lists the collision and the invalid-merge
  // (with its triggering error kind), plus the ignored central query.
  assert.match(text, /local config \(not applied\):/)
  assert.match(text, /plugins\.@hypaware\/ai-gateway\s+\(collides with central\)/)
  assert.match(text, /plugins\.@hypaware\/format-jsonl\s+\(invalid merge: capability ambiguous\)/)
  assert.match(text, /central query block ignored/)
})

test('a never-joined host renders no provenance tags or layers block', async () => {
  const hypHome = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')
  const report = await collectHypAwareStatus({ env: env(hypHome) })

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.equal(json.config_layers, null)
  assert.ok(!('provenance' in json.active_plugins[0]))

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.doesNotMatch(stdout.text(), /\[central · locked\]|\[local\]|local config \(not applied\)/)
})
