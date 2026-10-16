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
import { DEFAULT_GATEWAY_ENDPOINT } from '../../src/core/config/gateway_endpoint.js'

/**
 * @ref LLP 0114#init-writes-no-listen [tests]: `hyp init` must leave `listen`
 * unset so the fixed default applies AND the default-only EADDRINUSE fallback
 * stays armed. A wizard that writes the port looks, to `compileConfig`, exactly
 * like a user who stated a port requirement, which routes a fresh install into
 * the #explicit-listen-fails-loudly branch it never asked for.
 */

const DEFAULT_LISTEN = '127.0.0.1:18521'

/** @returns {Promise<Map<string, PickerDescriptor>>} */
async function realPickerDescriptors() {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  return catalog.pickerDescriptors
}

/**
 * @param {Map<string, PickerDescriptor>} descriptors
 * @param {PickerSource[]} sources
 */
function compose(descriptors, sources) {
  return composePickerConfig({
    sources,
    descriptors,
    exportChoice: 'local-parquet',
    retentionDays: 30,
    hypHome: '/home/tester/.hyp',
  })
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

/** Buffer standing in for a CLI stream. */
function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    write(/** @type {string} */ s) { chunks.push(s) },
    text() { return chunks.join('') },
  }
}

test("core's default gateway endpoint tracks the ai-gateway plugin's DEFAULT_LISTEN", () => {
  assert.equal(DEFAULT_GATEWAY_ENDPOINT, `http://${compileConfig({}).listen}`)
})

test('the picker writer leaves the gateway listen unset so the fixed default applies', async () => {
  const descriptors = await realPickerDescriptors()
  for (const sources of [['claude'], ['codex'], ['raw-anthropic'], ['claude', 'codex', 'otel']]) {
    const config = compose(descriptors, /** @type {PickerSource[]} */ (sources))
    const slice = gatewaySlice(config)
    assert.equal(
      Object.hasOwn(slice, 'listen'),
      false,
      `picker(${sources.join('+')}) must not pin a gateway listen address`
    )
    const compiled = compileConfig(slice)
    assert.equal(compiled.listen, DEFAULT_LISTEN)
    assert.equal(compiled.listenConfigured, false)
  }
})

test('the claude-and-otel-local preset leaves the gateway listen unset so the fixed default applies', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-init-listen-'))
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

    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await preset.run([], { env: ctx.env, stdout, stderr })
    assert.equal(code, 0, stderr.text())

    const written = JSON.parse(
      await fs.readFile(path.join(hypHome, 'hypaware-config.json'), 'utf8')
    )
    const slice = gatewaySlice(written)
    assert.equal(
      Object.hasOwn(slice, 'listen'),
      false,
      'the preset must not pin a gateway listen address'
    )
    const compiled = compileConfig(slice)
    assert.equal(compiled.listen, DEFAULT_LISTEN)
    assert.equal(compiled.listenConfigured, false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
