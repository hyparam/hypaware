// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { compileUpstreams, matchUpstream } from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'
import { activate as activateCodex } from '../../hypaware-core/plugins-workspace/codex/src/index.js'
import { activate as activateOpenclaw } from '../../hypaware-core/plugins-workspace/openclaw/src/index.js'
import { resolveDependencies } from '../../src/core/dep_graph.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

/**
 * @import { PluginManifest } from '../../hypaware-plugin-kernel-types.js'
 * @import { UpstreamConfig } from '../../hypaware-core/plugins-workspace/ai-gateway/src/types.js'
 */

/**
 * `registerUpstreamPreset` is a name-keyed last-write-wins `Map.set`
 * (`ai-gateway/src/api.js`), so two adapters that both register `openai`
 * share one slot and the plugin that activates last owns it. Nothing
 * declared that order, and nothing exercised the surviving registration:
 * the shape assertions elsewhere compare literal copies of the presets,
 * which cannot see a collision at all.
 *
 * Two tiers here, and they fail for different reasons on purpose:
 *
 *  - The activation-order tests pin the order the kernel actually derives
 *    from the shipped manifests. A plugin rename, a new `requires.plugins`
 *    edge, or a change to `toposort()`'s tie-break reddens them.
 *  - The routing tests drive the plugins' real `activate()` and compile the
 *    resulting preset table, so they see whichever registration survived.
 *    They pin both halves of the contract: every route that exists today is
 *    unchanged, and a steered turn is routable no matter who won the slot.
 *
 * @ref LLP 0157#requirements [tests]: R5 - an unroutable steered turn is a 404 the user's turn dies on, which capture may never cause
 */

const CODEX = '@hypaware/codex'
const OPENCLAW = '@hypaware/openclaw'
const GATEWAY = '@hypaware/ai-gateway'
const UPSTREAM_HEADER = 'x-hypaware-upstream'

// ---------------------------------------------------------------------------
// Tier 1: the activation order the kernel really derives.
// ---------------------------------------------------------------------------

test('codex activates before openclaw in the real bundled boot order', async () => {
  const manifests = await bundledManifests()
  const resolution = await resolveDependencies(manifests)

  const codexIdx = resolution.order.indexOf(CODEX)
  const openclawIdx = resolution.order.indexOf(OPENCLAW)
  assert.ok(codexIdx >= 0, `${CODEX} is missing from the resolved order`)
  assert.ok(openclawIdx >= 0, `${OPENCLAW} is missing from the resolved order`)
  assert.ok(
    codexIdx < openclawIdx,
    `expected ${CODEX} (index ${codexIdx}) to activate before ${OPENCLAW} (index ${openclawIdx}); ` +
      `order was ${resolution.order.join(', ')}`
  )
})

test('the codex-before-openclaw order does not depend on manifest input order', async () => {
  const manifests = await bundledManifests()
  const trio = [GATEWAY, CODEX, OPENCLAW].map((name) => {
    const found = manifests.find((m) => m.name === name)
    assert.ok(found, `bundled manifest ${name} not found`)
    return found
  })

  for (const input of permutations(trio)) {
    const resolution = await resolveDependencies(input)
    assert.deepEqual(
      resolution.order,
      [GATEWAY, CODEX, OPENCLAW],
      `input order ${input.map((m) => m.name).join(',')} resolved to ${resolution.order.join(',')}`
    )
  }
})

// ---------------------------------------------------------------------------
// Tier 2: the routing table the surviving registrations compile to.
// ---------------------------------------------------------------------------

/**
 * Every route Codex, Claude and OpenClaw traffic uses today. `expect` is the
 * upstream name, or `undefined` for "the gateway answers 404".
 *
 * @type {{ label: string, path: string, headers: Record<string, string[]>, expect: string | undefined }[]}
 */
