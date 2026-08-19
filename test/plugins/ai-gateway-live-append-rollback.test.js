// @ts-check

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createStartSource } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'

/**
 * @import { AiGatewayProjectedMessage } from '../../hypaware-plugin-kernel-types.js'
 */

// The live lane projects an exchange, marks its messages seen, and only then
// hands the rows to storage. When that append fails the messages stay marked,
// so every later replay of the same conversation dedups them away and the live
// lane never writes them again. These tests drive real traffic through the
// gateway with a storage whose first append rejects, then let the client
// replay, which is exactly what a client does on its next turn.
// @ref LLP 0026#consequences [tests]: the seen-set may only carry messages a
//   write actually kept, or a replay stops being the repair path it is for.

test('a rejected live append leaves its messages eligible for the next replay', async () => {
  const upstream = await startEchoUpstream()
  const state = createGatewayState()

  // Turn 1 sends one message; turn 2 replays it and adds the next, which is
  // how every one of these clients frames a conversation.
  const turns = [
    [message('uuid-1', 'user', 'first')],
    [message('uuid-1', 'user', 'first'), message('uuid-2', 'assistant', 'second')],
  ]
  let turn = 0
  state.projectors.push(projector(() => ({
    provider: 'native',
    session_id: 'sess-rollback',
    messages: turns[Math.min(turn++, turns.length - 1)],
  })))

  const storage = failingStorage(1)
  const source = await createStartSource(state)(fakeCtx({
    listen: '127.0.0.1:0',
    upstreams: [{ name: 'echo', base_url: upstream.url, path_prefix: '/' }],
  }, storage))

  try {
    const base = await listenBase(source)
    await fetchOk(`${base}/v1/messages`)
    await storage.waitForAttempts(1)
    assert.equal(storage.written.length, 0, 'the first append rejected, so nothing was written')

    await fetchOk(`${base}/v1/messages`)
    await storage.waitForAttempts(2)

    const writtenIds = storage.written.flat().map((row) => row.message_id)
    assert.deepEqual(
      [...new Set(writtenIds)].sort(),
      ['uuid-1', 'uuid-2'],
      'the replay re-emits the message the failed append lost, alongside the new one'
    )
  } finally {
    await source.stop()
    await upstream.close()
  }
})

test('the rollback is scoped to the failed append, so a written message is not re-emitted', async () => {
  const upstream = await startEchoUpstream()
  const state = createGatewayState()

  const turns = [
    [message('uuid-1', 'user', 'first')],
    [message('uuid-1', 'user', 'first'), message('uuid-2', 'assistant', 'second')],
  ]
  let turn = 0
  state.projectors.push(projector(() => ({
    provider: 'native',
    session_id: 'sess-no-rollback',
    messages: turns[Math.min(turn++, turns.length - 1)],
  })))

  // Nothing fails here: the second turn must still dedup the first turn's
  // message, or the rollback would have traded a dropped row for a double
  // write on the ordinary path.
  const storage = failingStorage(0)
  const source = await createStartSource(state)(fakeCtx({
    listen: '127.0.0.1:0',
    upstreams: [{ name: 'echo', base_url: upstream.url, path_prefix: '/' }],
  }, storage))

  try {
    const base = await listenBase(source)
    await fetchOk(`${base}/v1/messages`)
    await storage.waitForAttempts(1)
    await fetchOk(`${base}/v1/messages`)
    await storage.waitForAttempts(2)

    assert.deepEqual(
      storage.written.map((batch) => batch.map((row) => row.message_id)),
      [['uuid-1'], ['uuid-2']],
      'each message is written exactly once'
    )
  } finally {
    await source.stop()
    await upstream.close()
  }
})

/**
 * @param {string} messageId
 * @param {string} role
 * @param {string} text
 * @returns {AiGatewayProjectedMessage}
 */
function message(messageId, role, text) {
  return /** @type {any} */ ({ role, content: text, message_id: messageId })
}

/** @param {() => Record<string, unknown>} project */
function projector(project) {
  return /** @type {any} */ ({
    name: 'native',
    priority: 0,
    match: () => true,
    project,
    _seq: 0,
  })
}

/**
 * Storage whose first `failCount` appends reject the way a full or failing
 * device does, and which records every batch that actually landed.
 * @param {number} failCount
 */
function failingStorage(failCount) {
  let attempts = 0
  /** @type {Record<string, unknown>[][]} */
  const written = []
  /** @type {(() => void)[]} */
  const waiters = []
  return {
    written,
    /** @param {number} n */
    async waitForAttempts(n) {
      while (attempts < n) await new Promise((resolve) => { waiters.push(() => resolve(undefined)) })
    },
    /** @param {string} dataset @param {string[]=} partitions */
    cacheTablePath(dataset, partitions) {
      return [dataset, ...(partitions ?? [])].join('/')
    },
    /**
     * @param {string} _tablePath
     * @param {unknown} _columns
     * @param {Record<string, unknown>[]} rows
     */
    async appendRows(_tablePath, _columns, rows) {
      attempts++
      const failing = attempts <= failCount
      if (!failing) written.push(rows)
      for (const waiter of waiters.splice(0)) waiter()
      if (failing) throw new Error('ENOSPC: no space left on device')
    },
  }
}

/**
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} storage
 */
function fakeCtx(config, storage) {
  return /** @type {any} */ ({
    config,
    storage,
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  })
}

/** @param {any} source */
async function listenBase(source) {
  const status = await source.status()
  assert.ok(status.details, 'status carries details')
  return `http://${status.details.host}:${status.details.port}`
}

async function startEchoUpstream() {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
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
async function fetchOk(url) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)
  await res.text()
}
