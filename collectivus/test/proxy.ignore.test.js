import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Proxy } from '../src/proxy.js'
import { Recorder } from '../src/recorder.js'
import { IgnoreFilter } from '../src/ignore.js'

/**
 * @import { Server } from 'node:http'
 * @import { CollectingSink } from './types.js'
 */

/**
 * @returns {CollectingSink}
 */
function makeCollectingSink() {
  /** @type {any[]} */
  const rows = []
  return {
    rows,
    writeRow(obj) {
      rows.push(obj)
      return Promise.resolve()
    },
    close() {
      return Promise.resolve()
    },
  }
}

/**
 * @returns {Promise<{ server: Server, baseUrl: string, port: number }>}
 */
function createEchoUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('no address')
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}`, port: addr.port })
    })
  })
}

/**
 * @param {Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)))
}

/**
 * @param {Proxy} proxy
 * @returns {string}
 */
function proxyOrigin(proxy) {
  const addr = proxy.server?.address()
  if (!addr || typeof addr === 'string') throw new Error('proxy not bound')
  return `http://127.0.0.1:${addr.port}`
}

/** @type {Awaited<ReturnType<typeof createEchoUpstream>>} */
let upstream
/** @type {Proxy} */
let proxy
/** @type {IgnoreFilter} */
let ignoreFilter
/** @type {CollectingSink} */
let sink
/** @type {Recorder} */
let recorder
/** @type {string} */
let tmpDir

beforeEach(async function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ignore-'))
  upstream = await createEchoUpstream()
  sink = makeCollectingSink()
  recorder = new Recorder({ sink })
  ignoreFilter = new IgnoreFilter({ configPath: path.join(tmpDir, 'collectivus.json') })
  await ignoreFilter.load()
  proxy = new Proxy({
    listen: '127.0.0.1:0',
    upstreams: [{ name: 'echo', base_url: upstream.baseUrl, match: { path_prefix: '/v1' } }],
  }, { recorder, ignoreFilter })
  await proxy.start()
})

afterEach(async function() {
  await proxy.stop()
  await closeServer(upstream.server)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function postMessages(sessionId) {
  const body = JSON.stringify({
    model: 'claude-x',
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
  })
  const res = await fetch(`${proxyOrigin(proxy)}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  expect(res.status).toBe(200)
  await res.text()
}

describe('Proxy — ignore filter end-to-end', function() {
  it('records the request when no rule matches', async function() {
    await postMessages('sess-record')
    expect(sink.rows.filter((r) => r.kind === 'exchange')).toHaveLength(1)
  })

  it('drops the request when the session is in the ignored set', async function() {
    ignoreFilter.addIgnoredSession('sess-ignored')
    await postMessages('sess-ignored')
    expect(sink.rows.filter((r) => r.kind === 'exchange')).toHaveLength(0)
  })

  it('drops the request when its cwd is covered by a registered path', async function() {
    const ignoredDir = path.join(tmpDir, 'project')
    fs.mkdirSync(ignoredDir)
    await ignoreFilter.addPath(ignoredDir)
    // Pre-populate the session context the proxy would have learned from the
    // Claude Code SessionStart hook.
    await fetch(`${proxyOrigin(proxy)}/_collectivus/session-context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-cwd', cwd: ignoredDir }),
    })

    await postMessages('sess-cwd')
    expect(sink.rows.filter((r) => r.kind === 'exchange')).toHaveLength(0)
  })

  it('drops the request when a .ctvsignore ancestor exists', async function() {
    const project = path.join(tmpDir, 'project')
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.writeFileSync(path.join(project, '.ctvsignore'), '')
    await fetch(`${proxyOrigin(proxy)}/_collectivus/session-context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-marker', cwd: path.join(project, 'src') }),
    })
    await postMessages('sess-marker')
    expect(sink.rows.filter((r) => r.kind === 'exchange')).toHaveLength(0)
  })
})

describe('Proxy — /_collectivus/ignore/session', function() {
  /**
   * @param {string} method
   * @param {object} [body]
   * @returns {Promise<{ status: number, json: any }>}
   */
  async function callEndpoint(method, body) {
    const init = /** @type {RequestInit} */ ({
      method,
      headers: { 'content-type': 'application/json' },
    })
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(`${proxyOrigin(proxy)}/_collectivus/ignore/session`, init)
    const text = await res.text()
    const json = text ? JSON.parse(text) : {}
    return { status: res.status, json }
  }

  it('POST registers and returns the total', async function() {
    const { status, json } = await callEndpoint('POST', { session_id: 's-1' })
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true, total: 1 })
    expect(ignoreFilter.hasIgnoredSession('s-1')).toBe(true)
  })

  it('DELETE removes and reports whether the entry existed', async function() {
    ignoreFilter.addIgnoredSession('s-1')
    const { status, json } = await callEndpoint('DELETE', { session_id: 's-1' })
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true, removed: true, total: 0 })
  })

  it('GET returns the current ignored set', async function() {
    ignoreFilter.addIgnoredSession('a')
    ignoreFilter.addIgnoredSession('b')
    const { status, json } = await callEndpoint('GET')
    expect(status).toBe(200)
    expect(json).toEqual({ ignored: ['a', 'b'], total: 2 })
  })

  it('rejects POST without session_id', async function() {
    const { status, json } = await callEndpoint('POST', { wrong: 'x' })
    expect(status).toBe(400)
    expect(json.error).toMatch(/session_id is required/)
  })

  it('rejects invalid JSON', async function() {
    const res = await fetch(`${proxyOrigin(proxy)}/_collectivus/ignore/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  it('returns 405 for unsupported verbs', async function() {
    const res = await fetch(`${proxyOrigin(proxy)}/_collectivus/ignore/session`, { method: 'PUT' })
    expect(res.status).toBe(405)
  })

  it('returns 503 when the filter is not configured', async function() {
    // Spin up a second proxy without an IgnoreFilter and confirm the endpoint
    // declines instead of being silently absent.
    const sinkB = makeCollectingSink()
    const recorderB = new Recorder({ sink: sinkB })
    const proxyB = new Proxy({
      listen: '127.0.0.1:0',
      upstreams: [{ name: 'echo', base_url: upstream.baseUrl, match: { path_prefix: '/v1' } }],
    }, { recorder: recorderB })
    await proxyB.start()
    try {
      const res = await fetch(`${proxyOrigin(proxyB)}/_collectivus/ignore/session`, { method: 'GET' })
      expect(res.status).toBe(503)
    } finally {
      await proxyB.stop()
    }
  })
})