const ROUTES = [
  { label: 'codex api-key chat completions', path: '/v1/chat/completions', headers: {}, expect: 'openai' },
  { label: 'codex api-key responses', path: '/v1/responses', headers: {}, expect: 'openai' },
  { label: 'openai path anchor itself', path: '/v1', headers: {}, expect: 'openai' },
  // The two sides of the segment boundary `pathMatchesPrefix(path, '/v1')`
  // draws. A `match()` supersedes `path_prefix`, so these pin that the
  // hand-written anchor did not widen or narrow the prefix it replaced.
  { label: 'openai path anchor with a trailing slash', path: '/v1/', headers: {}, expect: 'openai' },
  { label: 'one byte past the openai anchor', path: '/v1x', headers: {}, expect: undefined },
  { label: 'codex chatgpt subscription', path: '/backend-api/codex/responses', headers: {}, expect: 'chatgpt' },
  { label: 'anthropic messages', path: '/v1/messages', headers: {}, expect: 'anthropic' },
  { label: 'anthropic count_tokens', path: '/v1/messages/count_tokens', headers: {}, expect: 'anthropic' },
  {
    label: 'anthropic by header signature off-path',
    path: '/custom',
    headers: { 'anthropic-version': ['2023-06-01'] },
    expect: 'anthropic',
  },
  { label: 'look-alike of the openai prefix', path: '/v1foo', headers: {}, expect: undefined },
  { label: 'unsteered bare chat completions', path: '/chat/completions', headers: {}, expect: undefined },
]

/**
 * The no-change tests below are a `for` loop over `ROUTES`, so an emptied or
 * thinned table asserts nothing and they go green having routed nothing. Pin
 * the coverage the table is supposed to carry separately from walking it, or
 * the guard can be disarmed by deletion alone.
 */
test('the route table still carries the coverage the no-change tests walk', () => {
  assert.ok(ROUTES.length >= 11, `the route table shrank to ${ROUTES.length} routes`)
  for (const expected of ['openai', 'chatgpt', 'anthropic', undefined]) {
    assert.ok(
      ROUTES.some((route) => route.expect === expected),
      `no route expects ${expected ?? '404'}`
    )
  }
  // The `/v1` segment boundary, the Anthropic path the priority hazard aims
  // at, and the bare-origin path only the header rung can route.
  for (const path of ['/v1', '/v1/', '/v1x', '/v1/messages', '/chat/completions']) {
    assert.ok(
      ROUTES.some((route) => route.path === path),
      `no route covers ${path}`
    )
  }
})

for (const order of [[CODEX, OPENCLAW], [OPENCLAW, CODEX]]) {
  test(`existing routes are unchanged when the openai slot is won by activation order ${order.join(' then ')}`, async () => {
    const table = await compiledPresetTable(order)
    for (const route of ROUTES) {
      const matched = matchUpstream(table, 'POST', route.path, route.headers)
      assert.equal(
        matched?.name,
        route.expect,
        `${route.label}: ${route.path} routed to ${matched?.name ?? '404'}`
      )
    }
  })

  test(`a steered openai turn is routable when the openai slot is won by activation order ${order.join(' then ')}`, async () => {
    const table = await compiledPresetTable(order)
    // The steering seam's shadow base URL is the bare gateway origin, so the
    // path carries no `/v1` and only the header rung can route it. Without
    // that rung the gateway answers 404 and the caller's turn dies.
    const matched = matchUpstream(table, 'POST', '/chat/completions', {
      [UPSTREAM_HEADER]: ['openai'],
    })
    assert.equal(matched?.name, 'openai')
    assert.equal(matched?.provider, 'openai')
    assert.equal(matched?.baseUrl.host, 'api.openai.com')
  })
}

test('the header rung does not divert anthropic traffic that never sends it', async () => {
  const table = await compiledPresetTable([CODEX, OPENCLAW])
  const matched = matchUpstream(table, 'POST', '/v1/messages', {
    [UPSTREAM_HEADER]: ['anthropic'],
  })
  assert.equal(matched?.name, 'anthropic')
})

/**
 * `hyp init` writes gateway upstreams from the picker `compose` blocks, which
 * carry no `priority` (`composePickerConfig`), and a config upstream beats a
 * preset of the same name. So an install that declares `anthropic` in config
 * and leaves `openai` to a preset compiles a table where the only thing
 * keeping `/v1/messages` on Anthropic is that `openai` does not outrank it: a
 * `/v1` anchor at `priority: 100` sorts above the config entry and swallows
 * Anthropic's Messages API, prompts and `x-api-key` and all.
 *
 * The assertion runs against whichever registration won the name-keyed slot,
 * under every activation order, because the constant is hazardous wherever it
 * is written. Pinning only the copy in the Codex plugin would let a sibling
 * adapter reintroduce it through the same slot and stay green.
 */
