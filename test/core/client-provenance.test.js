// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyClientProvenance } from '../../src/core/cli/wizard/provenance.js'

/**
 * @import { HypAwareV2Config } from '../../hypaware-plugin-kernel-types.js'
 */

// `classifyClientProvenance` is shared, correctness-critical plumbing: the
// pick phase's row locking, the `hyp status` syncing/local-only split, and
// the export seam's source-scoped withhold set all derive from this one
// three-way read (LLP 0132 #rule). Test the classification directly.
// @ref LLP 0132#rule [tests]:

/**
 * Build a catalog stub with just the two descriptor maps the classifier
 * reads. `pickerRows` and `clientRows` are `{ id: plugin }` records.
 *
 * @param {{ pickerRows?: Record<string, string>, clientRows?: Record<string, string> }} args
 */
function catalog({ pickerRows = {}, clientRows = {} }) {
  /** @type {Map<string, { plugin: string, id: string, label: string }>} */
  const pickerDescriptors = new Map()
  for (const [id, plugin] of Object.entries(pickerRows)) {
    pickerDescriptors.set(id, { plugin, id, label: id })
  }
  /** @type {Map<string, { plugin: string, name: string, skillDir: string }>} */
  const clientDescriptors = new Map()
  for (const [name, plugin] of Object.entries(clientRows)) {
    clientDescriptors.set(name, { plugin, name, skillDir: `/${name}` })
  }
  return { pickerDescriptors, clientDescriptors }
}

/**
 * @param {string[]} plugins
 * @returns {HypAwareV2Config | null}
 */
function cfg(plugins) {
  return plugins.length > 0
    ? /** @type {any} */ ({ version: 2, plugins: plugins.map((name) => ({ name })) })
    : null
}

/**
 * @param {string[]} centralPlugins
 * @param {string[]} effectivePlugins
 */
function layered(centralPlugins, effectivePlugins) {
  return { centralConfig: cfg(centralPlugins), effective: cfg(effectivePlugins) }
}

test("'central': the owning plugin is declared by the central layer", () => {
  const cat = catalog({ pickerRows: { claude: '@hypaware/claude' } })
  const lc = layered(['@hypaware/claude'], ['@hypaware/claude', '@hypaware/otel'])
  assert.equal(classifyClientProvenance('claude', lc, cat), 'central')
})

test("'local': in the effective config but not in the central layer", () => {
  const cat = catalog({ pickerRows: { codex: '@hypaware/codex' } })
  // Central declares claude only; codex was added to the local layer.
  const lc = layered(['@hypaware/claude'], ['@hypaware/claude', '@hypaware/codex'])
  assert.equal(classifyClientProvenance('codex', lc, cat), 'local')
})

test("'absent': the owning plugin is not in the effective config at all", () => {
  const cat = catalog({ pickerRows: { hermes: '@hypaware/hermes' } })
  const lc = layered(['@hypaware/claude'], ['@hypaware/claude'])
  assert.equal(classifyClientProvenance('hermes', lc, cat), 'absent')
})

test("'absent': a source id that resolves to no plugin (conservative default)", () => {
  const cat = catalog({ pickerRows: { claude: '@hypaware/claude' } })
  const lc = layered(['@hypaware/claude'], ['@hypaware/claude'])
  assert.equal(classifyClientProvenance('unknown-source', lc, cat), 'absent')
})

test('resolution falls back to clientDescriptors when no picker row matches', () => {
  // No picker row for `codex`, only a client descriptor: still resolves.
  const cat = catalog({ clientRows: { codex: '@hypaware/codex' } })
  const lc = layered(['@hypaware/codex'], ['@hypaware/codex'])
  assert.equal(classifyClientProvenance('codex', lc, cat), 'central')
})

test('picker descriptors are authoritative over a same-named client descriptor', () => {
  // Same id in both maps but owned by different plugins: the picker row wins.
  const cat = catalog({
    pickerRows: { claude: '@hypaware/claude' },
    clientRows: { claude: '@hypaware/claude-legacy' },
  })
  // Central declares the picker's plugin, not the client descriptor's.
  const lc = layered(['@hypaware/claude'], ['@hypaware/claude'])
  assert.equal(classifyClientProvenance('claude', lc, cat), 'central')
})

test('a solo host (no central layer) classifies every present source as local', () => {
  // No central layer: membership-in-effective, not-in-central -> 'local'.
  // The managed-machine gate (there is a central layer) is a consumer's job,
  // so a solo host's sources are still forwarded despite the 'local' label.
  const cat = catalog({ pickerRows: { claude: '@hypaware/claude' } })
  const lc = layered([], ['@hypaware/claude'])
  assert.equal(classifyClientProvenance('claude', lc, cat), 'local')
})

test('a present-but-central source stays central even when central also enables it', () => {
  const cat = catalog({ pickerRows: { claude: '@hypaware/claude' } })
  const lc = layered(['@hypaware/claude'], ['@hypaware/claude'])
  assert.equal(classifyClientProvenance('claude', lc, cat), 'central')
})

test('empty layered config: an in-catalog source with no config is absent', () => {
  const cat = catalog({ pickerRows: { claude: '@hypaware/claude' } })
  const lc = layered([], [])
  assert.equal(classifyClientProvenance('claude', lc, cat), 'absent')
})
