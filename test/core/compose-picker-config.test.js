// @ts-check

/**
 * @import { PickerDescriptor } from '../../src/core/types.js'
 * @import { PickerSource, PickerExport } from '../../src/core/cli/types.js'
 * @import { HypAwareV2Config } from '../../hypaware-plugin-kernel-types.js'
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { composePickerConfig, ridersInDefaultSet } from '../../src/core/cli/walkthrough.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { resolvePickSeeding } from '../../src/core/cli/wizard/pick.js'

// The picker table is manifest-sourced now (LLP 0130). These tests pin
// the exact config shape `composePickerConfig` emitted from the retired
// hardcoded wantsAnthropic/wantsCodex switch, proving the descriptor fold
// reproduces it byte-for-byte from the real bundled plugin manifests.
// One deliberate divergence from that switch: the gateway slice carries no
// `listen`, so LLP 0114's fixed default and its default-only EADDRINUSE
// fallback both apply to a wizard-created install.

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

test('claude alone composes the gateway writer with no proxy upstream plus the claude adapter', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude']), {
    version: 2,
    plugins: [
      // @ref LLP 0262#capture [tests]: Claude OTEL still uses the gateway projection capability, not its proxy route
      { name: '@hypaware/ai-gateway', config: { upstreams: [] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/claude' },
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
      { name: '@hypaware/ai-gateway', config: { upstreams: [OPENAI, CHATGPT] } },
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
      { name: '@hypaware/ai-gateway', config: { upstreams: [ANTHROPIC] } },
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
      { name: '@hypaware/ai-gateway', config: { upstreams: [OPENAI] } },
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
      { name: '@hypaware/ai-gateway', config: { upstreams: [ANTHROPIC] } },
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
      { name: '@hypaware/ai-gateway', config: { upstreams: [] } },
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
      { name: '@hypaware/ai-gateway', config: { upstreams: [] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/claude' },
      { name: '@hypaware/hermes' },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('claude + codex compose only the upstreams codex still routes through the gateway', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude', 'codex']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { upstreams: [OPENAI, CHATGPT] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/claude' },
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
      { name: '@hypaware/ai-gateway', config: { upstreams: [ANTHROPIC, OPENAI, CHATGPT] } },
      { name: '@hypaware/otel', config: { listen_host: '127.0.0.1', listen_port: 4318 } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/claude' },
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
      { name: '@hypaware/ai-gateway', config: { upstreams: [] } },
      { name: '@hypaware/claude' },
    ],
    query: QUERY,
  })
})

test('configure-later export behaves like keep-local (no sinks block)', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude'], 'configure-later'), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { upstreams: [] } },
      { name: '@hypaware/claude' },
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

// @ref LLP 0358#onboarding [tests]: Desktop composes the scheduled reader and
// ownership adapter, with no credential provider or routed upstream.
test('claude-desktop composes transcript capture without the credential plugin', async () => {
  const d = await realPickerDescriptors()
  assert.deepEqual(compose(d, ['claude-desktop']), {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { upstreams: [] } },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/claude' },
      { name: '@hypaware/claude-desktop' },
    ],
    query: QUERY,
    sinks: LOCAL_SINK,
  })
})

test('the claude-desktop row composes the reader before its ownership adapter', async () => {
  const d = await realPickerDescriptors()
  const names = (compose(d, ['claude-desktop']).plugins ?? []).map((p) => p.name)
  assert.ok(names.includes('@hypaware/claude-desktop'), 'composes the adapter')
  assert.ok(names.includes('@hypaware/claude'), 'composes the scheduled transcript reader')
  assert.ok(!names.includes('@hypaware/claude-account'), 'does not compose a credential')
  assert.ok(
    names.indexOf('@hypaware/claude') < names.indexOf('@hypaware/claude-desktop'),
    'the reader precedes the ownership adapter'
  )
})

test('claude + claude-desktop share one reader and one gateway', async () => {
  const d = await realPickerDescriptors()
  const config = compose(d, ['claude', 'claude-desktop'])
  const gateways = (config.plugins ?? []).filter((p) => p.name === '@hypaware/ai-gateway')
  const readers = (config.plugins ?? []).filter((p) => p.name === '@hypaware/claude')
  assert.equal(gateways.length, 1)
  assert.equal(readers.length, 1)
  assert.deepEqual(/** @type {any} */ (gateways[0].config).upstreams, [])
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

// --- riders (`compose_with`, LLP 0213 #d1) -----------------------------------

/**
 * The real catalog, descriptors and riders together, so these tests fold
 * the manifests as shipped rather than a fixture of them.
 *
 * @returns {Promise<{ descriptors: Map<string, PickerDescriptor>, composeWith: Map<string, string[]> }>}
 */
