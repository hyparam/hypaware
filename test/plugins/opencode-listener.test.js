// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'

import { createStartOpenCodeSource } from '../../hypaware-core/plugins-workspace/opencode/src/listener.js'

function makeStorage() {
  /** @type {Record<string, unknown>[]} */
  const appended = []
  return {
    appended,
    cacheTablePath: (/** @type {string} */ dataset) => `/cache/${dataset}`,
    async discoverCachePartitions() { return [] },
    async *readRows() {},
    async *readSpooledRows() {},
    async appendRows(/** @type {string} */ _path, /** @type {unknown} */ _columns, /** @type {Record<string, unknown>[]} */ rows) {
      appended.push(...rows)
    },
  }
}

/** @param {string} id @param {string | undefined} directory @param {string} [entrypoint] */
function snapshot(id, directory, entrypoint = 'cli') {
  return {
    session: {
      id,
      ...(directory ? { directory } : {}),
      version: '1.18.22',
      time: { created: Date.parse('2026-08-24T10:00:00.000Z') },
    },
    messages: [
      {
        info: { id: `${id}-user`, role: 'user', time: { created: Date.parse('2026-08-24T10:00:01.000Z') } },
        parts: [{ id: `${id}-user-part`, type: 'text', text: 'Use the read tool' }],
      },
      {
        info: {
          id: `${id}-assistant`,
          role: 'assistant',
          parentID: `${id}-user`,
          providerID: 'openai',
          modelID: 'gpt-5.6-luna',
          finish: 'stop',
          time: {
            created: Date.parse('2026-08-24T10:00:02.000Z'),
            completed: Date.parse('2026-08-24T10:00:04.000Z'),
          },
        },
        parts: [
          { id: `${id}-text`, type: 'text', text: 'Reading it.' },
          {
            id: `${id}-tool`,
            type: 'tool',
            callID: `${id}-call`,
            tool: 'read',
            state: {
              status: 'completed',
              input: { path: 'notes.txt' },
              output: 'notes fixture',
              title: 'Read',
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        ],
      },
    ],
    entrypoint,
    entrypoint_source: 'plugin-process',
    trigger: 'message.updated',
  }
}

async function startListener() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-opencode-listener-'))
  const policyPath = path.join(root, 'usage-policy', 'local-only.json')
  const storage = makeStorage()
  /** @type {Array<{ event: string, fields: Record<string, unknown> }>} */
  const logs = []
  const sink = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields) => logs.push({ event, fields })
  const ignoredSessions = new Set()
  const start = createStartOpenCodeSource({ localOnlyListPath: policyPath, ignoredSessions })
  const source = await start(/** @type {any} */ ({
    config: { listen_port: 0 },
    storage,
    log: { info: sink, warn: sink, error: sink, debug: sink },
  }))
  const status = await source.status?.()
  const port = /** @type {number} */ (status?.details?.listen_port)
  const endpoint = `http://127.0.0.1:${port}`
  return {
    root,
    policyPath,
    storage,
    logs,
    source,
    endpoint,
    /** @param {unknown} body */
    post(body) {
      return fetch(`${endpoint}/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
    async cleanup() {
      await source.stop()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * POST with an explicit `Host` header, which `fetch` forbids.
 *
 * @param {string} endpoint
 * @param {{ path: string, host: string, body?: unknown }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
function postWithHost(endpoint, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(new URL(endpoint).port),
        path: options.path,
        method: 'POST',
        headers: { host: options.host, 'content-type': 'application/json' },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(options.body ?? {}))
  })
}

test('OpenCode listener writes text and tool rows, converges replays, and publishes source health', async () => {
  const listener = await startListener()
  const cwd = path.join(listener.root, 'work')
  await fs.mkdir(cwd, { recursive: true })
  try {
    const first = await listener.post(snapshot('ses_live', cwd, 'desktop'))
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { status: 'ok', rowsWritten: 3, rowsSkipped: 0 })
    const replay = await listener.post(snapshot('ses_live', cwd, 'desktop'))
    assert.equal(replay.status, 200)
    assert.deepEqual(await replay.json(), { status: 'ok', rowsWritten: 0, rowsSkipped: 0 })

    assert.deepEqual(listener.storage.appended.map((row) => row.part_id), [
      'ses_live-user-part',
      'ses_live-text',
      'ses_live-tool',
    ])
    assert.equal(listener.storage.appended.every((row) => row.entrypoint === 'desktop'), true)
    assert.equal(listener.storage.appended.find((row) => row.part_id === 'ses_live-tool')?.tool_call_id, 'ses_live-call')

    const status = await listener.source.status?.()
    assert.equal(status?.state, 'ready')
    assert.equal(status?.rowsWritten, 3)
    assert.equal(status?.details?.plugin_events, 2)
    assert.equal(status?.details?.snapshots_received, 2)
    assert.equal(status?.details?.reconciliation_cursor, 'ses_live:ses_live-assistant')
    assert.equal(status?.details?.last_event_at === null, false)
    assert.deepEqual(status?.details?.control_routes, ['ignore/session'])
  } finally {
    await listener.cleanup()
  }
})

test('OpenCode listener applies .hypignore, machine policy, local-only, session ignore, and missing-cwd gates before writes', async () => {
  const listener = await startListener()
  const dotIgnored = path.join(listener.root, 'dot-ignored')
  const privateDir = path.join(listener.root, 'machine-private')
  const localOnly = path.join(listener.root, 'local-only')
  await fs.mkdir(dotIgnored, { recursive: true })
  await fs.mkdir(privateDir, { recursive: true })
  await fs.mkdir(localOnly, { recursive: true })
  await fs.writeFile(path.join(dotIgnored, '.hypignore'), 'ignore\n', 'utf8')
  await fs.mkdir(path.dirname(listener.policyPath), { recursive: true })
  await fs.writeFile(listener.policyPath, JSON.stringify({
    version: 2,
    entries: [
      { dir: privateDir, class: 'ignore' },
      { dir: localOnly, class: 'local-only' },
    ],
  }), 'utf8')
  try {
    const ignoredControl = await fetch(`${listener.endpoint}/_hypaware/ignore/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'ses_optout' }),
    })
    assert.equal(ignoredControl.status, 200)

    assert.equal((await listener.post(snapshot('ses_dot', dotIgnored))).status, 202)
    assert.equal((await listener.post(snapshot('ses_private', privateDir))).status, 202)
    assert.equal((await listener.post(snapshot('ses_optout', localOnly))).status, 202)
    assert.equal((await listener.post(snapshot('ses_missing', undefined))).status, 202)
    assert.equal((await listener.post(snapshot('ses_local', localOnly, 'unknown'))).status, 200)

    assert.equal(listener.storage.appended.length, 3)
    assert.equal(listener.storage.appended.every((row) => row.session_id === 'ses_local'), true)
    assert.equal(listener.storage.appended.every((row) => row.cwd === localOnly), true)

    const status = await listener.source.status?.()
    assert.equal(status?.details?.policy_drops, 2)
    assert.equal(status?.details?.session_drops, 1)
    assert.equal(status?.details?.missing_cwd, 1)
    assert.equal(status?.details?.unknown_entrypoints, 1)
    assert.equal(status?.details?.ignored_sessions, 1)
    assert.equal(status?.details?.store_activity_gaps, 0)
  } finally {
    await listener.cleanup()
  }
})

