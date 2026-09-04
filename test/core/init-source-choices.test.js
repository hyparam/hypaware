// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { INIT_CLIENT_CHOICES, INIT_SOURCE_CHOICES, resolveInitSources } from '../../src/core/commands/init.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

/**
 * @import { InitFlags } from '../../src/core/cli/types.js'
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
// plugin contributes a client is a `--client` value unless it is named here,
// and the one name here is the open question the branch deliberately leaves
// open: whether OpenClaw belongs in `--client` at all. Adding a client row
// now forces that answer instead of silently repeating the gap.
const CLIENT_ROWS_WITHOUT_A_FLAG = new Set(['openclaw'])

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
