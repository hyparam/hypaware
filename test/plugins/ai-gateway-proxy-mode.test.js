// @ts-check

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import tls from 'node:tls'

import {
  interceptsHost,
  matchUpstreamByHost,
  shouldRecordProxyExchange,
  startProxy,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'
import { compileUpstreams } from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'
import { createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createStartSource } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'
import { createLeafStore, ensureLocalCa, readLocalCaInfo } from '../../src/core/tls/ca.js'

// `localhost` stands in for `api.anthropic.com`: it resolves, so the outbound
// leg reaches the fake upstream, and a leaf with a DNS SAN for it verifies the
// same way a real one would.
const HOST = 'localhost'

/**
 * A full proxy-mode gateway in front of a fake upstream.
 *
 * @param {object} [opts]
 * @param {string} [opts.pathPrefix]
 */
async function bootProxyMode(opts = {}) {
  const stateRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-proxymode-'))
  const ca = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  const leaves = createLeafStore(ca)

  /** @type {string[]} */
  const upstreamHits = []
  const upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url ?? '')
    // An explicit content-length keeps responses framed without chunking, so a
    // keep-alive reader can find the end of one response on a reused tunnel.
    const body = JSON.stringify({ ok: true, path: req.url })
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)))
  const upstreamAddress = upstream.address()
  const upstreamPort =
    upstreamAddress && typeof upstreamAddress === 'object' ? upstreamAddress.port : 0

  /** @type {{ path: string | undefined }[]} */
  const started = []
  /** @type {unknown[]} */
  const finished = []

  const proxy = await startProxy({
    listen: '127.0.0.1:0',
    upstreams: [{
      name: 'fake-anthropic',
      base_url: `http://${HOST}:${upstreamPort}`,
      path_prefix: opts.pathPrefix ?? '/v1/messages',
      provider: 'anthropic',
    }],
    startExchange: (init) => {
      started.push({ path: init.path })
      // Enough of the Exchange surface for the handler to drive.
      return /** @type {never} */ ({
        isSse: false,
        response: undefined,
        appendRequestChunk() {},
        setResponseStart() {},
        appendResponseChunk() {},
        consumeStreamChunk() {},
        setError() {},
      })
    },
    onExchangeFinished: (exchange) => {
      finished.push(exchange)
    },
    interception: { secureContextFor: (host) => leaves.secureContextFor(host) },
  })

  return {
    ca,
    proxy,
    started,
    finished,
    upstreamHits,
    // A real client CONNECTs to the endpoint the upstream names, so the test
    // tunnel targets the fake upstream's port rather than a bare 443.
    connectPort: upstreamPort,
    async cleanup() {
      await proxy.stop()
      await new Promise((resolve) => upstream.close(() => resolve(undefined)))
      await fsp.rm(stateRoot, { recursive: true, force: true })
    },
  }
}

/**
 * CONNECT through the gateway, then make one HTTPS request over the tunnel.
 *
 * @param {{ port: number, connectPort: number, caPem: string, requestPath: string }} args
 * @returns {Promise<string>}
 */