async function realCatalog() {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  return {
    descriptors: catalog.pickerDescriptors,
    composeWith: catalog.composeWith ?? new Map(),
  }
}

/**
 * @param {{ descriptors: Map<string, PickerDescriptor>, composeWith: Map<string, string[]> }} catalog
 * @param {PickerSource[]} sources
 * @param {HypAwareV2Config} [existing]
 */
function composeWithRiders(catalog, sources, existing) {
  return composePickerConfig({
    sources,
    descriptors: catalog.descriptors,
    exportChoice: 'local-parquet',
    retentionDays: RETENTION,
    hypHome: HYP_HOME,
    composeWith: catalog.composeWith,
    ...(existing ? { existing } : {}),
  })
}

const GRAPH_PLUGINS = ['@hypaware/context-graph', '@hypaware/ai-gateway-graph']

// The whole point of LLP 0213: a default install has the graph without ever
// being asked about it, because the graph rides the gateway it derives from.
// @ref LLP 0213#d1 [tests]: derived-data plugins ride a pick rather than contributing one
test('picking a gateway client composes the graph pair with it', async () => {
  const catalog = await realCatalog()
  const names = (composeWithRiders(catalog, ['claude']).plugins ?? []).map((p) => p.name)
  for (const rider of GRAPH_PLUGINS) {
    assert.ok(names.includes(rider), `expected ${rider} to ride the gateway pick`)
  }
})

// The engine is not composed alone: an install with no gateway has no
// contract to project, and a node/edge table that can never fill reads as
// breakage rather than as an empty graph.
test('a gateway-free pick composes neither graph plugin', async () => {
  const catalog = await realCatalog()
  const config = composeWithRiders(catalog, ['otel'])
  const names = (config.plugins ?? []).map((p) => p.name)
  assert.ok(!names.includes('@hypaware/ai-gateway'), 'otel alone needs no gateway')
  for (const rider of GRAPH_PLUGINS) {
    assert.ok(!names.includes(rider), `${rider} must not appear without the gateway it rides`)
  }
})

// Riders are composer-managed, so they live and die by the picks like any
// composed plugin (LLP 0183 #carry-forward). A reconfigure that drops the
// gateway drops them too, rather than stranding them in a config whose
// gateway just went away.
// @ref LLP 0213#stranding [tests]: unpicking the gateway drops the riders it carried
test('a reconfigure that unpicks the gateway drops the graph pair', async () => {
  const catalog = await realCatalog()
  const before = composeWithRiders(catalog, ['claude'])
  assert.ok((before.plugins ?? []).some((p) => p.name === '@hypaware/context-graph'))

  const after = composeWithRiders(catalog, ['otel'], before)
  const names = (after.plugins ?? []).map((p) => p.name)
  for (const rider of GRAPH_PLUGINS) {
    assert.ok(!names.includes(rider), `${rider} should be dropped with the pick that carried it`)
  }
})

// A hand-added plugin the composer never chose is passed through untouched
// (LLP 0183). That must stay true of a plugin outside the rider set, so the
// rider rule does not quietly widen what a reconfigure is entitled to drop.
test('a hand-added non-rider plugin survives a reconfigure that composes riders', async () => {
  const catalog = await realCatalog()
  const existing = composeWithRiders(catalog, ['claude'])
  existing.plugins = [...(existing.plugins ?? []), { name: '@hypaware/gascity' }]

  const after = composeWithRiders(catalog, ['claude'], existing)
  const names = (after.plugins ?? []).map((p) => p.name)
  assert.ok(names.includes('@hypaware/gascity'), 'hand-added plugins are not the composer\'s to drop')
  assert.ok(names.includes('@hypaware/context-graph'), 'and the riders are still composed')
})

// Riders resolve to a fixpoint, so a manifest may ride a plugin that is
// itself a rider without the manifests needing an ordering convention.
test('a rider that rides another rider still composes', async () => {
  const catalog = await realCatalog()
  const composeWith = new Map(catalog.composeWith)
  composeWith.set('@hypaware/test-second-order', ['@hypaware/context-graph'])
  const config = composePickerConfig({
    sources: /** @type {PickerSource[]} */ (['claude']),
    descriptors: catalog.descriptors,
    exportChoice: 'local-parquet',
    retentionDays: RETENTION,
    hypHome: HYP_HOME,
    composeWith,
  })
  const names = (config.plugins ?? []).map((p) => p.name)
  assert.ok(names.includes('@hypaware/test-second-order'), 'the second-order rider lands too')
})

// Without a composeWith map nothing rides anything: the fold composes
// exactly what the picks name, which is what every pre-LLP-0213 caller and
// test in this file relies on.
test('no composeWith map means no riders', async () => {
  const d = await realPickerDescriptors()
  const names = (compose(d, ['claude']).plugins ?? []).map((p) => p.name)
  for (const rider of GRAPH_PLUGINS) {
    assert.ok(!names.includes(rider), `${rider} must not appear when no riders are supplied`)
  }
})

