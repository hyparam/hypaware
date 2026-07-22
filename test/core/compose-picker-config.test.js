// @ts-check

/**
 * @import { PickerDescriptor } from '../../src/core/types.js'
 * @import { PickerSource, PickerExport } from '../../src/core/cli/types.js'
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { composePickerConfig } from '../../src/core/cli/walkthrough.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'

// The picker table is manifest-sourced now (LLP 0130). These tests pin
// the exact config shape `composePickerConfig` emitted from the retired
// hardcoded wantsAnthropic/wantsCodex switch, proving the descriptor fold
// reproduces it byte-for-byte from the real bundled plugin manifests.

const HYP_HOME = '/home/tester/.hyp'
const RETENTION = 30

/** @returns {Promise<Map<string, PickerDescriptor>>} */
async function realPickerDescriptors() {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  return catalog.pickerDescriptors
}

/**
 * @param {Map<string, PickerDescriptor>} descriptors
 * @param {PickerSource[]} sources
 * @param {PickerExport} [exportChoice]
 */
function compose(descriptors, sources, exportChoice = 'local-parquet') {
  return composePickerConfig({ sources, descriptors, exportChoice, retentionDays: RETENTION, hypHome: HYP_HOME })
}

const ANTHROPIC = { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages', provider: 'anthropic' }
const OPENAI = { name: 'openai', base_url: 'https://api.openai.com', path_prefix: '/v1', provider: 'openai' }
const CHATGPT = { name: 'chatgpt', base_url: 'https://chatgpt.com', path_prefix: '/backend-api/codex', provider: 'chatgpt' }

const LOCAL_SINK = {
  local: {
    writer: '@hypaware/format-parquet',
    destination: '@hypaware/local-fs',
    config: { dir: path.join(HYP_HOME, 'exports'), schedule: '*/5 * * * *' },
  },
}

const QUERY = { cache: { retention: { default_days: RETENTION } } }

test('claude alone composes the gateway + anthropic upstream + claude adapter', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [ANTHROPIC] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('codex alone composes the gateway + openai + chatgpt upstreams + codex adapter', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['codex']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [OPENAI, CHATGPT] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/codex', config: { proxy: '@hypaware/ai-gateway' } },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('raw-anthropic alone composes only the gateway + anthropic upstream (no adapter plugin)', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['raw-anthropic']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [ANTHROPIC] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('raw-openai alone composes only the gateway + openai upstream (no chatgpt, no adapter plugin)', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['raw-openai']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [OPENAI] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('otel alone composes the otel receiver, no gateway', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['otel']), {
    version: 2,
    plugins: [
      { name: '@hypaware/otel', config: { listen_host: '127.0.0.1', listen_port: 4318 } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('claude + codex union the anthropic/openai/chatgpt upstreams and both adapters', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude', 'codex']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [ANTHROPIC, OPENAI, CHATGPT] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
      { name: '@hypaware/codex', config: { proxy: '@hypaware/ai-gateway' } },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('all five sources dedupe upstreams by name and order otel before the export sinks', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude', 'codex', 'raw-anthropic', 'raw-openai', 'otel']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [ANTHROPIC, OPENAI, CHATGPT] } },
      { name: '@hypaware/otel', config: { listen_host: '127.0.0.1', listen_port: 4318 } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
      { name: '@hypaware/codex', config: { proxy: '@hypaware/ai-gateway' } },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('no sources picked still writes a valid config with just the export sinks', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, []), {
    version: 2,
    plugins: [
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('keep-local export omits the sink plugins and sinks block', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude'], 'keep-local'), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [ANTHROPIC] } },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
    ],
    query: QUERY,
  })
})

test('configure-later export behaves like keep-local (no sinks block)', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude'], 'configure-later'), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [ANTHROPIC] } },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
    ],
    query: QUERY,
  })
})
