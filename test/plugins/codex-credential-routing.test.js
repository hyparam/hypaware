// @ts-check

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createRecorder } from '../../hypaware-core/plugins-workspace/ai-gateway/src/recorder.js'
import {
  compileUpstreams,
  matchUpstream,
  matchUpstreamByHost,
  startProxy,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'
import { activate as activateCodex } from '../../hypaware-core/plugins-workspace/codex/src/index.js'
import { activate as activateOpenclaw } from '../../hypaware-core/plugins-workspace/openclaw/src/index.js'
import { mergeUpstreams } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'

/**
 * @import { UpstreamConfig } from '../../hypaware-core/plugins-workspace/ai-gateway/src/types.js'
 */

/**
 * The break this file exists for: a Codex user switches login mode, the
 * credential in every request changes, and `config.toml` does not. Under
 * LLP 0099 the route came from `auth.json` at attach time, so the gateway
 * faithfully forwarded an `sk-` platform key to `chatgpt.com` and every turn
 * failed until the next reconcile pass AND the next `codex` restart.
 *
 * LLP 0313 moves the decision into the request: attach writes one neutral
 * prefix in both modes, and the gateway picks the upstream from the
 * credential the request carries, rewriting the outbound path to that
 * upstream's own shape.
 *
 * The tests below run the plugins' real `activate()` and compile the routing
 * table that produces, so they see whichever registration survived the
 * name-keyed preset slot rather than a literal copy of a preset's fields.
 *
 * @ref LLP 0313#decision [tests]: an `sk-` bearer on the neutral prefix reaches api.openai.com/v1, and a subscription token on the same path still reaches chatgpt.com unchanged
 */

const CODEX = '@hypaware/codex'
const OPENCLAW = '@hypaware/openclaw'
const UPSTREAM_HEADER = 'x-hypaware-upstream'
const NEUTRAL_PREFIX = '/backend-api/codex'
// Shaped like a real subscription bearer (a JWT), which is what makes the
// negative case meaningful: it must NOT look like an API key.
const SUBSCRIPTION_BEARER = 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'
const API_KEY_BEARER = 'Bearer sk-test-not-a-real-key'

// ---------------------------------------------------------------------------
// Routing: which upstream, and at which path.
// ---------------------------------------------------------------------------

/**
 * Every case the credential rung has to get right, including the ones it must
 * leave alone. `expect` is the upstream name, or `undefined` for "the
 * gateway answers 404". Where that upstream forwards the request to is
 * asserted on the wire, further down.
 *
 * @type {{ label: string, path: string, headers: Record<string, string[]>, expect: string | undefined }[]}
 */
const CASES = [
  {
    label: 'an API key on the neutral prefix goes to OpenAI',
    path: `${NEUTRAL_PREFIX}/responses`,
    headers: { authorization: [API_KEY_BEARER] },
    expect: 'openai-codex',
  },
  {
    label: 'the prefix itself, with an API key',
    path: NEUTRAL_PREFIX,
    headers: { authorization: [API_KEY_BEARER] },
    expect: 'openai-codex',
  },
  {
    label: 'a subscription token on the neutral prefix is untouched',
    path: `${NEUTRAL_PREFIX}/responses`,
    headers: { authorization: [SUBSCRIPTION_BEARER] },
    expect: 'chatgpt',
  },
  {
    label: 'no credential at all falls back to path routing',
    path: `${NEUTRAL_PREFIX}/responses`,
    headers: {},
    expect: 'chatgpt',
  },
  {
    label: 'an unrecognized credential falls back to path routing',
    path: `${NEUTRAL_PREFIX}/responses`,
    headers: { authorization: ['Basic dXNlcjpwYXNz'] },
    expect: 'chatgpt',
  },
  {
    // Steering names a destination; the credential rung is a refusal, and a
    // refusal does not take preferences. Letting the header decline the rung
    // was a hole: the presets it deferred to (`openai`, `chatgpt`) are the
    // two `hyp init` replaces in operator config, and a replaced entry
    // carries no `match()`, so a steered key fell through to `chatgpt` on a
    // default install. Claiming it here costs the steered caller nothing:
    // `openai-codex` IS api.openai.com, at the path shape that host serves.
    label: 'a steer does not defeat the credential rung',
    path: `${NEUTRAL_PREFIX}/responses`,
    headers: { authorization: [API_KEY_BEARER], [UPSTREAM_HEADER]: ['openai'] },
    expect: 'openai-codex',
  },
  {
    label: 'a steer cannot push an API key onto chatgpt.com',
    path: `${NEUTRAL_PREFIX}/responses`,
    headers: { authorization: [API_KEY_BEARER], [UPSTREAM_HEADER]: ['chatgpt'] },
    expect: 'openai-codex',
  },
  {
    // The credential test is deliberately broader than a strict
    // `Bearer <token>` parse. Each of these carries a real platform key, and
    // a matcher that fails to recognise one forwards it to chatgpt.com.
    label: 'an upper-cased key prefix is still a key',
    path: `${NEUTRAL_PREFIX}/responses`,
    headers: { authorization: ['Bearer SK-TEST-NOT-A-REAL-KEY'] },
    expect: 'openai-codex',
  },
  {
    label: 'a key with a stray trailing token is still a key',
    path: `${NEUTRAL_PREFIX}/responses`,
    headers: { authorization: [`${API_KEY_BEARER} extra`] },
    expect: 'openai-codex',
  },
  {
    label: 'a key sent without its scheme is still a key',
    path: `${NEUTRAL_PREFIX}/responses`,
    headers: { authorization: ['sk-test-not-a-real-key'] },
    expect: 'openai-codex',
  },
  {
    // ...and the breadth stops at the shape. A real auth-scheme name never
    // begins `sk-`, so nothing that is not a key is diverted.
    label: 'a base64 Basic credential is not mistaken for a key',
    path: `${NEUTRAL_PREFIX}/responses`,
    headers: { authorization: ['Basic c2stbm90LWEta2V5'] },
    expect: 'chatgpt',
  },
  {
    label: 'an API key already on the OpenAI prefix is unaffected',
    path: '/v1/responses',
    headers: { authorization: [API_KEY_BEARER] },
    expect: 'openai',
  },
  {
    label: 'one byte past the neutral prefix is nobody',
    path: `${NEUTRAL_PREFIX}x/responses`,
    headers: { authorization: [API_KEY_BEARER] },
    expect: undefined,
  },
  {
    label: 'an anthropic path with an API-key-shaped bearer is not diverted',
    path: '/v1/messages',
    headers: { authorization: [API_KEY_BEARER] },
    expect: 'anthropic',
  },
]

for (const order of [[CODEX, OPENCLAW], [OPENCLAW, CODEX]]) {
  test(`credential routing holds under activation order ${order.join(' then ')}`, async () => {
    const table = await compiledPresetTable(order)
    for (const item of CASES) {
      const matched = matchUpstream(table, 'POST', item.path, item.headers)
      assert.equal(matched?.name, item.expect, `${item.label}: ${item.path}`)
    }
  })
}

/**
 * The rung must not be reachable by activation order alone. `openai` is a
 * last-write-wins slot two adapters register (LLP 0161), which is exactly why
 * LLP 0313 put the rung on a name codex owns outright.
 */
test('the credential rung survives the openai preset slot collision', async () => {
  for (const order of [[CODEX, OPENCLAW], [OPENCLAW, CODEX]]) {
    const presets = await presetsFromActivate(order)
    const rerouter = presets.get('openai-codex')
    assert.ok(rerouter, `activation order ${order.join(',')} lost the openai-codex preset`)
    assert.equal(rerouter.base_url, 'https://api.openai.com')
    assert.equal(rerouter.provider, 'openai')
    assert.deepEqual(rerouter.rewrite, { from: NEUTRAL_PREFIX, to: '/v1' })
  }
})

/**
 * The install every user actually has. `hyp init` composes the codex
 * manifest's `gateway_upstream` block into operator config, which wins by
 * name (`mergeUpstreams`) and can carry no `match()` - so on a DEFAULT
 * install the `chatgpt` preset's guard is not in the routing table at all
 * and that entry routes on `path_prefix` alone. Every case here therefore
 * rests on `openai-codex`, the one entry config does not replace.
 *
 * Asserted against the merged table rather than the presets, because a
 * preset-only table is exactly the table no shipping machine compiles.
 *
 * @ref LLP 0313#sk-never-reaches-chatgpt [tests]: the invariant holds on the
 *   config `hyp init` writes, not only on the presets
 */
test('no api-key-shaped credential reaches chatgpt.com on a default hyp init install', async () => {
  const presets = await presetsFromActivate([CODEX, OPENCLAW])
  // Verbatim from hypaware-core/plugins-workspace/codex/hypaware.plugin.json.
  const table = compileUpstreams(mergeUpstreams([
    { name: 'openai', base_url: 'https://api.openai.com', path_prefix: '/v1', provider: 'openai' },
    { name: 'chatgpt', base_url: 'https://chatgpt.com', path_prefix: NEUTRAL_PREFIX, provider: 'chatgpt' },
  ], /** @type {any} */ ({ presets })))

  // The premise, asserted rather than assumed: config really did take the
  // guard off the chatgpt entry. If this ever stops being true the cases
  // below would pass for the wrong reason.
  assert.equal(
    table.find((u) => u.name === 'chatgpt')?.match,
    undefined,
    'operator config no longer replaces the chatgpt preset; re-derive what this test proves'
  )

  const carriesAKey = [
    ['a well-formed bearer', API_KEY_BEARER],
    ['an upper-cased prefix', 'Bearer SK-TEST-NOT-A-REAL-KEY'],
    ['a stray trailing token', `${API_KEY_BEARER} extra`],
    ['no scheme at all', 'sk-test-not-a-real-key'],
    ['extra interior whitespace', 'Bearer   sk-test-not-a-real-key'],
  ]
  for (const [label, authorization] of carriesAKey) {
    const matched = matchUpstream(table, 'POST', `${NEUTRAL_PREFIX}/responses`, { authorization })
    assert.notEqual(matched?.baseUrl.hostname, 'chatgpt.com', `${label}: the key left for chatgpt.com`)
    assert.equal(matched?.name, 'openai-codex', label)
  }

  // A steer is a destination preference and must not defeat the refusal.
  for (const steer of ['openai', 'chatgpt', 'anthropic']) {
    const matched = matchUpstream(table, 'POST', `${NEUTRAL_PREFIX}/responses`, {
      authorization: API_KEY_BEARER,
      [UPSTREAM_HEADER]: steer,
    })
    assert.notEqual(matched?.baseUrl.hostname, 'chatgpt.com', `steer ${steer}: the key left for chatgpt.com`)
  }

  // ...and the subscription route, which must not regress, still lands.
  assert.equal(
    matchUpstream(table, 'POST', `${NEUTRAL_PREFIX}/responses`, { authorization: SUBSCRIPTION_BEARER })?.name,
    'chatgpt'
  )
})

/**
 * @ref LLP 0313#sk-never-reaches-chatgpt [tests]: stated as an invariant, so
 *   the chatgpt upstream refuses the key even with the rerouter removed
 */
test('an sk- key is never sent to chatgpt.com, even without the rerouting upstream', async () => {
  const presets = await presetsFromActivate([CODEX])
  const withoutRerouter = Array.from(presets.values())
    .filter((preset) => preset.name !== 'openai-codex')
    .map(presetAsUpstream)
  const table = compileUpstreams(withoutRerouter)
  const matched = matchUpstream(table, 'POST', `${NEUTRAL_PREFIX}/responses`, {
    authorization: API_KEY_BEARER,
  })
  assert.equal(matched, undefined, 'the key was routed somewhere instead of refused')
  // The same request without the key still routes, so the refusal is the
  // credential and not the path.
  assert.equal(
    matchUpstream(table, 'POST', `${NEUTRAL_PREFIX}/responses`, { authorization: SUBSCRIPTION_BEARER })?.name,
    'chatgpt'
  )
})

/**
 * Proxy mode and absolute-form route by the authority the client named, not
 * by `match()`, and the rerouting upstream shares a host with `openai` while
 * sorting above it. Picking it there would apply a prefix swap nobody asked
 * for and, worse, hand proxy mode a record anchor of `/backend-api/codex`,
 * so every real `/v1` request to api.openai.com would go unrecorded with no
 * error anywhere.
 *
 * @ref LLP 0313#the-rewrite-is-declarative-data [tests]: the rewriting entry
 *   is a reverse-proxy door, so it never wins the host that owns it
 */
test('host routing skips the rewriting upstream and keeps the record anchor', async () => {
  const table = await compiledPresetTable([CODEX, OPENCLAW])
  const byHost = matchUpstreamByHost(table, 'api.openai.com', 443)
  assert.equal(byHost?.name, 'openai')
  assert.equal(byHost?.prefix, '/v1')
  assert.equal(matchUpstreamByHost(table, 'chatgpt.com', 443)?.name, 'chatgpt')
})

// ---------------------------------------------------------------------------
// The wire: the request the upstream actually receives.
// ---------------------------------------------------------------------------

/**
 * Matching alone would route to the right host at the wrong path, so this
 * drives the real proxy and asserts on what each upstream server received.
 * A rerouted request reaching `api.openai.com/backend-api/codex/responses`
 * is a 404 instead of a 401, which is not a fix.
 */
test('a login switch reroutes the failing request on the wire, at the right path', async () => {
  const chatgpt = await stubUpstream()
  const openai = await stubUpstream()
  const recorder = createRecorder()
  /** @type {import('../../hypaware-core/plugins-workspace/ai-gateway/src/types.js').FinishedRow[]} */
  const rows = []
  const proxy = await startProxy({
    listen: '127.0.0.1:0',
    upstreams: await localizedTable([CODEX, OPENCLAW], {
      chatgpt: chatgpt.url,
      openai: openai.url,
      'openai-codex': openai.url,
    }),
    startExchange: (init) => recorder.startExchange(init),
    onExchangeFinished: (exchange) => { rows.push(exchange.finalize()) },
  })

  try {
    // 1. The subscription turn, which works today and must keep working
    //    byte for byte.
    const subscription = await fetch(`http://${proxy.host}:${proxy.port}${NEUTRAL_PREFIX}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: SUBSCRIPTION_BEARER },
      body: JSON.stringify({ input: 'hello' }),
    })
    assert.equal(subscription.status, 200)
    assert.equal(chatgpt.received.length, 1, 'the subscription turn did not reach the chatgpt upstream')
    assert.equal(chatgpt.received[0].url, `${NEUTRAL_PREFIX}/responses`)
    assert.equal(openai.received.length, 0, 'the subscription turn leaked to the openai upstream')

    // 2. The same client, same config.toml, after `codex login` with an API
    //    key. Only the credential changed.
    const apiKey = await fetch(`http://${proxy.host}:${proxy.port}${NEUTRAL_PREFIX}/responses?stream=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: API_KEY_BEARER },
      body: JSON.stringify({ input: 'hello' }),
    })
    assert.equal(apiKey.status, 200)
    assert.equal(openai.received.length, 1, 'the API-key turn did not reach the openai upstream')
    assert.equal(
      openai.received[0].url,
      '/v1/responses?stream=true',
      'the rewrite must move the prefix and keep the rest of the path, query string included'
    )
    assert.equal(chatgpt.received.length, 1, 'the API key was sent to chatgpt.com')
  } finally {
    await proxy.stop()
    await chatgpt.stop()
    await openai.stop()
  }

  assert.equal(rows.length, 2)
  const [subscriptionRow, apiKeyRow] = rows

  // The row describes the wire it was sent on, and says so explicitly rather
  // than leaving it to be inferred from a path/provider mismatch.
  // @ref LLP 0313#the-row-records-where-the-request-was-sent [tests]
  assert.equal(subscriptionRow.provider, 'chatgpt')
  assert.equal(JSON.parse(subscriptionRow.metadata ?? '{}').upstream_path, undefined)
  assert.equal(apiKeyRow.provider, 'openai')
  assert.equal(JSON.parse(apiKeyRow.metadata ?? '{}').upstream_path, '/v1/responses?stream=true')

  // The projector reads `path` to decide the body shape the CLIENT built, so
  // the door the request arrived at is still recorded verbatim.
  assert.equal(apiKeyRow.path, `${NEUTRAL_PREFIX}/responses?stream=true`)

  // The credential selected the route and must not appear in the row.
  // @ref LLP 0313#credential-inspection [tests]
  for (const row of rows) {
    const serialized = JSON.stringify(row)
    assert.ok(!serialized.includes('sk-test-not-a-real-key'), 'the API key was recorded')
    assert.ok(!serialized.includes('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9'), 'the OAuth token was recorded')
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** @param {string[]} order */
async function compiledPresetTable(order) {
  const presets = await presetsFromActivate(order)
  return compileUpstreams(Array.from(presets.values()).map(presetAsUpstream))
}

/**
 * The same table, with the named upstreams pointed at local stub servers so
 * the proxy can be driven end to end. Everything that decides routing
 * (`match`, `priority`, `path_prefix`, `rewrite`) comes from the real preset.
 *
 * @param {string[]} order
 * @param {Record<string, string>} baseUrls
 * @returns {Promise<UpstreamConfig[]>}
 */
async function localizedTable(order, baseUrls) {
  const presets = await presetsFromActivate(order)
  return Array.from(presets.values())
    .map(presetAsUpstream)
    .map((entry) => (baseUrls[entry.name] ? { ...entry, base_url: baseUrls[entry.name] } : entry))
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
  if (preset.rewrite) entry.rewrite = preset.rewrite
  return entry
}

/**
 * A stub upstream that records what it was asked for.
 *
 * @returns {Promise<{ url: string, received: { url: string | undefined, authorization: string | undefined }[], stop: () => Promise<void> }>}
 */
async function stubUpstream() {
  /** @type {{ url: string | undefined, authorization: string | undefined }[]} */
  const received = []
  const server = http.createServer((req, res) => {
    received.push({
      url: req.url,
      authorization: /** @type {string | undefined} */ (req.headers.authorization),
    })
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    received,
    stop: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}

/** @param {any} gateway */
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
