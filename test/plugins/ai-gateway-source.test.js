// @ts-check

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createStartSource } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'

test('source starts with only adapter-registered upstream presets', async () => {
  const upstream = await startEchoUpstream('preset-ok')
  const state = createGatewayState()
  state.presets.set('echo', {
    name: 'echo',
    base_url: upstream.url,
    path_prefix: '/',
  })

  const source = await createStartSource(state)(fakeCtx({
    listen: '127.0.0.1:0',
  }))

  try {
    const status = await source.status()
    const body = await fetchText(`http://${status.details.host}:${status.details.port}/anything`)
    assert.equal(body.status, 200)
    assert.equal(body.text, 'preset-ok')
  } finally {
    await source.stop()
    await upstream.close()
  }
})

test('operator configured upstream wins over same-name adapter preset', async () => {
  const upstream = await startEchoUpstream('config-ok')
  const state = createGatewayState()
  state.presets.set('openai', {
    name: 'openai',
    base_url: 'http://127.0.0.1:1',
    path_prefix: '/',
  })

  const source = await createStartSource(state)(fakeCtx({
    listen: '127.0.0.1:0',
    upstreams: [{
      name: 'openai',
      base_url: upstream.url,
      path_prefix: '/',
      provider: 'openai',
    }],
  }))

  try {
    const status = await source.status()
    const body = await fetchText(`http://${status.details.host}:${status.details.port}/v1/responses`)
    assert.equal(body.status, 200)
    assert.equal(body.text, 'config-ok')
  } finally {
    await source.stop()
    await upstream.close()
  }
})

/** @param {Record<string, unknown>} config */
function fakeCtx(config) {
  return /** @type {any} */ ({
    config,
    storage: {
      cacheTablePath(dataset, partitions) {
        return [dataset, ...(partitions ?? [])].join('/')
      },
      async appendRows() {},
    },
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  })
}

/** @param {string} body */
async function startEchoUpstream(body) {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(body)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)))
    }),
  }
}

/** @param {string} url */
async function fetchText(url) {
  const res = await fetch(url)
  return { status: res.status, text: await res.text() }
}