// Regression (neutral review of PR #720, finding A): a rider has no picker
// row by design (LLP 0213 #derived-data-plugins), so `enabled: false` in the
// config is the only way its owner can decline it. The pick-implies-enabled
// rule in `mergePlugin` must not reach it: deleting the flag would make every
// later `hyp init` silently re-enable a plugin the user switched off, which
// is a consent regression, not a tidy-up.
// @ref LLP 0213#derived-data-plugins [tests]: a user's `enabled: false` on a rider survives a reconfigure
test("a user's `enabled: false` on a rider survives a reconfigure", async () => {
  const catalog = await realCatalog()
  const existing = composeWithRiders(catalog, ['claude'])
  existing.plugins = (existing.plugins ?? []).map((p) =>
    p.name === '@hypaware/context-graph' ? { ...p, enabled: false } : p
  )

  const after = composeWithRiders(catalog, ['claude'], existing)
  const graph = (after.plugins ?? []).find((p) => p.name === '@hypaware/context-graph')
  assert.ok(graph, 'the rider entry is still in the config')
  assert.equal(graph.enabled, false, 'and it is still opted out')

  // The opt-out is per plugin: the other half of the pair is untouched.
  const gateway = (after.plugins ?? []).find((p) => p.name === '@hypaware/ai-gateway-graph')
  assert.ok(gateway, 'the un-declined rider is still composed')
  assert.equal(gateway.enabled, undefined, 'and is not switched off with it')
})

// Legacy proxy_mode remains a user-owned key during reconfigure even though
// Claude no longer composes it. This prevents the OTEL migration from turning
// a picker pass into an unrequested cleanup of an existing gateway setting.
test('a hand-written `proxy_mode: false` survives a reconfigure', async () => {
  const catalog = await realCatalog()
  const existing = composeWithRiders(catalog, ['claude'])
  existing.plugins = (existing.plugins ?? []).map((p) =>
    p.name === '@hypaware/ai-gateway'
      ? { ...p, config: { ...(p.config ?? {}), proxy_mode: false } }
      : p
  )

  const after = composeWithRiders(catalog, ['claude'], existing)
  const gateway = (after.plugins ?? []).find((p) => p.name === '@hypaware/ai-gateway')
  assert.ok(gateway?.config)
  assert.equal(gateway.config.proxy_mode, false, 'the decline stays declined')
  assert.deepEqual(gateway.config.upstreams, [], 'while Claude contributes no proxy upstream')
})

test('Claude OTEL composition never adds proxy_mode to fresh or existing gateway entries', async () => {
  const catalog = await realCatalog()
  const existing = composeWithRiders(catalog, ['claude'])
  existing.plugins = (existing.plugins ?? []).map((p) => {
    if (p.name !== '@hypaware/ai-gateway') return p
    const { proxy_mode: _dropped, ...rest } = p.config ?? {}
    return { ...p, config: rest }
  })

  const after = composeWithRiders(catalog, ['claude'], existing)
  const gateway = (after.plugins ?? []).find((p) => p.name === '@hypaware/ai-gateway')
  assert.ok(gateway?.config)
  assert.ok(!('proxy_mode' in gateway.config), 'absence carries forward like a value')

  // A fresh compose has the same OTEL-only answer.
  const fresh = composeWithRiders(catalog, ['claude'])
  const freshGateway = (fresh.plugins ?? []).find((p) => p.name === '@hypaware/ai-gateway')
  assert.equal(freshGateway?.config?.proxy_mode, undefined)
})

// The exception above is scoped to riders. A *picked* plugin still loses a
// stale `enabled: false`, because ticking its row is what asks for it: the
// original reason `mergePlugin` deletes the flag at all.
test('a picked plugin still loses a stale `enabled: false`', async () => {
  const catalog = await realCatalog()
  const existing = composeWithRiders(catalog, ['claude'])
  existing.plugins = (existing.plugins ?? []).map((p) =>
    p.name === '@hypaware/claude' ? { ...p, enabled: false } : p
  )

  const after = composeWithRiders(catalog, ['claude'], existing)
  const claude = (after.plugins ?? []).find((p) => p.name === '@hypaware/claude')
  assert.ok(claude)
  assert.equal(claude.enabled, undefined, 'picking the row is what enables it')
})

