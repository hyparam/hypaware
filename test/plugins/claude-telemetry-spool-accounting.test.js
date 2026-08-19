// @ts-check

/**
 * What the Claude telemetry listener publishes as `spool_bytes` after a batch
 * removed body files, driven through its real transport: a listener on an
 * ephemeral port, a fake gateway behind it, and OTLP/JSON over the wire.
 *
 * The case here is a deferred review finding from PR #851 (issue #905): the
 * unparseable-body arm deletes the file inside the read, so its bytes are gone
 * from the disk but were never taken off the gauge, and `hyp status` reported
 * them until the next sweep restated it a minute later.
 *
 * @ref LLP 0257#status-and-health [tests]: S16 - the details carry the spool's
 *   CURRENT byte size, so every arm that removes a file has to correct it
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'
import { createStartClaudeTelemetrySource } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'
import { claudeBodySpoolDir } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/spool.js'
import { loadSpooledBodies } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/bodies.js'

const SESSION = '2b1f9c4e-7f3a-4a51-9a2c-0d6f8e5b1c33'
const ASSISTANT_UUID = '9d2c7a10-5c4e-4a6b-8f0a-1e2d3c4b5a69'

/** @param {Record<string, unknown>} attrs */
function kvAttributes(attrs) {
  return Object.entries(attrs).map(([key, value]) => {
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { key, value: { intValue: value } }
        : { key, value: { doubleValue: value } }
    }
    return { key, value: { stringValue: String(value) } }
  })
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 * @param {string} timestamp
 */
function record(name, attrs, timestamp) {
  return {
    timeUnixNano: String(BigInt(Date.parse(timestamp)) * 1_000_000n),
    body: { stringValue: `claude_code.${name}` },
    attributes: kvAttributes({
      'session.id': SESSION,
      'event.name': name,
      'event.timestamp': timestamp,
      ...attrs,
    }),
  }
}

/** @param {Array<ReturnType<typeof record>>} records */
function envelope(records) {
  return {
    resourceLogs: [
      {
        resource: { attributes: kvAttributes({ 'service.name': 'claude-code' }) },
        scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: records }],
      },
    ],
  }
}

/**
 * Start a real listener on an ephemeral port with a fake gateway behind it.
 *
 * `seed` files are written BEFORE the start-time sweep, which is what primes
 * the published `spool_bytes`: a file dropped in afterwards is invisible to
 * the gauge until the next sweep restates it, and the next sweep is exactly
 * what this test must not be allowed to do the correcting.
 *
 * @param {{ seed?: Array<{ name: string, content: string }> }} [opts]
 */
