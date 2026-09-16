// @ts-check

// Every central client resolves the configured url the same way product
// telemetry's `safeDestination` does: redundant trailing slashes in the base
// collapse, so a `https://host//` config reaches `/v1/ingest`, `/v1/config`
// and `/v1/identity/refresh` rather than the doubled-slash path the receiver
// will not route (issue #1751).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { safeDestination } from '../../src/core/product_telemetry/policy.js'
import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'
import { createConfigPullLoop } from '../../hypaware-core/plugins-workspace/central/src/config_client.js'
import { IdentityClient } from '../../hypaware-core/plugins-workspace/central/src/identity_client.js'

/** A base an operator can type and `hyp join` persists verbatim. */
const DOUBLED = 'https://central.example//'
const TABLE = '/cache/ai_gateway_messages/source=claude'

function makeLog() {
  /** @param {string} _message @param {Record<string, unknown>} [_fields] */
  const noop = (_message, _fields) => {}
  return { debug: noop, info: noop, warn: noop, error: noop }
}

/** One-row storage stub: enough to make the sink POST once. */
function makeStorage() {
  return {
    cacheRoot: '/cache',
    /** @param {string} p */
    tableExists: (p) => p === TABLE,
    async flushTable() {},
    /** @param {string} _p */
    async *readRowsSince(_p) {
      yield { row: { id: 'a' }, after: { v: /** @type {const} */ (1), seq: '1' } }
    },
  }
}

function makeWatermarks() {
  return {
    keyFor: () => ({ dataset: 'ai_gateway_messages', partitionKey: 'source=claude' }),
    filePath: () => '/state/watermarks/ai_gateway_messages/source=claude.json',
    async read() { return null },
    async write() { return null },
  }
}

test('a doubled-slash base resolves to the same single-slash targets product telemetry uses', async () => {
  // The reference: product telemetry's normalizer for the same configured url.
  assert.equal(safeDestination(DOUBLED), 'https://central.example')

  /** @type {string[]} */
  const urls = []
  /** @type {typeof fetch} */
  const fetchFn = /** @type {any} */ (async (url) => {
    urls.push(String(url))
    return /** @type {any} */ ({
      status: 202, ok: true,
      headers: { get: () => null },
      async text() { return '' },
      body: { cancel: async () => {} },
    })
  })

  const sink = createForwardSink({
    config: /** @type {any} */ ({ url: DOUBLED, identity: {} }),
    identityClient: /** @type {any} */ ({ async getCurrentJwt() { return 'jwt' }, async refresh() {} }),
    query: /** @type {any} */ ({ getDataset: () => ({ sourceSignal: 'logs' }) }),
    storage: /** @type {any} */ (makeStorage()),
    watermarks: /** @type {any} */ (makeWatermarks()),
    rollouts: /** @type {any} */ ({ async read() { return null }, async write() { throw new Error('unused') } }),
    log: /** @type {any} */ (makeLog()),
    fetchFn,
    sleepFn: async () => {},
  })
  await sink.exportBatch(
    /** @type {any} */ ({ partitions: [{ dataset: 'ai_gateway_messages', tablePath: TABLE }] }),
    /** @type {any} */ ({})
  )
  assert.equal(urls.length, 1)
  assert.equal(urls[0], 'https://central.example/v1/ingest/logs')

  // Config pull: same base, same collapse.
  /** @type {string[]} */
  const configUrls = []
  const loop = createConfigPullLoop(/** @type {any} */ ({
    centralUrl: DOUBLED,
    identityClient: { async getCurrentJwt() { return 'jwt' }, async refresh() {} },
    configControl: {
      async stage() { return { ok: true, action: 'applied' } },
      confirmPoll() {},
      runningEtag() { return undefined },
    },
    pollIntervalSeconds: 3600,
    log: makeLog(),
    /** @type {typeof fetch} */
    fetchFn: async (url) => {
      configUrls.push(String(url))
      return new Response(null, { status: 304 })
    },
  }))
  loop.start()
  await loop.stop()
  assert.deepEqual(configUrls, ['https://central.example/v1/config'])

  // Identity refresh: same base, same collapse.
  const nowSec = 1_900_000_000
  const b64 = (/** @type {object} */ obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const jwt = `${b64({ alg: 'none' })}.${b64({ sub: 'gw-1' })}.sig`
  /** @type {string[]} */
  const identityUrls = []
  const client = new IdentityClient(/** @type {any} */ ({
    centralUrl: DOUBLED,
    bootstrapToken: 'token-a',
    persistedPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-url-join-')), 'identity.json'),
    now: () => nowSec * 1000,
    /** @type {typeof fetch} */
    fetchFn: async (url) => {
      identityUrls.push(String(url))
      return new Response(
        JSON.stringify({ jwt, expires_at: nowSec + 30 * 24 * 60 * 60 }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
  }))
  await client.acquire()
  await client.refresh()
  assert.deepEqual(identityUrls, [
    'https://central.example/v1/identity/bootstrap',
    'https://central.example/v1/identity/refresh',
  ])
})