// Regression (neutral review of PR #720, finding B): `compose_with` composes
// a plugin with no pick and no prompt, so an excluded plugin declaring it
// would be a way around `V1_EXCLUDED_FROM_DEFAULT` - the boundary that keeps
// an API-backed embedder or a credential-holding plugin off a machine until
// its owner names it. `ridersInDefaultSet` drops every excluded rider
// before composition ever sees them.
//
// This pins the filter itself. The test below it pins the caller, which is
// the half that actually broke: see its comment.
// @ref LLP 0213#d1 [tests]: riding a pick is not a route around the explicit-opt-in boundary
test('an excluded plugin declaring compose_with is not composed', async () => {
  const bundled = await discoverBundledPlugins()
  assert.ok(bundled.excluded.length > 0, 'the excluded set is non-empty')

  // Stage the one-line manifest edit the filter exists to defeat: an
  // excluded plugin declaring it rides the gateway.
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const descriptors = catalog.pickerDescriptors
  const raw = new Map(catalog.composeWith ?? new Map())
  const smuggled = bundled.excluded[0].manifest.name
  raw.set(smuggled, ['@hypaware/ai-gateway'])
  assert.ok(
    composedNames({ descriptors, composeWith: raw }, ['claude']).includes(smuggled),
    'unfiltered, the excluded plugin really would ride the gateway pick'
  )

  const filtered = ridersInDefaultSet(raw)
  assert.ok(!filtered.has(smuggled), `${smuggled} is excluded from default, so it may not ride`)
  assert.ok(
    !composedNames({ descriptors, composeWith: filtered }, ['claude']).includes(smuggled),
    'and it is not composed'
  )

  // The filter is a boundary check, not a blanket one: the graph pair is
  // allowlisted, so it still rides.
  for (const rider of GRAPH_PLUGINS) {
    assert.ok(filtered.has(rider), `${rider} is default-activated and still rides`)
  }
})

// Regression (neutral review of PR #720 round 2, finding 1): the round-1
// fix put the filter inside `loadPickerCatalog`, which `resolvePickSeeding`
// only reaches when no catalog is injected - and `runInitWizard`, the
// shipped `hyp init` entry point, ALWAYS injects one, built by
// `loadWizardCatalog` from the loaded *and* excluded manifests. So the
// boundary held on the legacy walkthrough and not on the path that ships.
//
// A unit test of `ridersInDefaultSet` cannot catch a caller that never
// calls it, which is why this one goes through `resolvePickSeeding` with an
// injected catalog and asserts on what composition actually receives.
// @ref LLP 0213#d1 [tests]: no catalog source routes around the explicit-opt-in boundary
test('an injected catalog cannot smuggle an excluded rider through resolvePickSeeding', async () => {
  const bundled = await discoverBundledPlugins()
  assert.ok(bundled.excluded.length > 0, 'the excluded set is non-empty')

  // `loadWizardCatalog`'s own read, verbatim: loaded plus excluded, with
  // the one-line manifest edit the filter exists to defeat staged on it.
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const smuggled = bundled.excluded[0].manifest.name
  catalog.composeWith = new Map(catalog.composeWith ?? new Map())
  catalog.composeWith.set(smuggled, ['@hypaware/ai-gateway'])
  assert.ok(
    composedNames({ descriptors: catalog.pickerDescriptors, composeWith: catalog.composeWith }, ['claude'])
      .includes(smuggled),
    'unfiltered, the injected catalog really would ride the excluded plugin onto the gateway pick'
  )

  const seeding = await resolvePickSeeding(/** @type {any} */ ({
    stdout: { write() {} },
    stderr: { write() {} },
    env: {},
    catalog,
    picks: { sources: ['claude'], exportChoice: 'local-parquet', retentionDays: RETENTION },
  }))

  assert.ok(!seeding.composeWith.has(smuggled), `${smuggled} is excluded from default, so it may not ride`)
  const names = composedNames(
    { descriptors: seeding.descriptors, composeWith: seeding.composeWith },
    ['claude']
  )
  assert.ok(!names.includes(smuggled), 'and it does not reach the composed config')

  // Still a boundary check, not a blanket one: the graph pair rides.
  for (const rider of GRAPH_PLUGINS) {
    assert.ok(names.includes(rider), `${rider} is default-activated and still rides`)
  }
})

// No bundled manifest may declare `compose_with` from outside the
// default-activated set. Guards every future manifest, not just today's two.
test('no excluded bundled manifest declares compose_with', async () => {
  const bundled = await discoverBundledPlugins()
  for (const entry of bundled.excluded) {
    assert.equal(
      entry.manifest.compose_with,
      undefined,
      `${entry.manifest.name} is excluded from default but declares compose_with, `
      + 'which would compose it with no pick and no prompt'
    )
  }
})

/**
 * The plugin names one catalog composes for the given picks.
 *
 * @param {{ descriptors: Map<string, PickerDescriptor>, composeWith: Map<string, string[]> }} catalog
 * @param {PickerSource[]} sources
 * @returns {string[]}
 */
function composedNames(catalog, sources) {
  return (composeWithRiders(catalog, sources).plugins ?? []).map((p) => p.name)
}