async function startListener(opts = {}) {
  const hypHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-spool-bytes-'))
  const spoolDir = claudeBodySpoolDir(hypHome)
  await fsp.mkdir(spoolDir, { recursive: true })
  for (const file of opts.seed ?? []) {
    await fsp.writeFile(path.join(spoolDir, file.name), file.content, 'utf8')
  }
  const stateFile = path.join(hypHome, 'claude-sessions.json')
  const noop = () => {}
  const start = createStartClaudeTelemetrySource({
    gateway: /** @type {any} */ ({
      recordProjectedExchange: async () => ({ rowsWritten: 1, rowsSkipped: 0 }),
    }),
    clientName: 'claude',
    stateFile,
  })
  const ctx = /** @type {any} */ ({
    config: { telemetry: { listen_host: '127.0.0.1', listen_port: 0 } },
    env: { HYP_HOME: hypHome },
    log: { info: noop, warn: noop, error: noop, debug: noop },
    storage: {
      cacheTablePath: () => path.join(hypHome, 'cache', 'claude_telemetry_events'),
      appendRows: async () => {},
    },
  })
  // `status` and `stop` are optional on the kernel's StartedSource; this one
  // publishes both, and this test reads them.
  const source = /** @type {any} */ (await start(ctx))
  const first = /** @type {any} */ ((await source.status()).details)
  const port = /** @type {number} */ (first.listen_port)

  return {
    hypHome,
    spoolDir,
    stateFile,
    /** @param {ReturnType<typeof envelope>} body */
    async post(body) {
      return fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
    async details() {
      return /** @type {Record<string, unknown>} */ ((await source.status()).details ?? {})
    },
    async cleanup() {
      await source.stop()
      await fsp.rm(hypHome, { recursive: true, force: true })
    },
  }
}

/** @param {string} dir */
async function bytesOnDisk(dir) {
  const names = await fsp.readdir(dir)
  let total = 0
  for (const name of names) {
    const stat = await fsp.stat(path.join(dir, name))
    if (stat.isFile()) total += stat.size
  }
  return total
}

// A truncated body file is the ordinary case here: Claude Code writes the
// spool file itself, so a killed process leaves half a JSON object behind.
const BROKEN = '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"ass'
const VALID = JSON.stringify({
  model: 'claude-haiku-4-5-20251001',
  content: [{ type: 'thinking', thinking: 'checking the tree', signature: 'sig' }],
})

test('an unparseable body takes its bytes off spool_bytes when it is deleted', async () => {
  const listener = await startListener({
    seed: [
      { name: 'req-broken.json', content: BROKEN },
      { name: 'res-valid.json', content: VALID },
    ],
  })
  try {
    // A recorded cwd, so the usage-policy gate resolves rather than withholds:
    // a withheld batch never reaches the read that deletes the broken file.
    await appendSessionContext(listener.stateFile, {
      session_id: SESSION,
      transcript_path: undefined,
      git_branch: undefined,
      cwd: listener.hypHome,
      ts: '2026-08-17T19:30:00.000Z',
    })

    const seeded = await listener.details()
    assert.equal(
      seeded.spool_bytes,
      BROKEN.length + VALID.length,
      'the start-time sweep publishes what the seeded files occupy',
    )

    const posted = await listener.post(envelope([
      record('api_request_body', {
        body_ref: path.join(listener.spoolDir, 'req-broken.json'),
      }, '2026-08-17T19:30:30.000Z'),
      record('api_response_body', {
        body_ref: path.join(listener.spoolDir, 'res-valid.json'),
      }, '2026-08-17T19:30:31.000Z'),
      record('assistant_response', {
        response: 'This is a spike repo.',
        'message.uuid': ASSISTANT_UUID,
        model: 'claude-haiku-4-5-20251001',
      }, '2026-08-17T19:30:31.009Z'),
    ]))
    assert.equal(posted.status, 200)

    // Both files are gone: the valid one after its write landed, the broken
    // one inside the read that failed to parse it.
    assert.deepEqual(await fsp.readdir(listener.spoolDir), [])

    const after = await listener.details()
    assert.equal(
      after.spool_bytes,
      await bytesOnDisk(listener.spoolDir),
      'spool_bytes has to match the disk without waiting for the next sweep',
    )
    assert.equal(after.spool_bytes, 0)
    assert.equal(after.bodies_projected, 1)
  } finally {
    await listener.cleanup()
  }
})

// The gauge is only correctable if the read reports what it removed, so the
// reporting itself is pinned here rather than only through the listener.
test('loadSpooledBodies reports the bytes its unparseable arm removed', async () => {
  const spoolDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-spool-load-'))
  try {
    const broken = path.join(spoolDir, 'broken.json')
    const valid = path.join(spoolDir, 'valid.json')
    await fsp.writeFile(broken, BROKEN, 'utf8')
    await fsp.writeFile(valid, VALID, 'utf8')

    const loaded = await loadSpooledBodies(/** @type {any} */ ([
      { name: 'api_request_body', attributes: { body_ref: broken }, timestamp: undefined },
      { name: 'api_response_body', attributes: { body_ref: valid }, timestamp: undefined },
    ]), { spoolDir })

    assert.equal(loaded.unparseable, 1)
    assert.equal(loaded.unparseableBytes, BROKEN.length)
    // The parseable one is still on disk: it is deleted only after the
    // batch's writes land, and its bytes are `consumedBytes`, not these.
    assert.equal(loaded.consumedBytes, VALID.length)
    assert.deepEqual(await fsp.readdir(spoolDir), ['valid.json'])
  } finally {
    await fsp.rm(spoolDir, { recursive: true, force: true })
  }
})
