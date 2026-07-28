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

test('openclaw alone composes the gateway + anthropic upstream + openclaw adapter', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['openclaw']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [ANTHROPIC] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/openclaw' },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

// Hermes proxies nothing, but its manifest requires the ai-gateway plugin
// (shared materializer), so its row sets `requires_gateway` with no
// upstream: picked alone, the gateway plugin is present with an empty
// upstream list, which `compileUpstreams` accepts.
test('hermes alone composes the gateway (no upstreams) + hermes adapter', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['hermes']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/hermes' },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('claude + hermes share the gateway; hermes adds no upstream', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude', 'hermes']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [ANTHROPIC] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
      { name: '@hypaware/hermes' },
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

// Regression (neutral review of PR #375): the real bundled claude/codex
// picker rows must carry the `settings_file` detect probe the retired
// `DETECTABLE_CLIENT_SOURCES` table used, so `detectPickerSources` still
// pre-checks them. The detect.test.js fixture supplies its own probes, so
// it cannot catch a manifest that ships without one; this asserts the real
// manifests directly (LLP 0136 T2/T6: detection must stay byte-identical).
test('real claude/codex picker rows carry the settings_file detect probe', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(d.get('claude')?.detect, { settings_file: '.claude/settings.json' })
  assert.deepEqual(d.get('codex')?.detect, { settings_file: '.codex/config.toml' })
})

// openclaw/hermes detect via the same home-relative `settings_file` shape
// (parent-dir-exists on `~/.openclaw` / `~/.hermes`, `$OPENCLAW_HOME` /
// `$HERMES_HOME` overrides honored). Hermes deliberately does not use the
// `path` probe: its literal is absolute-only, which a static manifest
// cannot express for a home-relative directory.
test('real openclaw/hermes picker rows carry the settings_file detect probe', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(d.get('openclaw')?.detect, { settings_file: '.openclaw/openclaw.json' })
  assert.deepEqual(d.get('hermes')?.detect, { settings_file: '.hermes/state.db' })
})

// Regression (neutral review of PR #375): every bundled plugin manifest
// must pass validation. `discoverBundledPlugins` routes an invalid
// manifest to `.failed` (a warning, not a boot error), so a manifest that
// fails validation silently drops the whole plugin - all its commands and
// picker rows - while tests built on hand-written fixtures still pass. A
// claude-desktop picker row shipped without its required `name` slipped
// through exactly this way. Assert the real bundled set has zero failures.
test('no bundled plugin manifest fails validation', async () => {
  const bundled = await discoverBundledPlugins()
  assert.deepEqual(
    bundled.failed,
    [],
    `bundled manifests failed validation: ${bundled.failed.map((f) => `${f.manifestPath}: ${f.message}`).join('; ')}`
  )
})

// Regression: the Claude Desktop row shipped a `needs_setup` /
// `configure_command` pair with NO `compose` block, so ticking it in
// `hyp init` wrote a config containing none of its plugins. The configure
// phase then ran `claude-desktop install` against a config the command was
// not in, exiting nonzero, and the drop-on-failure catch-up hint
// (`hyp claude-desktop install`) failed identically forever. A row whose
// configure_command cannot resolve in the config the row itself produced is
// a dead end, not an error, which is why this is pinned here rather than
// left to the wizard tests.
// @ref LLP 0139#compose-the-whole-dependency-set [tests]: the Desktop row composes both plugins its configure_command needs
test('claude-desktop composes the gateway, the credential plugin, and its own adapter', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude-desktop']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787', upstreams: [ANTHROPIC] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/claude-account', config: { mode: 'subscription' } },
      { name: '@hypaware/claude-desktop' },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

// `@hypaware/claude-desktop`'s manifest requires the
// `hypaware.anthropic-credential` capability, which only
// `@hypaware/claude-account` provides. Composing the adapter without the
// credential plugin activates neither: the plugin fails its
// `requireCapability` call, so its commands never register and the
// dispatcher reports `unknown command 'claude-desktop status'` rather than
// the capability gap. Half a dependency set is worse than none.
test('the claude-desktop row composes its required-capability provider, not just its adapter', async () => {
  const d = await realPickerDescriptors()
  const names = (compose(d, ['claude-desktop']).plugins ?? []).map((p) => p.name)
  assert.ok(names.includes('@hypaware/claude-desktop'), 'composes the adapter')
  assert.ok(names.includes('@hypaware/claude-account'), 'composes the credential capability provider')
  assert.ok(
    names.indexOf('@hypaware/claude-account') < names.indexOf('@hypaware/claude-desktop'),
    'the provider precedes the consumer'
  )
})

// The Desktop row and the Claude Code row both want the anthropic upstream.
// The fold dedupes by name, so picking both must not double it.
test('claude + claude-desktop share one anthropic upstream and one gateway', async () => {
  const d = await realPickerDescriptors()
  const config = compose(d, ['claude', 'claude-desktop'])
  const gateways = (config.plugins ?? []).filter((p) => p.name === '@hypaware/ai-gateway')
  assert.equal(gateways.length, 1)
  assert.deepEqual(/** @type {any} */ (gateways[0].config).upstreams, [ANTHROPIC])
})

// A `needs_setup` row promises the wizard will run a setup command for it.
// If that command's plugin is not in the composed config, the promise
// cannot be kept. Guards every future row, not just Desktop's.
// @ref LLP 0139#compose-the-whole-dependency-set [tests]: a needs_setup row must compose the plugin owning its configure_command
test('every needs_setup picker row composes the plugin that owns its configure_command', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  for (const descriptor of catalog.pickerDescriptors.values()) {
    if (descriptor.needsSetup !== true) continue
    const config = compose(catalog.pickerDescriptors, [/** @type {any} */ (descriptor.id)])
    const names = (config.plugins ?? []).map((p) => p.name)
    assert.ok(
      names.includes(descriptor.plugin),
      `picker row '${descriptor.id}' declares configure_command `
      + `'${descriptor.configureCommand}' but composes no ${descriptor.plugin}, `
      + 'so that command cannot resolve in the config the row produces'
    )
  }
})