for (const order of [[CODEX], [CODEX, OPENCLAW], [OPENCLAW, CODEX]]) {
  test(`the surviving openai preset does not outrank a config-declared anthropic upstream (${order.join(' then ')})`, async () => {
    const presets = await presetsFromActivate(order)
    const openai = presets.get('openai')
    assert.ok(openai, `activation order ${order.join(',')} registered no \`openai\` upstream preset`)

    /** @type {UpstreamConfig} */
    const configAnthropic = {
      name: 'anthropic',
      base_url: 'https://api.anthropic.com',
      path_prefix: '/v1/messages',
      provider: 'anthropic',
    }
    // The merge the source layer performs: config first, presets filling only
    // the names config left open (`mergeUpstreams`).
    const table = compileUpstreams([configAnthropic, presetAsUpstream(openai)])
    assert.equal(matchUpstream(table, 'POST', '/v1/messages', {})?.name, 'anthropic')
    assert.equal(
      matchUpstream(table, 'POST', '/v1/messages', { 'anthropic-version': ['2023-06-01'] })?.name,
      'anthropic'
    )
    assert.equal(matchUpstream(table, 'POST', '/v1/messages/count_tokens', {})?.name, 'anthropic')
    assert.equal(matchUpstream(table, 'POST', '/v1/chat/completions', {})?.name, 'openai')
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The manifests the kernel boots from, read off disk rather than restated
 * here, so a rename or a new dependency edge reaches these tests.
 *
 * @returns {Promise<PluginManifest[]>}
 */
async function bundledManifests() {
  const { loaded } = await discoverBundledPlugins()
  const manifests = loaded.map((entry) => entry.manifest)
  assert.ok(manifests.length > 0, 'no bundled plugin manifests were discovered')
  return manifests
}

/**
 * Run each named plugin's real `activate()` against one gateway API and
 * return the surviving preset map, so a name collision resolves exactly the
 * way it does at boot.
 *
 * @param {string[]} order
 * @returns {Promise<Map<string, any>>}
 */
async function presetsFromActivate(order) {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  const activators = { [CODEX]: activateCodex, [OPENCLAW]: activateOpenclaw }
  for (const name of order) {
    const activate = activators[name]
    assert.ok(activate, `no activator wired for ${name}`)
    await activate(stubContext(api))
  }
  return state.presets
}

/**
 * @param {string[]} order
 */
async function compiledPresetTable(order) {
  const presets = await presetsFromActivate(order)
  // With no config upstreams, the source's merge over presets is the identity,
  // so compiling the presets is the table the proxy routes against.
  return compileUpstreams(Array.from(presets.values()).map(presetAsUpstream))
}

/**
 * @param {any} preset
 * @returns {UpstreamConfig}
 */
function presetAsUpstream(preset) {
  /** @type {UpstreamConfig} */
  const entry = { name: preset.name, base_url: preset.base_url }
  if (preset.provider) entry.provider = preset.provider
  if (preset.path_prefix) entry.path_prefix = preset.path_prefix
  if (typeof preset.priority === 'number') entry.priority = preset.priority
  if (typeof preset.match === 'function') entry.match = preset.match
  return entry
}

/**
 * @param {any} gateway
 */
function stubContext(gateway) {
  return /** @type {any} */ ({
    env: { HOME: '/nonexistent/home', HYP_HOME: '/nonexistent/home/.hypaware' },
    paths: { stateDir: '/nonexistent/home/.hypaware/state/plugins/test' },
    plugin: { version: '0.0.0-test' },
    config: {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    configRegistry: { registerSection() {} },
    requireCapability: () => gateway,
    backfills: { register() {} },
    commands: { register() {} },
    skills: { register() {} },
  })
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T[][]}
 */
function permutations(items) {
  if (items.length <= 1) return [items]
  /** @type {T[][]} */
  const out = []
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of permutations(rest)) out.push([items[i], ...tail])
  }
  return out
}