// DNS rebinding is what is left once the content-type gate is up: an attacker
// page whose domain re-resolves to 127.0.0.1 is same-origin with this
// listener, so it can post whatever content type it likes. What it cannot
// change is the `Host` it carries, which names the attacker, not loopback.
test('a request carrying a foreign Host reaches neither /snapshot nor the control route', async () => {
  const listener = await startListener()
  const cwd = path.join(listener.root, 'work')
  await fs.mkdir(cwd, { recursive: true })
  try {
    const injected = await postWithHost(listener.endpoint, {
      path: '/snapshot',
      host: 'attacker.example',
      body: snapshot('ses_rebound', cwd),
    })
    assert.equal(injected.status, 421)
    assert.deepEqual(JSON.parse(injected.body), { error: 'misdirected request' })
    assert.equal(listener.storage.appended.length, 0, 'no row was injected')

    const optOut = await postWithHost(listener.endpoint, {
      path: '/_hypaware/ignore/session',
      host: 'attacker.example',
      body: { session_id: 'ses_rebound' },
    })
    assert.equal(optOut.status, 421)

    // Both refusals are counted, but a page can send these as fast as it
    // likes, so only the first is written: a line apiece would answer blocked
    // row injection with unbounded row growth in `logs`.
    const refused = listener.logs.filter((entry) => entry.event === 'listener.host_refused')
    assert.equal(refused.length, 1)
    assert.equal(refused[0]?.fields?.error_kind, 'host_not_loopback')
    assert.equal(refused[0]?.fields?.host, 'attacker.example')
    // The running tally rides along, so the next line past the interval says
    // how much the interval swallowed.
    assert.equal(refused[0]?.fields?.refused_total, 1)

    const status = await listener.source.status?.()
    assert.equal(status?.details?.snapshots_received, 0)
    assert.equal(status?.details?.ignored_sessions, 0, 'the control route mutated nothing')

    // Every loopback spelling, with any port, still records.
    const hosts = ['127.0.0.1', `127.0.0.1:${new URL(listener.endpoint).port}`, 'localhost:9999', '[::1]']
    for (const host of hosts) {
      const allowed = await postWithHost(listener.endpoint, {
        path: '/snapshot',
        host,
        body: snapshot(`ses_${host.replace(/\W/g, '')}`, cwd),
      })
      assert.equal(allowed.status, 200, `Host: ${host} still records`)
    }
    assert.equal(listener.storage.appended.length, hosts.length * 3)
  } finally {
    await listener.cleanup()
  }
})

