// @ts-check

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createControlHandler } from '../../hypaware-core/plugins-workspace/ai-gateway/src/control.js'
import { isControlPath } from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

// @ref LLP 0066#control-path [tests] / LLP 0066#requirements — the reserved
// `/_hypaware/` control surface: POST/DELETE /_hypaware/ignore/session over
// the in-memory ignored-session set, idempotent, returning `.total`; the
// error grid (400/404/405/413).

test('POST adds a session id and reports ignored:true with the running total', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const out = await postSession(base, 'sess-a')
    assert.equal(out.status, 200)
    assert.deepEqual(out.body, { session_id: 'sess-a', ignored: true, total: 1 })
    assert.ok(set.has('sess-a'), 'the session id landed in the shared set')
  })
})

test('DELETE removes a session id and reports ignored:false', async () => {
  const set = new Set(['sess-a'])
  await withControlServer(set, async (base) => {
    const out = await deleteSession(base, 'sess-a')
    assert.equal(out.status, 200)
    assert.deepEqual(out.body, { session_id: 'sess-a', ignored: false, total: 0 })
    assert.equal(set.has('sess-a'), false, 'the session id was removed from the set')
  })
})

test('both verbs are idempotent and .total tracks the set across a sequence', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    assert.equal((await postSession(base, 's1')).body.total, 1)
    assert.equal((await postSession(base, 's2')).body.total, 2)
    // Re-POSTing an already-ignored id is a 200 no-op: still ignored, no growth.
    const reAdd = await postSession(base, 's1')
    assert.deepEqual(reAdd.body, { session_id: 's1', ignored: true, total: 2 })
    assert.equal((await deleteSession(base, 's1')).body.total, 1)
    // DELETEing an unknown id is a 200 no-op.
    const reDel = await deleteSession(base, 's1')
    assert.deepEqual(reDel.body, { session_id: 's1', ignored: false, total: 1 })
    assert.equal((await deleteSession(base, 's2')).body.total, 0)
    assert.equal(set.size, 0)
  })
})

test('session_id is trimmed and the trimmed token is what is stored', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const out = await postSession(base, '  sess-pad  ')
    assert.equal(out.status, 200)
    assert.equal(out.body.session_id, 'sess-pad')
    assert.ok(set.has('sess-pad'))
  })
})

test('400 when session_id is missing, empty, or not a string', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    for (const body of [JSON.stringify({}), JSON.stringify({ session_id: '' }), JSON.stringify({ session_id: '   ' }), JSON.stringify({ session_id: 123 })]) {
      const out = await rawRequest(base, 'POST', '/_hypaware/ignore/session', body)
      assert.equal(out.status, 400, `expected 400 for body ${body}`)
    }
    assert.equal(set.size, 0, 'no id is recorded on a 400')
  })
})

test('400 on malformed JSON', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const out = await rawRequest(base, 'POST', '/_hypaware/ignore/session', '{ not json')
    assert.equal(out.status, 400)
    assert.equal(set.size, 0)
  })
})

test('405 on an unsupported method for the ignore route', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const out = await rawRequest(base, 'PUT', '/_hypaware/ignore/session', JSON.stringify({ session_id: 's' }))
    assert.equal(out.status, 405)
    assert.equal(out.headers.get('allow'), 'POST, DELETE')
    assert.equal(set.size, 0)
  })
})

test('404 on an unknown /_hypaware/* control path', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const out = await rawRequest(base, 'POST', '/_hypaware/unknown/thing', JSON.stringify({ session_id: 's' }))
    assert.equal(out.status, 404)
    assert.equal(set.size, 0)
  })
})

test('413 when the request body exceeds the size bound', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const huge = 'x'.repeat(70 * 1024)
    const out = await rawRequest(base, 'POST', '/_hypaware/ignore/session', JSON.stringify({ session_id: huge }))
    assert.equal(out.status, 413)
    assert.equal(set.size, 0, 'an oversized body records nothing')
  })
})

test('a control request emits a structured ignore log carrying the running total', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  /** @type {Array<{ message: string, fields: Record<string, unknown> }>} */
  const logs = []
  const log = {
    debug() {}, warn() {}, error() {},
    /** @param {string} message @param {Record<string, unknown>=} fields */
    info(message, fields) { logs.push({ message, fields: fields ?? {} }) },
  }
  const handler = createControlHandler({ ignoredSessions: set, log })
  await withHandler(handler, async (base) => {
    await postSession(base, 'sess-logged')
    const entry = logs.find((l) => l.message === 'aigw.control.ignore_session')
    assert.ok(entry, 'a structured ignore log is emitted')
    assert.equal(entry.fields.operation, 'ignore_session')
    assert.equal(entry.fields.session_id, 'sess-logged')
    assert.equal(entry.fields.ignored, true)
    assert.equal(entry.fields.total, 1)
  })
})

test('isControlPath recognizes the reserved prefix at segment boundaries only', () => {
  assert.equal(isControlPath('/_hypaware'), true)
  assert.equal(isControlPath('/_hypaware/ignore/session'), true)
  assert.equal(isControlPath('/_hypaware/anything'), true)
  assert.equal(isControlPath('/_hypawarefoo'), false, 'a look-alike path is not a control path')
  assert.equal(isControlPath('/v1/messages'), false)
})

/**
 * Start an HTTP server that dispatches `/_hypaware/*` to a fresh control
 * handler over `set` (mirroring the proxy's control short-circuit), run the
 * body, and always tear the server down.
 *
 * @param {Set<string>} set
 * @param {(base: string) => Promise<void>} body
 */
async function withControlServer(set, body) {
  const handler = createControlHandler({ ignoredSessions: set })
  await withHandler(handler, body)
}

/**
 * @param {(req: IncomingMessage, res: ServerResponse, url: URL) => void} handler
 * @param {(base: string) => Promise<void>} body
 */
async function withHandler(handler, body) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    if (isControlPath(url.pathname)) {
      handler(req, res, url)
      return
    }
    req.resume()
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    await body(base)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)))
    })
  }
}

/** @param {string} base @param {string} sessionId */
function postSession(base, sessionId) {
  return rawRequest(base, 'POST', '/_hypaware/ignore/session', JSON.stringify({ session_id: sessionId }))
}

/** @param {string} base @param {string} sessionId */
function deleteSession(base, sessionId) {
  return rawRequest(base, 'DELETE', '/_hypaware/ignore/session', JSON.stringify({ session_id: sessionId }))
}

/**
 * @param {string} base
 * @param {string} method
 * @param {string} path
 * @param {string} [reqBody]
 */
async function rawRequest(base, method, path, reqBody) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: reqBody,
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  return { status: res.status, headers: res.headers, body: parsed }
}
