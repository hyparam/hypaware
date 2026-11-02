// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { detectPickerSources } from '../../src/core/cli/detect.js'
import { composePickerConfig } from '../../src/core/cli/walkthrough.js'
import { INIT_CLIENT_CHOICES, INIT_SOURCE_CHOICES, resolveInitSources } from '../../src/core/commands/init.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

/**
 * @import { InitFlags, PickerSource } from '../../src/core/cli/types.js'
 * @import { HypAwareV2Config } from '../../hypaware-plugin-kernel-types.js'
 */

async function realCatalog() {
  const bundled = await discoverBundledPlugins()
  return buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
}

/** @param {Partial<InitFlags>} over */
function flags(over) {
  return /** @type {InitFlags} */ ({
    yes: false,
    noDaemon: false,
    dryRun: false,
    clients: [],
    sources: [],
    exportChoice: undefined,
    retentionDays: 30,
    force: false,
    ...over,
  })
}

// The non-interactive `hyp setup` flags are a hand-written copy of the picker
// catalog, and the copy drifts: Claude Desktop became a picker row in v1.31.0
// without becoming a `--client` or `--source` value, so a scripted install
// could not enable Desktop capture at all (#1301). These hold the copy
// against the manifests so the next row cannot repeat the gap.

// @ref LLP 0368#display-only [tests]: a platform-gated row keeps its `--source` identity
test('every picker row the bundled catalog contributes is a `hyp setup --source` value, and nothing else is', async () => {
  const catalog = await realCatalog()
  const rows = [...catalog.pickerDescriptors.keys()].sort()
  assert.deepEqual([...INIT_SOURCE_CHOICES].sort(), rows)
  // The gated row in particular: the gate filters the interactive menu only.
  assert.ok(INIT_SOURCE_CHOICES.includes('claude-desktop'))
})

test('every `hyp setup --client` value is a picker row whose plugin contributes a client', async () => {
  const catalog = await realCatalog()
  const clientPlugins = new Set([...catalog.clientDescriptors.values()].map((d) => d.plugin))
  for (const name of INIT_CLIENT_CHOICES) {
    const row = catalog.pickerDescriptors.get(name)
    assert.ok(row, `--client ${name} must be a picker row`)
    assert.ok(clientPlugins.has(row.plugin), `--client ${name}: ${row.plugin} contributes no client`)
    assert.ok(INIT_SOURCE_CHOICES.includes(name), `--client ${name} must also be a --source value, it folds into one`)
  }
  assert.ok(INIT_CLIENT_CHOICES.includes('claude-desktop'))
})

// The converse, which is what actually closes #1301 for `--client`: the
// one-way check above still lets a new client row join the picker without
// joining the flag, exactly the way `claude-desktop` did. Every row whose
// plugin contributes a client is a `--client` value unless it is named here.
// OpenClaw is the open question the branch deliberately leaves open: whether
// it belongs in `--client` at all. Hermes contributes a client only to place
// the neutral skills under `~/.hermes/skills` (LLP 0494#skills); it has no
// attach probe, and `--source hermes` already enables it. Adding a client row
// now forces that answer instead of silently repeating the gap.
const CLIENT_ROWS_WITHOUT_A_FLAG = new Set(['openclaw', 'hermes'])

test('every picker row whose plugin contributes a client is a `--client` value, or a named exception', async () => {
  const catalog = await realCatalog()
  const clientPlugins = new Set([...catalog.clientDescriptors.values()].map((d) => d.plugin))
  const rowsWithAClient = [...catalog.pickerDescriptors.entries()]
    .filter(([, row]) => clientPlugins.has(row.plugin))
    .map(([name]) => name)
  for (const name of rowsWithAClient) {
    if (CLIENT_ROWS_WITHOUT_A_FLAG.has(name)) continue
    assert.ok(
      INIT_CLIENT_CHOICES.includes(/** @type {InitFlags['clients'][number]} */ (name)),
      `picker row ${name} contributes a client but is not a --client value; add it or name it an exception`
    )
  }
  // The exception list itself must stay honest: a name that stops being a
  // client row (or becomes a flag) has to leave it.
  for (const name of CLIENT_ROWS_WITHOUT_A_FLAG) {
    assert.ok(rowsWithAClient.includes(name), `${name} is no longer a client picker row`)
    assert.equal(INIT_CLIENT_CHOICES.includes(/** @type {InitFlags['clients'][number]} */ (name)), false, name)
  }
})

