// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { compareStrings } from '../../src/core/util/compare_strings.js'

// `hyp status` on a centrally-managed host must restore inspectability of
// the merged config: per-entry provenance + the dropped-local section.
// @ref LLP 0031#status-provenance [tests]:

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
// the kernel. @ref LLP 0031#status-provenance [tests]:

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
  assert.deepEqual(json.config_layers.local_not_applied.sort((/** @type {any} */ a, /** @type {any} */ b) => compareStrings(a.key, b.key)), [
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

// A central layer that is on disk but does not parse is not an absent one:
// the collector collapses both to `centralConfig === null`, so without a
// diagnostic of its own the report names the file nowhere (issue #2423).

test('a joined host whose central seed cannot be parsed names the file', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, '{ not json at all\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })

  const unreadable = report.diagnostics.find((d) => d.kind === 'config_central_unreadable')
  assert.ok(unreadable, 'the unreadable central layer has a diagnostic of its own')
  assert.equal(unreadable?.severity, 'warning')
  // A JSON parse failure's own inner message does not repeat the path, so the
  // diagnostic interpolates it explicitly; this is the exact case issue
  // #2423 reproduced.
  assert.ok(unreadable?.message.includes(seedPath), `message names the file: ${unreadable?.message}`)
  assert.match(unreadable?.message ?? '', /is unreadable \(config is not valid JSON/)
  // The local layer still carries the host, so the verdict is unchanged: the
  // diagnostic is loud, not an outage signal.
  assert.equal(report.overall, 'healthy')
  // The merge itself is unchanged: there is nothing readable to merge.
  assert.deepEqual(report.activePlugins, ['@hypaware/ai-gateway'])
})

test('an unparseable applied slot is named through the active pointer', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const controlDir = path.join(stateRoot, 'config-control')
  await fs.mkdir(controlDir, { recursive: true })
  const slotPath = path.join(controlDir, 'config.a.json')
  await fs.writeFile(slotPath, 'truncated-garbage')
  await fs.symlink('config.a.json', path.join(controlDir, 'active'))
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })

  const unreadable = report.diagnostics.find((d) => d.kind === 'config_central_unreadable')
  assert.ok(unreadable, 'the unreadable applied slot has a diagnostic of its own')
  // Same shape as the seed case: the inner JSON-parse message does not repeat
  // the slot path, so the diagnostic interpolates it explicitly.
  assert.ok(unreadable?.message.includes(slotPath), `message names the slot: ${unreadable?.message}`)
  assert.match(unreadable?.message ?? '', /is unreadable \(config is not valid JSON/)
})

test('a readable central layer reports no unreadable-layer diagnostic', async () => {
  const hypHome = await makeHome()
  await joinedHomeForRender(hypHome)
  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.ok(!report.diagnostics.some((d) => d.kind === 'config_central_unreadable'))
})

// The old gate (`!centralLoaded.ok && errorKind !== 'config_missing'`) missed
// every state where `centralLoaded` never got as far as a load failure at
// all: a pointer naming a slot that is gone, a pointer that is not a symlink,
// and a control directory this process cannot even list. All three are a
// central layer this host cannot read, not an absent one, and all three used
// to report `overall: healthy`, `layered: null`, and zero config diagnostics
// (issue #2423's wider form).

test('an active-slot pointer naming a slot file that is gone reports the central layer unreadable', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const controlDir = path.join(stateRoot, 'config-control')
  await fs.mkdir(controlDir, { recursive: true })
  const missingSlotPath = path.join(controlDir, 'config.b.json')
  // The pointer resolves (by name) to a slot the apply engine never wrote
  // here, or already rotated away - `readActiveSlot` only checks the target
  // name, not that the file exists.
  await fs.symlink('config.b.json', path.join(controlDir, 'active'))
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })

  const unreadable = report.diagnostics.find((d) => d.kind === 'config_central_unreadable')
  assert.ok(unreadable, 'a pointer naming a gone slot file has a diagnostic of its own')
  assert.equal(unreadable?.severity, 'warning')
  assert.ok(unreadable?.message.includes(missingSlotPath), `message names the missing slot file: ${unreadable?.message}`)
  assert.equal(report.layered, null)
  assert.equal(report.overall, 'healthy')
})

test('an active pointer replaced by a regular file reports the central layer unreadable', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const controlDir = path.join(stateRoot, 'config-control')
  await fs.mkdir(controlDir, { recursive: true })
  // The slot file still holds a central sink, but the pointer that would
  // name it is a plain file, not a symlink: `readActiveSlot` cannot follow it.
  await fs.writeFile(path.join(controlDir, 'config.a.json'), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }) + '\n')
  await fs.writeFile(path.join(controlDir, 'active'), 'config.a.json')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })

  const unreadable = report.diagnostics.find((d) => d.kind === 'config_central_unreadable')
  assert.ok(unreadable, 'a non-symlink active pointer has a diagnostic of its own')
  assert.ok(unreadable?.message.includes(controlDir), `message names the control directory: ${unreadable?.message}`)
  // Resolution could not follow the pointer, so there is nothing to merge:
  // the host still holds another org's sink verbatim in `config.a.json`, but
  // `layered` reads `null`, same as a never-joined host.
  assert.equal(report.layered, null)
  assert.equal(report.overall, 'healthy')
})

test('a central config directory that cannot be listed reports the central layer unreadable', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const controlDir = path.join(stateRoot, 'config-control')
  await fs.mkdir(controlDir, { recursive: true })
  await fs.writeFile(path.join(controlDir, 'seed.json'), JSON.stringify({ version: 2 }))
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')
  await fs.chmod(controlDir, 0o000)

  try {
    const report = await collectHypAwareStatus({ env: env(hypHome) })

    const unreadable = report.diagnostics.find((d) => d.kind === 'config_central_unreadable')
    assert.ok(unreadable, 'an unlistable control directory has a diagnostic of its own')
    assert.match(unreadable?.message ?? '', /failed to read the central config directory/)
    assert.ok(unreadable?.message.includes(controlDir), `message names the control directory: ${unreadable?.message}`)
    assert.equal(report.layered, null)
    assert.equal(report.overall, 'healthy')
  } finally {
    await fs.chmod(controlDir, 0o700)
  }
})

// The `config_missing` message's "neither a central layer" clause is only
// true when the central layer really is absent. When it is unreadable
// instead, the two diagnostics used to contradict each other on the same
// report (issue #2423).

test('config_missing does not claim "neither a central layer" when the central layer is unreadable', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const controlDir = path.join(stateRoot, 'config-control')
  await fs.mkdir(controlDir, { recursive: true })
  await fs.symlink('config.b.json', path.join(controlDir, 'active'))
  // No local config at all, and the central layer resolves to a slot file
  // that is gone: both `config_missing` and `config_central_unreadable` fire.

  const report = await collectHypAwareStatus({ env: env(hypHome) })

  const missing = report.diagnostics.find((d) => d.kind === 'config_missing')
  assert.ok(missing, 'the no-config diagnostic still fires')
  assert.doesNotMatch(missing?.message ?? '', /neither a central layer/)
  assert.ok(missing?.message.includes('no config found'))

  const unreadable = report.diagnostics.find((d) => d.kind === 'config_central_unreadable')
  assert.ok(unreadable, 'the central layer is reported unreadable too')
})
