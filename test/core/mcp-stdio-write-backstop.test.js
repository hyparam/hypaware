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
 * @param {(err: unknown) => void} [reporter] runs after each call is recorded, so a test can make onError raise
 * @returns {Promise<{ chunks: string[], errors: unknown[] }>}
 */
async function drive(handleMessage, messages, stdout, reporter) {
  /** @type {string[]} */
  const chunks = []
  /** @type {unknown[]} */
  const errors = []
  await serveStdio({
    server: { handleMessage },
    stdin: Readable.from(messages.map((m) => JSON.stringify(m) + '\n')),
    stdout: stdout ?? { write: (chunk) => chunks.push(chunk) },
    onError: (err) => {
      errors.push(err)
      if (reporter) reporter(err)
    },
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

test('the backstop line forms for every id off the wire that JSON can write down', async () => {
  // Every id the backstop can use arrived through `JSON.parse`, which cannot
  // produce a BigInt, a cycle, a `toJSON`, or an `undefined`. Ids JSON-RPC does
  // not sanction still parse, so the backstop must survive them too. It is not
  // total, though: `writeResponse`'s own caveat records the one id it cannot
  // answer, nested past the depth `JSON.stringify` will take.
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

test('the backstop answers the id off the wire, not the one on the response', async () => {
  // The wire id came through `JSON.parse`; the response id is whatever the
  // handler built, and can be exactly the kind of value that made the write
  // fail. Answering with the response's own id would let the poison choose the
  // id of its own error reply and take the backstop line down with it.
  const { chunks, errors } = await drive(
    async () => ({ jsonrpc: '2.0', id: 1n, result: {} }),
    [{ jsonrpc: '2.0', id: 5, method: 'ping' }],
  )
  assert.equal(chunks.length, 1)
  assert.equal(JSON.parse(chunks[0]).id, 5)
  assert.equal(JSON.parse(chunks[0]).error.code, -32603)
  assert.equal(errors.length, 1)
})

test('a write that fails on an honest response is reported as itself, with no second write', async () => {
  // The `try` covers the `JSON.stringify` and not the `write`. A stream that
  // refuses one write must not be told the response could not be serialized
  // (it could), and must not be handed a second line it did not ask for. The
  // stream here accepts the second write, so a stray fallback would show up.
  /** @type {string[]} */
  const seen = []
  let attempts = 0
  const { errors } = await drive(
    async () => ({ jsonrpc: '2.0', id: 5, result: {} }),
    [{ jsonrpc: '2.0', id: 5, method: 'ping' }],
    { write: (chunk) => { seen.push(chunk); if (++attempts === 1) throw new Error('EPIPE') } },
  )
  assert.equal(attempts, 1, 'the failed honest write must not be retried or followed by a fallback')
  assert.equal(errors.length, 1)
  assert.equal(/** @type {Error} */ (errors[0]).message, 'EPIPE')
})

test('a toJSON that throws a value String() cannot take still gets its line', async () => {
  // `describeThrown`'s catch is load-bearing, not decoration. The reason string
  // is built from whatever a `toJSON` threw, and `String()` raises on a value
  // with no primitive conversion; that build happens before the fallback write,
  // so a raise there escapes `writeResponse` with no line written at all and
  // turns an answerable id straight back into the forever-wait. `Object.create(null)`
  // is the shape: JSON.stringify propagates a thrown value verbatim.
  const { chunks, errors } = await drive(
    async () => ({ jsonrpc: '2.0', id: 5, result: { toJSON() { throw Object.create(null) } } }),
    [{ jsonrpc: '2.0', id: 5, method: 'ping' }],
  )
  assert.equal(chunks.length, 1)
  const reply = JSON.parse(chunks[0])
  assert.equal(reply.id, 5)
  assert.equal(reply.error.code, -32603)
  assert.equal(typeof reply.error.message, 'string')
  assert.equal(errors.length, 1)
})

// The result of the `.catch` that calls `onError` is the chain the next line is
// sequenced onto, and `chain.then(...)` skips its callback on a rejected chain,
// so an `onError` that raises cost every later message on the session its
// dispatch and its reply. These drive the real transport with the real coercion
// both shipped `onError` bodies use, because the guard whose whole job is "one
// bad line can't kill the session" must not be the thing that kills it.

/**
 * The body both `onError`s in the tree have: `src/core/commands/mcp.js` and
 * `src/core/mcp/proxy.js` each build a log attribute this way.
 *
 * @param {unknown} err
 */
function bareIdiom(err) {
  void (err instanceof Error ? err.message : String(err))
}

const reporterPoison = /** @type {[string, () => unknown][]} */ ([
  // `String()` raises: no primitive conversion at all.
  ['a value String() cannot take', () => Object.create(null)],
  // `.message` raises: `instanceof Error` holds, so the idiom reads the getter.
  ['an Error subclass whose message getter throws', () => new (class extends Error {
    /** @returns {string} */
    get message() { throw new Error('message getter blew up') }
  })()],
])

for (const [label, poison] of reporterPoison) {
  test(`later messages still get their replies when onError raises on ${label}`, async () => {
    // `JSON.stringify` propagates whatever a `toJSON` threw verbatim, and
    // `writeResponse` rethrows it, so the value reaches `onError` intact.
    const thrown = poison()
    const { chunks, errors } = await drive(
      async (message) => message.id === 1
        ? { jsonrpc: '2.0', id: 1, result: { toJSON() { throw thrown } } }
        : { jsonrpc: '2.0', id: message.id, result: {} },
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
        { jsonrpc: '2.0', id: 3, method: 'ping' },
      ],
      undefined,
      bareIdiom,
    )

    // The whole point: ids 2 and 3 got no line at all before the fix.
    assert.deepEqual(chunks.map((c) => JSON.parse(c).id), [1, 2, 3])
    assert.equal(JSON.parse(chunks[0]).error.code, -32603)
    assert.deepEqual(JSON.parse(chunks[1]).result, {})
    assert.deepEqual(JSON.parse(chunks[2]).result, {})

    // The reporter's own failure is not swallowed: it comes back through the
    // same channel as a plain `Error`, which the bare idiom can read, so the
    // operator hears that a report was lost rather than nothing at all.
    assert.equal(errors.length, 2)
    assert.equal(errors[0], thrown)
    assert.ok(errors[1] instanceof Error)
    assert.match(errors[1].message, /error report failed/)
  })
}

test('an onError that raises on everything, its own notice included, still does not cost a later message its reply', async () => {
  const { chunks, errors } = await drive(
    async (message) => message.id === 1
      ? { jsonrpc: '2.0', id: 1, result: 1n }
      : { jsonrpc: '2.0', id: message.id, result: {} },
    [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ],
    undefined,
    () => { throw new Error('onError blew up') },
  )

  assert.deepEqual(chunks.map((c) => JSON.parse(c).id), [1, 2])
  // Both calls were made; both raised. A handler beyond reporting to is where
  // the notice stops, not where the session does.
  assert.equal(errors.length, 2)
})
