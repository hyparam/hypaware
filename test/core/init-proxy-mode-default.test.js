// @ts-check

/**
 * @import { PickerDescriptor } from '../../src/core/types.js'
 * @import { PickerSource } from '../../src/core/cli/types.js'
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { composePickerConfig } from '../../src/core/cli/walkthrough.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { compileConfig } from '../../hypaware-core/plugins-workspace/ai-gateway/src/config.js'
import { activate as activateClaude } from '../../hypaware-core/plugins-workspace/claude/src/index.js'

/**
 * @ref LLP 0262#injection [tests]: Claude's sanctioned OTEL attach does not
 * require gateway proxy mode, so no picker combination silently mints a CA.
 */

/** @returns {Promise<Map<string, PickerDescriptor>>} */
async function realPickerDescriptors() {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  return catalog.pickerDescriptors
}

/**
 * @param {{ plugins?: { name: string, config?: unknown }[] }} config
 * @returns {Record<string, unknown>}
 */
function gatewaySlice(config) {
  const entry = (config.plugins ?? []).find((p) => p.name === '@hypaware/ai-gateway')
  assert.ok(entry, 'config must include the ai-gateway plugin')
  return /** @type {Record<string, unknown>} */ (entry.config ?? {})
}

test('the picker fold leaves gateway proxy mode off for every client combination', async () => {
  const descriptors = await realPickerDescriptors()
  const compose = (/** @type {PickerSource[]} */ sources) => composePickerConfig({
    sources,
    descriptors,
    exportChoice: 'local-parquet',
    retentionDays: 30,
    hypHome: '/home/tester/.hyp',
  })

  for (const sources of [
    ['claude'],
    ['claude', 'codex'],
    ['claude', 'otel'],
    ['codex'],
    ['raw-anthropic'],
    ['hermes'],
  ]) {
    const slice = gatewaySlice(compose(/** @type {PickerSource[]} */ (sources)))
    assert.equal(compileConfig(slice).proxyMode, false, `picker(${sources.join('+')})`)
  }
})

test('the claude-and-otel-local preset omits proxy_mode', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-init-proxy-default-'))
  try {
    /** @type {any} */
    let preset
    /** @type {any} */
    const ctx = {
      env: { HYP_HOME: hypHome, HOME: hypHome },
      paths: { stateDir: path.join(hypHome, 'state') },
      plugin: { version: '0.0.0-test' },
      configRegistry: { registerSection() {} },
      requireCapability: () => ({
        registerUpstreamPreset() {},
        registerExchangeProjector() {},
        registerSettlementEnricher() {},
        registerClient() {},
      }),
      backfills: { register() {} },
      commands: { register() {} },
      skills: { register() {} },
      agents: { register() {} },
      query: { registerDataset() {} },
      initPresets: { register(/** @type {any} */ p) { preset = p } },
    }
    await activateClaude(ctx)
    assert.ok(preset, 'claude activate() registered the init preset')

    /** @type {string[]} */
    const out = []
    const buf = { write(/** @type {string} */ s) { out.push(s) } }
    const code = await preset.run([], { env: ctx.env, stdout: buf, stderr: buf })
    assert.equal(code, 0, out.join(''))

    const written = JSON.parse(
      await fs.readFile(path.join(hypHome, 'hypaware-config.json'), 'utf8')
    )
    const slice = gatewaySlice(written)
    assert.equal(slice.proxy_mode, undefined)
    assert.equal(compileConfig(slice).proxyMode, false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
