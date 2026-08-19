// @ts-check

/**
 * The unparseable-body arm of the Claude telemetry listener, driven through
 * its real transport: a listener on an ephemeral port, a fake gateway behind
 * it, and OTLP/JSON over the wire.
 *
 * A body file that does not parse is deleted immediately (an undeleted body is
 * a raw prompt sitting on disk), and the published `spool_bytes` gauge has to
 * come down with it, exactly as it does for a body that projected.
 *
 * @ref LLP 0257#status-and-health [tests]: S16 - `spool_bytes` is the spool's
 *   current size, so the reader's own deletion has to move it
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

const SESSION = 'd41f0b2e-7c8a-4f19-9f61-6a1c2f7d0e33'
const REQUEST_ID = 'req_011Ce8sjpb8Uzvot2JMvFkKe'

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
 * the gauge until the next sweep restates it.
 *
 * @param {{ seed?: Array<{ name: string, content: string }> }} [opts]
 */
async function startListener(opts = {}) {
  const hypHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-unparseable-'))
  const spoolDir = claudeBodySpoolDir(hypHome)
  await fsp.mkdir(spoolDir, { recursive: true })
  for (const file of opts.seed ?? []) {
    await fsp.writeFile(path.join(spoolDir, file.name), file.content, 'utf8')
  }
  const stateFile = path.join(hypHome, 'claude-sessions.json')
  const noop = () => {}
  const start = createStartClaudeTelemetrySource({
    gateway: /** @type {any} */ ({
      recordProjectedExchange: async () => ({ rowsWritten: 0, rowsSkipped: 0 }),
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

// The reader deletes an unparseable body and counts it, but before this fix it
// never told the caller how many bytes went with it, so `spool_bytes` stayed
// at its pre-batch value until the next sweep restated it (up to a minute) and
// `hyp status` reported bytes for a file that was already off the disk.
test('an unparseable body brings the published spool_bytes down with it', async () => {
  const content = 'not json at all'
  const listener = await startListener({ seed: [{ name: 'broken.request.json', content }] })
  try {
    // A recorded cwd, so the usage-policy gate resolves rather than withholds:
    // this has to reach the READ path, not the drop path.
    await appendSessionContext(listener.stateFile, {
      session_id: SESSION,
      transcript_path: undefined,
      git_branch: undefined,
      cwd: listener.hypHome,
      ts: '2026-08-17T19:30:00.000Z',
    })
    const body = path.join(listener.spoolDir, 'broken.request.json')
    // The start-time sweep is what primes the gauge, so the file has to be on
    // disk before it runs.
    assert.equal(
      (await listener.details()).spool_bytes,
      content.length,
      'the start sweep publishes what is already spooled'
    )

    const res = await listener.post(envelope([
      record('api_request_body', { body_ref: body, request_id: REQUEST_ID }, '2026-08-17T19:31:00.000Z'),
    ]))
    assert.equal(res.status, 200)

    await assert.rejects(fsp.stat(body), 'an unparseable body is deleted, not left on disk')
    const details = await listener.details()
    assert.equal(details.spool_bytes, 0, 'the gauge has to come down by what the read arm removed')
  } finally {
    await listener.cleanup()
  }
})

// The reader half on its own: the byte total is what lets the call site
// subtract, so it has to be reported even when nothing projects.
test('loadSpooledBodies reports the bytes an unparseable body took with it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-unparseable-unit-'))
  try {
    const content = 'not json at all'
    const file = path.join(dir, 'broken.request.json')
    await fsp.writeFile(file, content, 'utf8')
    const events = [{
      name: 'api_request_body',
      timestamp: '2026-08-17T19:31:00.000Z',
      attributes: { body_ref: file, request_id: REQUEST_ID },
    }]
    const loaded = await loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir })
    assert.equal(loaded.unparseable, 1)
    assert.equal(loaded.consumedBytes, 0, 'nothing projected, so nothing was consumed')
    assert.equal(loaded.unparseableBytes, content.length)
    await assert.rejects(fsp.stat(file))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// Two reads of the same `body_ref` overlapping in the handler: both are issued
// before either resolves, so both find the file and both call it unparseable,
// but only one of them can be the call that removed it. `fs.rm(..., { force:
// true })` resolves for a path that is already gone, so it reported the bytes
// twice and brought `spool_bytes` down by 2x one deletion.
test('two overlapping reads of one unparseable body report its bytes once', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-unparseable-race-'))
  try {
    const content = 'not json at all'
    const file = path.join(dir, 'broken.request.json')
    await fsp.writeFile(file, content, 'utf8')
    const events = [{
      name: 'api_request_body',
      timestamp: '2026-08-17T19:31:00.000Z',
      attributes: { body_ref: file, request_id: REQUEST_ID },
    }]
    const both = await Promise.all([
      loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir }),
      loadSpooledBodies(/** @type {any} */ (events), { spoolDir: dir }),
    ])
    assert.equal(both[0].unparseable + both[1].unparseable, 2, 'both reads saw it')
    assert.equal(
      both[0].unparseableBytes + both[1].unparseableBytes,
      content.length,
      'one file left the disk, so its bytes are reported once'
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