test('--client claude-desktop folds into the claude-desktop source pick the picker row makes', () => {
  // The fold is what makes `--client` sufficient on its own; the Desktop row
  // then composes `@hypaware/claude` + `@hypaware/claude-desktop` exactly as
  // the interactive picker does (compose-picker-config.test.js covers the
  // composition itself).
  assert.deepEqual(resolveInitSources(flags({ clients: ['claude-desktop'] })), ['claude-desktop'])
  assert.deepEqual(resolveInitSources(flags({ yes: true, clients: ['claude-desktop'] })), ['claude-desktop'])
})

// Goose is a picker row and a `--source` value, but not a `--client` one: it
// contributes no client (read-only adapter, LLP 0570#manifest). The detect
// path is the default Mac Part A observed, the same as Linux.
// @ref LLP 0571#tasks [tests]: T2 picker row, detection, and setup re-run cases
test('the picker pre-checks goose only when ~/.local/share/goose/sessions exists, and opens no database', async () => {
  const catalog = await realCatalog()
  assert.deepEqual(catalog.pickerDescriptors.get('goose')?.detect, { settings_file: '.local/share/goose/sessions/sessions.db' })
  assert.equal(INIT_CLIENT_CHOICES.includes(/** @type {InitFlags['clients'][number]} */ ('goose')), false)
  assert.deepEqual(resolveInitSources(flags({ sources: ['goose'] })), ['goose'])

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-goose-detect-'))
  try {
    assert.equal((await detectPickerSources(catalog, { HOME: home })).has('goose'), false)
    const dir = path.join(home, '.local', 'share', 'goose', 'sessions')
    await fs.mkdir(dir, { recursive: true })
    // Not a SQLite file: detection must not need to open it, and must leave
    // no -wal, -shm or -journal companion behind.
    const bytes = 'not a sqlite database'
    await fs.writeFile(path.join(dir, 'sessions.db'), bytes)
    assert.equal((await detectPickerSources(catalog, { HOME: home })).has('goose'), true)
    assert.deepEqual(await fs.readdir(dir), ['sessions.db'])
    assert.equal(await fs.readFile(path.join(dir, 'sessions.db'), 'utf8'), bytes)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/**
 * @param {Awaited<ReturnType<typeof realCatalog>>} catalog
 * @param {PickerSource[]} sources
 * @param {HypAwareV2Config} [existing]
 */
function composeSetup(catalog, sources, existing) {
  return composePickerConfig({
    sources,
    descriptors: catalog.pickerDescriptors,
    exportChoice: 'local-parquet',
    retentionDays: 30,
    hypHome: '/home/tester/.hyp',
    composeWith: catalog.composeWith,
    ...(existing ? { existing } : {}),
  })
}

test('re-running setup with goose picked keeps goose.enabled = false, byte for byte', async () => {
  const catalog = await realCatalog()
  const existing = composeSetup(catalog, ['goose'])
  const goose = existing.plugins?.find((p) => p.name === '@hypaware/goose')
  assert.ok(goose, 'the goose row composes @hypaware/goose')
  goose.config = { enabled: false }
  const before = JSON.stringify(existing, null, 2) + '\n'

  const rerun = composeSetup(catalog, ['goose'], JSON.parse(before))
  assert.equal(JSON.stringify(rerun, null, 2) + '\n', before)
  assert.deepEqual(rerun.plugins?.find((p) => p.name === '@hypaware/goose')?.config, { enabled: false })
})

test('adding goose to a config with another client leaves that client unchanged', async () => {
  const catalog = await realCatalog()
  const existing = composeSetup(catalog, ['hermes'])
  const hermes = existing.plugins?.find((p) => p.name === '@hypaware/hermes')
  assert.ok(hermes)
  hermes.config = { enabled: false, poll_interval: '45s' }
  const priorHermes = structuredClone(hermes)

  const added = composeSetup(catalog, ['hermes', 'goose'], structuredClone(existing))
  assert.deepEqual(added.plugins?.find((p) => p.name === '@hypaware/hermes'), priorHermes)
  assert.ok(added.plugins?.some((p) => p.name === '@hypaware/goose'))
  // Both rows share one gateway entry; goose adds no upstream.
  assert.equal(added.plugins?.filter((p) => p.name === '@hypaware/ai-gateway').length, 1)
})