function requestThroughTunnel({ port, connectPort, caPem, requestPath }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${HOST}:${connectPort} HTTP/1.1\r\nHost: ${HOST}:${connectPort}\r\n\r\n`)
    })
    /** @type {Buffer} */
    let preamble = Buffer.alloc(0)
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      preamble = Buffer.concat([preamble, Buffer.from(chunk)])
      const end = preamble.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onData)
      const rest = preamble.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)

      const secure = tls.connect(
        { socket, servername: HOST, ca: [caPem], ALPNProtocols: ['http/1.1'] },
        () => {
          secure.write(
            `GET ${requestPath} HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`
          )
        }
      )
      /** @type {Buffer[]} */
      const chunks = []
      secure.on('data', (c) => chunks.push(Buffer.from(c)))
      secure.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      secure.on('error', reject)
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}

// Model traffic still lands, exactly as it does in reverse-proxy mode.
test('a matched path is proxied and recorded', async (t) => {
  const rig = await bootProxyMode()
  t.after(() => rig.cleanup())

  const body = await requestThroughTunnel({
    port: rig.proxy.port,
    connectPort: rig.connectPort,
    caPem: rig.ca.certPem,
    requestPath: '/v1/messages',
  })

  assert.match(body, /^HTTP\/1\.1 200 /)
  assert.match(body, /"ok":true/)
  assert.deepEqual(rig.upstreamHits, ['/v1/messages'])
  assert.equal(rig.started.length, 1, 'the exchange was recorded')
  assert.equal(rig.finished.length, 1)
})

// The aperture claim: proxy mode sees every request the client makes to the
// host, and everything outside the path anchor passes through unrecorded.
// @ref LLP 0234#recording-is-opt-in-per-path [tests]
test('a side-channel path on the same host is proxied but never recorded', async (t) => {
  const rig = await bootProxyMode()
  t.after(() => rig.cleanup())

  const body = await requestThroughTunnel({
    port: rig.proxy.port,
    connectPort: rig.connectPort,
    caPem: rig.ca.certPem,
    requestPath: '/mcp-registry/v0/servers',
  })

  // Proxied faithfully: the client's request still works.
  assert.match(body, /^HTTP\/1\.1 200 /)
  assert.deepEqual(rig.upstreamHits, ['/mcp-registry/v0/servers'])
  // But no exchange was ever started, so no body was buffered and no row can exist.
  assert.equal(rig.started.length, 0)
  assert.equal(rig.finished.length, 0)
})

// The specific hole the handoff found: an Anthropic bearer token on an
// unrelated path used to satisfy the routing matcher and project stored rows.
// The path anchor is what closes it, so assert the header cannot reopen it.
test('an Anthropic bearer token on an unmatched path does not cause recording', async (t) => {
  const rig = await bootProxyMode()
  t.after(() => rig.cleanup())

  await new Promise((resolve, reject) => {
    const socket = net.connect(rig.proxy.port, '127.0.0.1', () => {
      socket.write(`CONNECT ${HOST}:${rig.connectPort} HTTP/1.1\r\nHost: ${HOST}:${rig.connectPort}\r\n\r\n`)
    })
    /** @type {Buffer} */
    let preamble = Buffer.alloc(0)
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      preamble = Buffer.concat([preamble, Buffer.from(chunk)])
      if (preamble.indexOf('\r\n\r\n') === -1) return
      socket.removeListener('data', onData)
      const secure = tls.connect({ socket, servername: HOST, ca: [rig.ca.certPem] }, () => {
        secure.write(
          'POST /api/eval/sdk-abc HTTP/1.1\r\n' +
          `Host: ${HOST}\r\n` +
          'Authorization: Bearer sk-ant-fake\r\n' +
          'anthropic-version: 2023-06-01\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 26\r\n' +
          'Connection: close\r\n\r\n' +
          '{"messages":[{"a":"body"}]}'.slice(0, 26)
        )
      })
      secure.on('end', () => resolve(undefined))
      secure.on('data', () => {})
      secure.on('error', reject)
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })

  assert.deepEqual(rig.upstreamHits, ['/api/eval/sdk-abc'])
  assert.equal(rig.started.length, 0, 'the bearer header must not reopen the recording aperture')
})

test('a catch-all path prefix records nothing in proxy mode', async (t) => {
  const rig = await bootProxyMode({ pathPrefix: '/' })
  t.after(() => rig.cleanup())

  await requestThroughTunnel({
    port: rig.proxy.port,
    connectPort: rig.connectPort,
    caPem: rig.ca.certPem,
    requestPath: '/v1/messages',
  })

  assert.deepEqual(rig.upstreamHits, ['/v1/messages'])
  assert.equal(rig.started.length, 0, 'a catch-all must not mean record-everything')
})

test('interceptsHost is driven by the routing table', () => {
  const upstreams = compileUpstreams([
    { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' },
  ])
  assert.equal(interceptsHost(upstreams, 'api.anthropic.com'), true)
  assert.equal(interceptsHost(upstreams, 'http-intake.logs.us5.datadoghq.com'), false)
  assert.equal(interceptsHost(upstreams, 'pypi.org'), false)
})

test('matchUpstreamByHost resolves the CONNECT target', () => {
  const upstreams = compileUpstreams([
    { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' },
    { name: 'openai', base_url: 'https://api.openai.com', path_prefix: '/v1' },
  ])
  assert.equal(matchUpstreamByHost(upstreams, 'api.openai.com')?.name, 'openai')
  assert.equal(matchUpstreamByHost(upstreams, 'example.com'), undefined)
})

// `interceptsHost` keys the trust decision on host AND port, deliberately, so
// that terminating `CONNECT host:8443` cannot end up forwarded to 443. The
// resolve that runs inside the terminated tunnel has to agree with it, or the
// port check is decoration: with two upstreams on one hostname, a
// hostname-only resolve returns whichever sorts first and sends the decrypted
// request to a port the client never named.
// @ref LLP 0234#intercept-set-is-the-routing-table [tests]
test('matchUpstreamByHost agrees with interceptsHost on the port', () => {
  const upstreams = compileUpstreams([
    { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' },
    { name: 'anthropic-alt', base_url: 'https://api.anthropic.com:8443', path_prefix: '/v1' },
  ])
  // Both are intercepted, each on its own port and neither on the other's.
  assert.equal(interceptsHost(upstreams, 'api.anthropic.com', 443), true)
  assert.equal(interceptsHost(upstreams, 'api.anthropic.com', 8443), true)
  assert.equal(interceptsHost(upstreams, 'api.anthropic.com', 9999), false)

  // And each tunnel resolves to the entry that authorised it, not to the one
  // that happens to come first.
  assert.equal(matchUpstreamByHost(upstreams, 'api.anthropic.com', 443)?.name, 'anthropic')
  assert.equal(matchUpstreamByHost(upstreams, 'api.anthropic.com', 8443)?.name, 'anthropic-alt')
  assert.equal(matchUpstreamByHost(upstreams, 'api.anthropic.com', 9999), undefined)
})

/**
 * Boot the real source with a pinned HYP_HOME so the CA lands in a temp tree.
 *
 * @param {Record<string, unknown>} config
 */
async function bootSource(config) {
  const hypHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-src-'))
  /** @type {{ level: string, event: string, attrs: any }[]} */
  const logged = []
  /** @param {string} level */
  const record = (level) => (/** @type {string} */ event, /** @type {any} */ attrs) => {
    logged.push({ level, event, attrs })
  }
  const ctx = /** @type {any} */ ({
    config,
    env: { HYP_HOME: hypHome },
    storage: {
      cacheTablePath: (/** @type {string} */ d) => d,
      async appendRows() {},
    },
    log: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
  })
  const source = await createStartSource(createGatewayState())(ctx)
  return {
    source,
    logged,
    stateRoot: path.join(hypHome, 'hypaware'),
    async cleanup() {
      await source.stop()
      await fsp.rm(hypHome, { recursive: true, force: true })
    },
  }
}

// @ref LLP 0233#proxy-mode-is-explicit [tests]
test('the source mints a CA and reports proxy mode when it is enabled', async (t) => {
  const rig = await bootSource({
    listen: '127.0.0.1:0',
    proxy_mode: true,
    upstreams: [{
      name: 'anthropic',
      base_url: 'https://api.anthropic.com',
      path_prefix: '/v1/messages',
      provider: 'anthropic',
    }],
  })
  t.after(() => rig.cleanup())

  assert.ok(rig.source.status, 'the source exposes status()')
  const status = await rig.source.status()
  const details = /** @type {any} */ (status.details)
  assert.equal(details.proxy_mode, true)
  assert.match(details.ca_fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/)
  // What is decrypted is still exactly what the routing table named...
  assert.deepEqual(details.intercept_hosts, ['api.anthropic.com'])
  // ...while the CA is constrained to the full static provider set, so the
  // user's one trust grant covers a provider enabled later, and status
  // reports that wider grant honestly.
  // @ref LLP 0238#full-provider-constraints [tests]
  assert.deepEqual(details.ca_permitted_hosts, ['api.anthropic.com', 'api.openai.com', 'chatgpt.com'])

  const info = await readLocalCaInfo({ stateRoot: rig.stateRoot })
  assert.ok(info)
  assert.deepEqual(info.hosts, ['api.anthropic.com', 'api.openai.com', 'chatgpt.com'])
  assert.equal(info.fingerprint, details.ca_fingerprint)
})

// Installing a CA and decrypting traffic must never be something a config
// acquires by inference or upgrade.
// @ref LLP 0233#proxy-mode-is-explicit [tests]
test('proxy mode stays off and mints nothing unless configured on', async (t) => {
  const rig = await bootSource({
    listen: '127.0.0.1:0',
    upstreams: [{
      name: 'anthropic',
      base_url: 'https://api.anthropic.com',
      path_prefix: '/v1/messages',
    }],
  })
  t.after(() => rig.cleanup())

  assert.ok(rig.source.status, 'the source exposes status()')
  const status = await rig.source.status()
  assert.equal(/** @type {any} */ (status.details).proxy_mode, false)
  assert.equal(await readLocalCaInfo({ stateRoot: rig.stateRoot }), undefined)
})

test('shouldRecordProxyExchange anchors on the declared path prefix', () => {
  const [anthropic] = compileUpstreams([
    { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' },
  ])
  assert.equal(shouldRecordProxyExchange(anthropic, '/v1/messages'), true)
  assert.equal(shouldRecordProxyExchange(anthropic, '/v1/messages/batches'), true)
  assert.equal(shouldRecordProxyExchange(anthropic, '/v1/messagesfoo'), false)
  assert.equal(shouldRecordProxyExchange(anthropic, '/mcp-registry/v0/servers'), false)
  assert.equal(shouldRecordProxyExchange(anthropic, '/api/oauth/account/settings'), false)
})

// The control route is an unauthenticated local surface. A tunnelled request is
// addressed to a third party, so it must be forwarded, not answered locally.
// @ref LLP 0234#recording-is-opt-in-per-path [tests]
test('the local control path is not served over a tunnel', async (t) => {
  const rig = await bootProxyMode()
  t.after(() => rig.cleanup())

  const body = await requestThroughTunnel({
    port: rig.proxy.port,
    connectPort: rig.connectPort,
    caPem: rig.ca.certPem,
    requestPath: '/_hypaware/ignore/session',
  })

  // Forwarded to the host the client addressed, not intercepted by the gateway.
  assert.deepEqual(rig.upstreamHits, ['/_hypaware/ignore/session'])
  assert.match(body, /"ok":true/)
  assert.equal(rig.started.length, 0)
})

// Claude Code reuses one TLS connection for many requests, so the recording
// decision has to be made per request, not per tunnel.
test('recording is decided per request across a reused tunnel', async (t) => {
  const rig = await bootProxyMode()
  t.after(() => rig.cleanup())

  const { socket } = await new Promise((resolve, reject) => {
    const raw = net.connect(rig.proxy.port, '127.0.0.1', () => {
      raw.write(`CONNECT ${HOST}:${rig.connectPort} HTTP/1.1\r\nHost: ${HOST}:${rig.connectPort}\r\n\r\n`)
    })
    /** @type {Buffer} */
    let preamble = Buffer.alloc(0)
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      preamble = Buffer.concat([preamble, Buffer.from(chunk)])
      const end = preamble.indexOf('\r\n\r\n')
      if (end === -1) return
      raw.removeListener('data', onData)
      const rest = preamble.subarray(end + 4)
      if (rest.length > 0) raw.unshift(rest)
      resolve({ socket: raw })
    }
    raw.on('data', onData)
    raw.on('error', reject)
  })

  const secure = await new Promise((resolve, reject) => {
    const s = tls.connect(
      { socket, servername: HOST, ca: [rig.ca.certPem], ALPNProtocols: ['http/1.1'] },
      () => resolve(s)
    )
    s.on('error', reject)
  })

  /** Send one keep-alive request and read exactly one response. */
  const send = (/** @type {string} */ requestPath) => new Promise((resolve, reject) => {
    /** @type {Buffer} */
    let buf = Buffer.alloc(0)
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)])
      const headEnd = buf.indexOf('\r\n\r\n')
      if (headEnd === -1) return
      const head = buf.subarray(0, headEnd).toString('ascii')
      const len = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? -1)
      if (len < 0 || buf.length < headEnd + 4 + len) return
      secure.removeListener('data', onData)
      resolve(buf.subarray(headEnd + 4, headEnd + 4 + len).toString('utf8'))
    }
    secure.on('data', onData)
    secure.on('error', reject)
    secure.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`)
  })

  const first = await send('/v1/messages')
  const second = await send('/api/oauth/account/settings')
  const third = await send('/v1/messages')
  secure.destroy()

  assert.match(first, /"ok":true/)
  assert.match(second, /"ok":true/)
  assert.match(third, /"ok":true/)
  assert.deepEqual(rig.upstreamHits, [
    '/v1/messages',
    '/api/oauth/account/settings',
    '/v1/messages',
  ])
  // Two matched requests recorded; the side channel between them did not.
  assert.equal(rig.started.length, 2)
  assert.deepEqual(rig.started.map((s) => s.path), ['/v1/messages', '/v1/messages'])
})

