// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import process from 'node:process'

import { serveStdio } from '../../src/core/mcp/stdio.js'

// `handleMessage` promises the client always gets a reply: its catch turns any
// throw into a `-32603` object. The object is not the reply. `serveStdio` is where
// the "one line per message" guarantee is actually kept, and it wrote the response
// with a bare `JSON.stringify`, so a response holding a value JSON cannot take made
// that write raise, sent the failure to `onError` off-channel, and wrote no line at
// all - the same forever-wait the `-32603` exists to end, one layer out and
// invisible to a server that had already returned a well-formed object. PR #1544
// closed the two paths that reached this from a hostile registration; these drive
// the transport itself, because the point of the backstop is that a method added
// later cannot reopen the hole.

/**
 * Drive messages through the real transport over real streams and report what
 * the client would actually have received.
 *
 * @param {(message: any) => Promise<object | null>} handleMessage
 * @param {object[]} messages
 * @param {{ write: (chunk: string) => unknown }} [stdout]
 * @returns {Promise<{ chunks: string[], errors: unknown[] }>}
 */
async function drive(handleMessage, messages, stdout) {
  /** @type {string[]} */
  const chunks = []
  /** @type {unknown[]} */
  const errors = []
  await serveStdio({
    server: { handleMessage },
    stdin: Readable.from(messages.map((m) => JSON.stringify(m) + '\n')),
    stdout: stdout ?? { write: (chunk) => chunks.push(chunk) },
    onError: (err) => errors.push(err),
  })
  return { chunks, errors }
}

const unserializable = /** @type {[string, () => unknown][]} */ ([
  ['a BigInt', () => 1n],
  ['a cycle', () => { const o = /** @type {any} */ ({}); o.self = o; return o }],
  ['a throwing toJSON', () => ({ toJSON() { throw new Error('no result for you') } })],
])

for (const [label, poison] of unserializable) {
  for (const id of /** @type {(string | number)[]} */ ([7, 'req-7'])) {
    test(`a response carrying ${label} still gets one -32603 line for id ${JSON.stringify(id)}`, async () => {
      const { chunks, errors } = await drive(
        async () => ({ jsonrpc: '2.0', id, result: { tools: [poison()] } }),
        [{ jsonrpc: '2.0', id, method: 'tools/list' }],
      )

      assert.equal(chunks.length, 1)
      assert.ok(chunks[0].endsWith('\n'))
      const reply = JSON.parse(chunks[0])
      assert.equal(reply.jsonrpc, '2.0')
      assert.equal(reply.id, id)
      assert.equal(reply.error.code, -32603)
      assert.equal(typeof reply.error.message, 'string')
      assert.equal(reply.result, undefined)
      // The original failure is still reported off-channel: the fallback is a
      // backstop for the client, not a way to hide the bug from the operator.
      assert.equal(errors.length, 1)
    })
  }
}

test('the -32603 backstop carries the reason, so the client is told why', async () => {
  const { chunks } = await drive(
    async () => ({ jsonrpc: '2.0', id: 1, result: 1n }),
    [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
  )
  assert.match(JSON.parse(chunks[0]).error.message, /BigInt/)
})

test('a response id off the wire is serializable by construction, so the backstop line always forms', async () => {
  // Every id the backstop can use arrived through `JSON.parse`, which cannot
  // produce a BigInt, a cycle, a `toJSON`, or an `undefined`. Ids JSON-RPC does
  // not sanction still parse, so the backstop must survive them too.
  const ids = /** @type {any[]} */ ([0, -1, 1.5, '', 'x'.repeat(1000), null, [1, 2], { a: { b: 1 } }, true])
  for (const id of ids) {
    const { chunks } = await drive(
      async () => ({ jsonrpc: '2.0', id, result: 1n }),
      [{ jsonrpc: '2.0', id, method: 'ping' }],
    )
    assert.equal(chunks.length, 1, `no line for id ${JSON.stringify(id)}`)
    assert.deepEqual(JSON.parse(chunks[0]).id, id)
  }
})

test('a notification stays unanswered even when its response cannot be serialized', async () => {
  // A message with no id is owed no reply, so the backstop must not invent one.
  // The real server returns null here; a handler that answered anyway must
  // still not put a line on the wire naming an id the client never sent.
  const { chunks, errors } = await drive(
    async (message) => message.method === 'notifications/initialized'
      ? { jsonrpc: '2.0', result: 1n }
      : null,
    [{ jsonrpc: '2.0', method: 'notifications/initialized' }],
  )
  assert.deepEqual(chunks, [])
  assert.equal(errors.length, 1)
})

test('a notification whose handler returns null writes nothing at all', async () => {
  const { chunks, errors } = await drive(
    async () => null,
    [{ jsonrpc: '2.0', method: 'notifications/initialized' }],
  )
  assert.deepEqual(chunks, [])
  assert.deepEqual(errors, [])
})

test('an honest response is written as exactly the bytes it was before', async () => {
  const response = { jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'query_sql', description: 'Run SQL', inputSchema: { type: 'object' } }] } }
  const { chunks, errors } = await drive(
    async () => response,
    [{ jsonrpc: '2.0', id: 3, method: 'tools/list' }],
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(chunks, [JSON.stringify(response) + '\n'])
})

test('one bad response does not cost the messages either side of it their lines', async () => {
  const { chunks, errors } = await drive(
    async (message) => message.id === 2
      ? { jsonrpc: '2.0', id: 2, result: 1n }
      : { jsonrpc: '2.0', id: message.id, result: {} },
    [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ],
  )
  assert.deepEqual(chunks.map((c) => JSON.parse(c).id), [1, 2, 3])
  assert.equal(JSON.parse(chunks[1]).error.code, -32603)
  assert.equal(errors.length, 1)
})

test('a stdout that throws on every write reaches onError once, with no unhandled rejection', async () => {
  // The fallback write can fail the same way the first one did (a closed or
  // erroring stdout). That path must still land in onError rather than loop or
  // throw past the caller.
  /** @type {unknown[]} */
  const unhandled = []
  const onUnhandled = (/** @type {unknown} */ err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandled)
  try {
    const { errors } = await drive(
      async () => ({ jsonrpc: '2.0', id: 9, result: 1n }),
      [{ jsonrpc: '2.0', id: 9, method: 'tools/list' }],
      { write: () => { throw new Error('EPIPE') } },
    )
    // The original serialization failure, not the write failure that replaced
    // it: the fallback write is swallowed so the operator still hears why.
    assert.equal(errors.length, 1)
    assert.match(String(/** @type {Error} */ (errors[0]).message), /BigInt/)
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a stdout that throws on an honest write still reaches onError', async () => {
  const { errors } = await drive(
    async () => ({ jsonrpc: '2.0', id: 9, result: {} }),
    [{ jsonrpc: '2.0', id: 9, method: 'ping' }],
    { write: () => { throw new Error('EPIPE') } },
  )
  assert.equal(errors.length, 1)
  assert.equal(/** @type {Error} */ (errors[0]).message, 'EPIPE')
})
