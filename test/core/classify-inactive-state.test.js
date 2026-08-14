// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyInactiveState } from '../../src/core/cli/dispatch.js'

/**
 * Build a hand-rolled fixture matching the `resolveLayeredConfigFromDisk`
 * return shape, filling in the properties `classifyInactiveState` does not
 * read with values that satisfy the type without meaning anything.
 *
 * @import { HypAwareV2Config } from '../../hypaware-plugin-kernel-types.js'
 * @param {{ effective: HypAwareV2Config, centralConfig: HypAwareV2Config | null }} args
 */
function makeLayered({ effective, centralConfig }) {
  return {
    effective,
    centralConfig,
    localConfig: null,
    centralConfigPath: null,
    localLoaded: null,
    centralLoaded: null,
    drops: [],
    centralQueryIgnored: false,
  }
}

test('classifyInactiveState returns absent when the entry is missing from the effective config', () => {
  const layered = makeLayered({
    effective: { version: 2, plugins: [] },
    centralConfig: null,
  })
  assert.equal(classifyInactiveState(layered, '@hypaware/context-graph'), 'absent')
})

test('classifyInactiveState returns disabled-local when the disabled entry exists only in the local layer', () => {
  const layered = makeLayered({
    effective: { version: 2, plugins: [{ name: '@hypaware/context-graph', enabled: false }] },
    centralConfig: null,
  })
  assert.equal(classifyInactiveState(layered, '@hypaware/context-graph'), 'disabled-local')
})

test('classifyInactiveState returns disabled-central when the disabled entry also names the plugin centrally', () => {
  const layered = makeLayered({
    effective: { version: 2, plugins: [{ name: '@hypaware/context-graph', enabled: false }] },
    centralConfig: { version: 2, plugins: [{ name: '@hypaware/context-graph', enabled: false }] },
  })
  assert.equal(classifyInactiveState(layered, '@hypaware/context-graph'), 'disabled-central')
})