// The routing table a real install compiles, not a hand-written one. `hyp init`
// writes `path_prefix: "/"` for the anthropic upstream, and config wins over
// the preset by name, so reading the routing prefix as the record anchor made
// proxy mode record nothing at all on a default install.
// @ref LLP 0234#recording-is-opt-in-per-path [tests]
test('the routing table a default install compiles still records model traffic', async () => {
  const { createGatewayState } = await import(
    '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
  )
  const { mergeUpstreams } = await import(
    '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'
  )
  const { anthropicUpstreamPreset } = await import(
    '../../hypaware-core/plugins-workspace/claude/src/projector.js'
  )

  const state = createGatewayState()
  const preset = anthropicUpstreamPreset()
  state.presets.set(preset.name, preset)

  // Exactly what the `claude-and-otel-local` init preset writes.
  const merged = mergeUpstreams(
    [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' }],
    state
  )
  const [anthropic] = compileUpstreams(merged)

  // Operator config still wins the routing question.
  assert.equal(anthropic.prefix, '/')
  // But the adapter's preset supplies the record anchor and the provider label.
  assert.equal(anthropic.recordPrefix, '/v1/messages')
  assert.equal(anthropic.provider, 'anthropic')

  assert.equal(shouldRecordProxyExchange(anthropic, '/v1/messages'), true)
  assert.equal(shouldRecordProxyExchange(anthropic, '/mcp-registry/v0/servers'), false)
  assert.equal(shouldRecordProxyExchange(anthropic, '/api/oauth/account/settings'), false)
})

test('an upstream with no preset behind it still records on its own prefix', async () => {
  const { createGatewayState } = await import(
    '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
  )
  const { mergeUpstreams } = await import(
    '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'
  )
  const merged = mergeUpstreams(
    [{ name: 'custom', base_url: 'https://api.example.com', path_prefix: '/v1/chat' }],
    createGatewayState()
  )
  const [custom] = compileUpstreams(merged)
  assert.equal(custom.recordPrefix, undefined)
  assert.equal(shouldRecordProxyExchange(custom, '/v1/chat'), true)
  assert.equal(shouldRecordProxyExchange(custom, '/other'), false)
})

test('interceptsHost matches on host AND port, case-insensitively', () => {
  const upstreams = compileUpstreams([
    { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' },
  ])
  assert.equal(interceptsHost(upstreams, 'api.anthropic.com', 443), true)
  assert.equal(interceptsHost(upstreams, 'API.ANTHROPIC.COM', 443), true)
  // Decrypting :8443 and then forwarding to :443 would send the request
  // somewhere the client never asked for.
  assert.equal(interceptsHost(upstreams, 'api.anthropic.com', 8443), false)
})

// A client attached in proxy mode routes ALL its egress here, so losing
// interception must not mean losing the client's network.
// @ref LLP 0233#one-listener-two-front-doors [tests]
test('proxy mode turned off with a CA still installed serves blind tunnels', async (t) => {
  const hypHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-stale-'))
  t.after(() => fsp.rm(hypHome, { recursive: true, force: true }))
  const stateRoot = path.join(hypHome, 'hypaware')
  await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com'] })

  const echo = net.createServer((socket) => socket.pipe(socket))
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', () => resolve(undefined)))
  const echoAddress = echo.address()
  const echoPort = echoAddress && typeof echoAddress === 'object' ? echoAddress.port : 0
  t.after(() => new Promise((resolve) => echo.close(() => resolve(undefined))))

  /** @type {{ level: string, event: string, attrs: Record<string, unknown> }[]} */
  const logged = []
  /** @param {string} level */
  const record = (level) => (
    /** @type {string} */ event,
    /** @type {Record<string, unknown> | undefined} */ attrs
  ) => logged.push({ level, event, attrs: attrs ?? {} })
  const ctx = /** @type {any} */ ({
    // proxy_mode deliberately absent, as if the operator turned it back off.
    config: {
      listen: '127.0.0.1:0',
      upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' }],
    },
    env: { HYP_HOME: hypHome },
    storage: { cacheTablePath: (/** @type {string} */ d) => d, async appendRows() {} },
    log: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
  })
  const source = await createStartSource(createGatewayState())(ctx)
  t.after(() => source.stop())

  assert.ok(source.status, 'the source exposes status()')
  const details = /** @type {any} */ ((await source.status()).details)
  assert.equal(details.proxy_mode, false)
  assert.match(details.proxy_mode_error, /a local CA is installed/)
  const staleWarn = logged.find((l) => l.event === 'aigw.proxy_mode_stale_ca')
  assert.ok(staleWarn, 'the stale-CA warning is emitted')

  // The warning has to name a remedy that actually works. Attach deliberately
  // leaves the CA on disk (it offers the trust back rather than taking it), so
  // telling the operator to re-attach leaves the install exactly as degraded
  // as it was, every time, until the CA is gone.
  // @ref LLP 0262#migration [tests]: the stale-CA remedy cannot be a plain re-attach
  const reason = String(staleWarn.attrs.reason ?? '')
  assert.match(reason, /hyp detach claude --purge/)
  assert.doesNotMatch(reason, /run `hyp attach claude` to move it back/)

  // The tunnel is still served, so an already-attached client keeps its egress
  // instead of losing all HTTPS. (The byte-level round trip is covered by
  // test/plugins/ai-gateway-connect-front-door.test.js.)
  const statusLine = await new Promise((resolve, reject) => {
    const socket = net.connect(details.port, details.host, () => {
      socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: x\r\n\r\n`)
    })
    /** @type {Buffer} */
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)])
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      const line = buf.subarray(0, buf.indexOf('\r\n')).toString('ascii')
      socket.destroy()
      resolve(line)
    })
    socket.on('close', () => resolve('closed with no response'))
    socket.on('error', reject)
  })
  assert.match(statusLine, /^HTTP\/1\.1 200 /)
})

// The same stranding, reached by the other route. An empty routing table used
// to return before the front door was ever considered, so a machine whose
// upstreams went away (a config edit, an adapter that stopped registering its
// preset) stopped binding at all - and a client attached in proxy mode has
// `HTTPS_PROXY` pointing at that port for ALL of its egress, so it loses
// authentication and updates, not just capture.
// @ref LLP 0233#degrade-to-blind-tunnels [tests]
test('an empty routing table with a CA installed still serves blind tunnels', async (t) => {
  const hypHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-stranded-'))
  t.after(() => fsp.rm(hypHome, { recursive: true, force: true }))
  await ensureLocalCa({ stateRoot: path.join(hypHome, 'hypaware'), hosts: ['api.anthropic.com'] })

  const echo = net.createServer((socket) => socket.pipe(socket))
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', () => resolve(undefined)))
  const echoAddress = echo.address()
  const echoPort = echoAddress && typeof echoAddress === 'object' ? echoAddress.port : 0
  t.after(() => new Promise((resolve) => echo.close(() => resolve(undefined))))

  /** @type {{ level: string, event: string }[]} */
  const logged = []
  /** @param {string} level */
  const record = (level) => (/** @type {string} */ event) => logged.push({ level, event })
  const ctx = /** @type {any} */ ({
    config: { listen: '127.0.0.1:0', proxy_mode: true, upstreams: [] },
    env: { HYP_HOME: hypHome },
    storage: { cacheTablePath: (/** @type {string} */ d) => d, async appendRows() {} },
    log: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
  })
  const source = await createStartSource(createGatewayState())(ctx)
  t.after(() => source.stop())

  assert.ok(source.status, 'the source exposes status()')
  const details = /** @type {any} */ ((await source.status()).details)
  assert.equal(details.listening, undefined, 'the listener bound rather than idling')
  assert.equal(logged.some((l) => l.event === 'aigw.idle_serves_tunnels'), true)

  const statusLine = await new Promise((resolve, reject) => {
    const socket = net.connect(details.port, details.host, () => {
      socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: x\r\n\r\n`)
    })
    /** @type {Buffer} */
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)])
      if (buf.indexOf('\r\n\r\n') === -1) return
      const line = buf.subarray(0, buf.indexOf('\r\n')).toString('ascii')
      socket.destroy()
      resolve(line)
    })
    socket.on('close', () => resolve('closed with no response'))
    socket.on('error', reject)
  })
  assert.match(statusLine, /^HTTP\/1\.1 200 /)
})

// The other half of that guard: with nothing pointed at the port, an empty
// routing table still idles exactly as LLP 0195 settled. Binding unconditionally
// would make every hermes-only install hold a port it has no use for.
// @ref LLP 0195#idle-not-throw [tests]
test('an empty routing table with no CA still idles', async (t) => {
  const rig = await bootSource({ listen: '127.0.0.1:0', proxy_mode: true, upstreams: [] })
  t.after(() => rig.cleanup())

  assert.ok(rig.source.status, 'the source exposes status()')
  const status = await rig.source.status()
  assert.equal(/** @type {any} */ (status.details).listening, false)
  assert.match(String(status.message), /^idle: /)
})