// The handler here is synchronous, so a throw out of it is an
// `uncaughtException`, and this repo installs no handler for one.
test('a request target new URL rejects is answered 400 rather than ending the daemon', async () => {
  const listener = await startListener()
  const port = Number(new URL(listener.endpoint).port)
  try {
    const line = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1')
      let received = ''
      socket.on('connect', () => socket.write('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'))
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8')
        if (received.includes('\r\n')) {
          socket.destroy()
          resolve(received.split('\r\n')[0])
        }
      })
      socket.on('error', reject)
      socket.on('close', () =>
        reject(new Error(`socket closed with no status line, got ${JSON.stringify(received)}`))
      )
    })
    assert.equal(line, 'HTTP/1.1 400 Bad Request')
    // Still serving.
    const banner = await fetch(`${listener.endpoint}/`)
    assert.equal(banner.status, 200)
  } finally {
    await listener.cleanup()
  }
})

test('OpenCode listener reports malformed snapshot errors without exposing request content', async () => {
  const listener = await startListener()
  try {
    const response = await fetch(`${listener.endpoint}/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'snapshot receive failed' })
    const status = await listener.source.status?.()
    assert.match(String(status?.lastError), /JSON/)
    const failure = listener.logs.find((entry) => entry.event === 'opencode.snapshot.failed')
    assert.equal(failure?.fields?.error_kind, 'snapshot_receive_failed')
    assert.equal(JSON.stringify(failure).includes('{not-json'), false)
  } finally {
    await listener.cleanup()
  }
})

test('a turn observed mid-stream lands once, complete, when the assistant message settles', async () => {
  const listener = await startListener()
  const cwd = path.join(listener.root, 'streaming')
  await fs.mkdir(cwd, { recursive: true })
  const id = 'ses_stream'
  /** @param {boolean} settled */
  const turn = (settled) => ({
    session: { id, directory: cwd, version: '1.18.22', time: { created: 1 } },
    messages: [
      {
        info: { id: `${id}-user`, role: 'user', time: { created: 2 } },
        parts: [{ id: `${id}-user-part`, type: 'text', text: 'Read notes.txt' }],
      },
      {
        info: {
          id: `${id}-assistant`,
          role: 'assistant',
          parentID: `${id}-user`,
          providerID: 'openai',
          modelID: 'gpt-5.6-luna',
          time: settled ? { created: 3, completed: 9 } : { created: 3 },
          ...(settled ? { finish: 'stop' } : {}),
        },
        parts: [
          {
            id: `${id}-text`,
            type: 'text',
            text: settled ? 'I read it: the notes say hello.' : 'I read',
          },
          {
            id: `${id}-tool`,
            type: 'tool',
            callID: `${id}-call`,
            tool: 'read',
            state: settled
              ? { status: 'completed', input: { path: 'notes.txt' }, output: 'hello' }
              : { status: 'running', input: { path: 'notes.txt' } },
          },
        ],
      },
    ],
    entrypoint: 'cli',
    entrypoint_source: 'plugin-process',
  })

  try {
    // Mid-stream: only the user message is settled, so only it is persisted.
    // Writing the assistant message here would freeze its streaming prefix -
    // the shared writer dedupes at message grain, so nothing could replace it.
    const midTurn = await listener.post(turn(false))
    assert.equal(midTurn.status, 200)
    assert.deepEqual(await midTurn.json(), { status: 'ok', rowsWritten: 1, rowsSkipped: 0 })

    const settled = await listener.post(turn(true))
    assert.equal(settled.status, 200)
    assert.deepEqual(await settled.json(), { status: 'ok', rowsWritten: 2, rowsSkipped: 0 })

    const replay = await listener.post(turn(true))
    assert.deepEqual(await replay.json(), { status: 'ok', rowsWritten: 0, rowsSkipped: 0 })

    const rows = listener.storage.appended
    assert.equal(rows.length, 3)
    const text = rows.find((row) => row.part_id === `${id}-text`)
    assert.equal(text?.content_text, 'I read it: the notes say hello.')
    const tool = rows.find((row) => row.part_id === `${id}-tool`)
    assert.equal(tool?.tool_name, 'read')
    assert.equal(tool?.tool_call_id, `${id}-call`)
  } finally {
    await listener.cleanup()
  }
})

// `server.close()` alone waits for every outstanding socket, so a client that
// is connected but between requests keeps the listener open. The OpenCode
// plugin posts with fetch, whose agent holds the connection across turns, so a
// running OpenCode would block `hyp daemon stop` on this. Every peer listener
// (otel, claude telemetry) closes idle and then all connections for the same
// reason.
test('OpenCode listener stop() does not wait on a connected client socket', async () => {
  const listener = await startListener()
  const cwd = path.join(listener.root, 'work')
  await fs.mkdir(cwd, { recursive: true })
  /** @type {import('node:net').Socket | undefined} */
  let held
  try {
    const posted = await listener.post(snapshot('ses_keepalive', cwd))
    assert.equal(posted.status, 200)
    await posted.json()

    const port = Number(new URL(listener.endpoint).port)
    held = net.connect(port, '127.0.0.1')
    await new Promise((resolve, reject) => {
      held?.once('connect', resolve)
      held?.once('error', reject)
    })

    const started = Date.now()
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 2000) })
    const result = await Promise.race([listener.source.stop().then(() => 'stopped'), timedOut])
    clearTimeout(timer)
    assert.equal(result, 'stopped', `stop() did not return within 2s (waited ${Date.now() - started}ms)`)

    await assert.rejects(listener.post(snapshot('ses_after_stop', cwd)))
  } finally {
    held?.destroy()
    await fs.rm(listener.root, { recursive: true, force: true })
  }
})
