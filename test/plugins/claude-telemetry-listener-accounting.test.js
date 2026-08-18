// @ts-check

/**
 * What the Claude telemetry listener counts, publishes, and keeps across a
 * failed batch, driven through its real transport: a listener on an ephemeral
 * port, a fake gateway and storage behind it, and OTLP/JSON over the wire.
 *
 * Every case here is a deferred review finding from PR #818 (issue #843): the
 * usage index consumed by a batch that never landed, the spool byte gauge left
 * high by a policy drop, a refused `body_ref` logged verbatim, and a delete
 * counter that counted files that were not there.
 *
 * @ref LLP 0257#observability [tests]: the signals and counters the listener
 *   publishes are the ones an operator reads, so they have to be true
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'
import { createStartClaudeTelemetrySource } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'
import { claudeBodySpoolDir } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/spool.js'

const SESSION = 'b0ad4f6a-49a3-4d64-9b48-2b0b6c0f3f11'
const ASSISTANT_UUID = '0f7f4de6-6d3c-4a3f-9d1e-3a3ec2a0f5c2'
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
 * `seed` files are written BEFORE the start-time sweep, which is what
 * primes the published `spool_bytes`: a file dropped in afterwards is
 * invisible to the gauge until the next sweep restates it.
 *
 * @param {{
 *   recordProjectedExchange?: (projection: any, opts: any) => Promise<any>,
 *   seed?: Array<{ name: string, content: string }>,
 * }} [opts]
 */
async function startListener(opts = {}) {
  const hypHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-accounting-'))
  const spoolDir = claudeBodySpoolDir(hypHome)
  await fsp.mkdir(spoolDir, { recursive: true })
  for (const file of opts.seed ?? []) {
    await fsp.writeFile(path.join(spoolDir, file.name), file.content, 'utf8')
  }
  const stateFile = path.join(hypHome, 'claude-sessions.json')
  /** @type {Array<{ level: string, event: string, fields: Record<string, unknown> }>} */
  const logs = []
  /** @param {string} level */
  const sink = (level) => (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields) => {
    logs.push({ level, event, fields: fields ?? {} })
  }
  const start = createStartClaudeTelemetrySource({
    gateway: /** @type {any} */ ({
      recordProjectedExchange: opts.recordProjectedExchange
        ?? (async () => ({ rowsWritten: 0, rowsSkipped: 0 })),
    }),
    clientName: 'claude',
    stateFile,
  })
  const ctx = /** @type {any} */ ({
    config: { telemetry: { listen_host: '127.0.0.1', listen_port: 0 } },
    env: { HYP_HOME: hypHome },
    log: { info: sink('info'), warn: sink('warn'), error: sink('error'), debug: sink('debug') },
    storage: {
      cacheTablePath: () => path.join(hypHome, 'cache', 'claude_telemetry_events'),
      appendRows: async () => {},
    },
  })
  // `status` and `stop` are optional on the kernel's StartedSource; this one
  // publishes both, and every case here reads them.
  const source = /** @type {any} */ (await start(ctx))
  const details = /** @type {any} */ ((await source.status()).details)
  const port = /** @type {number} */ (details.listen_port)

  return {
    hypHome,
    spoolDir,
    stateFile,
    logs,
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

// The exporter flushes on a timer, so a turn's `api_request` (which carries
// the tokens and the cost) and its `assistant_response` (which carries the
// uuid the row is keyed by) routinely arrive in DIFFERENT POSTs - which is why
// the usage index outlives one batch at all. Projection claims the entry on the
// way in; before this fix a message write that then failed left it claimed, and
// the retry of that batch re-projected against a drained index. The rows landed
// with no `attributes.usage` and no `claude.cost_usd`, permanently, in exactly
// the batch that had already failed once.
// @ref LLP 0257#failure-modes [tests]: S18 - a retried batch is re-projected
//   from the same inputs, so its inputs have to survive the failure
test('usage from an earlier batch survives a failed write and lands on the retry', async () => {
  /** @type {any[]} */
  const seen = []
  let attempt = 0
  const listener = await startListener({
    recordProjectedExchange: async (projection) => {
      attempt += 1
      if (attempt === 1) throw new Error('dataset unavailable')
      seen.push(projection)
      return { rowsWritten: 1, rowsSkipped: 0 }
    },
  })
  try {
    // A recorded cwd, so the usage-policy gate resolves rather than withholds.
    await appendSessionContext(listener.stateFile, {
      session_id: SESSION,
      transcript_path: undefined,
      git_branch: undefined,
      cwd: listener.hypHome,
      ts: '2026-08-17T19:30:00.000Z',
    })
    // Flush one: the usage record only. It projects no message, so nothing is
    // written and the tokens wait in the index for the response.
    const usageFlush = await listener.post(envelope([
      record('api_request', {
        model: 'claude-haiku-4-5-20251001',
        input_tokens: 73,
        output_tokens: 113,
        cost_usd: 0.0047732,
        duration_ms: 1842,
        request_id: REQUEST_ID,
      }, '2026-08-17T19:30:31.009Z'),
    ]))
    assert.equal(usageFlush.status, 200)
    assert.equal(attempt, 0, 'a usage-only batch projects no exchange to write')

    // Flush two: the response that claims it, whose write fails.
    const batch = envelope([
      record('assistant_response', {
        response: 'This is a spike repo.',
        request_id: REQUEST_ID,
        'message.uuid': ASSISTANT_UUID,
        model: 'claude-haiku-4-5-20251001',
      }, '2026-08-17T19:30:31.009Z'),
    ])

    const failed = await listener.post(batch)
    assert.equal(failed.status, 500, 'a write failure has to reach the exporter as a retryable error')

    const retried = await listener.post(batch)
    assert.equal(retried.status, 200)

    assert.equal(seen.length, 1, 'the retry is the only attempt that wrote')
    const assistant = seen[0].messages.find((/** @type {any} */ m) => m.role === 'assistant')
    assert.ok(assistant, 'the retried batch still projects the assistant row')
    assert.deepEqual(
      assistant.attributes?.usage,
      { input_tokens: 73, output_tokens: 113 },
      'the retried row carries the tokens its api_request reported'
    )
    assert.equal(assistant.attributes?.claude?.cost_usd, 0.0047732)
  } finally {
    await listener.cleanup()
  }
})

// The drop arm deletes bodies the read path never accounted for, so before
// this fix `spool_bytes` stayed at its pre-drop value until the next sweep
// (up to a minute), and `hyp status` reported bytes for content that had
// already been removed on the user's say-so.
// @ref LLP 0253#byte-cap [tests] / LLP 0253#delete-on-drop [tests]
test('a policy drop brings the published spool_bytes down with the files it deleted', async () => {
  const content = JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [] })
  const listener = await startListener({ seed: [{ name: 'withheld.request.json', content }] })
  try {
    const body = path.join(listener.spoolDir, 'withheld.request.json')
    // The start-time sweep is what primes the gauge, so the file has to be on
    // disk before it runs.
    assert.equal(
      (await listener.details()).spool_bytes,
      content.length,
      'the start sweep publishes what is already spooled'
    )

    // No session-context record for this session, so the usage policy withholds
    // it and its bodies are deleted unread.
    const res = await listener.post(envelope([
      record('api_request_body', { body_ref: body, request_id: REQUEST_ID }, '2026-08-17T19:31:00.000Z'),
    ]))
    assert.equal(res.status, 200)

    await assert.rejects(fsp.stat(body), 'a withheld session\'s body is deleted, not skipped')
    const details = await listener.details()
    assert.equal(details.bodies_dropped, 1)
    assert.equal(details.spool_bytes, 0, 'the gauge has to come down by what the drop removed')
  } finally {
    await listener.cleanup()
  }
})

// A refused ref is out-of-spool by definition and arrived over the wire, so
// the warn line that reports it must not carry the raw path into a sink the
// operator may ship off the machine.
// @ref LLP 0257#observability [tests]: S23 - payload identity by hash
test('a refused body_ref is reported by digest, never verbatim', async () => {
  const listener = await startListener()
  try {
    const outside = path.join(listener.hypHome, 'not-ours', 'etc-passwd-lookalike.json')
    const res = await listener.post(envelope([
      record('api_request_body', { body_ref: outside, request_id: REQUEST_ID }, '2026-08-17T19:31:00.000Z'),
    ]))
    assert.equal(res.status, 200)

    const refusals = listener.logs.filter((l) => l.event === 'claude.telemetry.body_ref_refused')
    assert.equal(refusals.length, 1, 'the refusal is still reported')
    const fields = refusals[0].fields
    assert.equal(fields.error_kind, 'body_ref_outside_spool')
    assert.match(String(fields.body_ref_sha256), /^[0-9a-f]{12}$/)
    assert.ok(
      !JSON.stringify(fields).includes('etc-passwd-lookalike'),
      'no part of the wire-supplied path may appear in the log line'
    )
  } finally {
    await listener.cleanup()
  }
})

// `fs.rm(..., { force: true })` succeeds on a path that is not there, so
// counting its return reported every already-evicted ref as one more deletion.
// @ref LLP 0253#eviction-degrades [tests]: an evicted body is not an error, and
//   it is also not a deletion
test('a body_ref whose file is already gone is not counted as a deletion', async () => {
  const listener = await startListener()
  try {
    const res = await listener.post(envelope([
      record(
        'api_request_body',
        { body_ref: path.join(listener.spoolDir, 'evicted.request.json'), request_id: REQUEST_ID },
        '2026-08-17T19:31:00.000Z'
      ),
    ]))
    assert.equal(res.status, 200)

    const details = await listener.details()
    assert.equal(details.bodies_dropped, 0, 'nothing was on disk, so nothing was deleted')
  } finally {
    await listener.cleanup()
  }
})

// `last_event_at` is the baseline `hyp status` measures a capture gap from, and
// it was maxed with `>` over strings. Claude Code stamps `event.timestamp` from
// more than one producer, so a batch mixes `...:24Z` with `...:24.000Z`, and a
// legal OTLP timestamp may carry a numeric offset instead of `Z` - both of
// which sort by text in the opposite order to the instants they name. A max
// that runs backwards invents a capture gap that is not there.
// @ref LLP 0257#status-and-health [tests]: the published last event is the
//   newest instant seen, not the largest string
test('last_event_at names the newest instant, not the largest string', async () => {
  const listener = await startListener()
  try {
    // Sub-second precision sorts BEFORE a whole-second stamp by text ('.' is
    // below 'Z'), so the older event won the string compare.
    const first = await listener.post(envelope([
      record('api_request', { request_id: REQUEST_ID }, '2026-08-17T19:30:24.500Z'),
      record('api_request', { request_id: REQUEST_ID }, '2026-08-17T19:30:24Z'),
    ]))
    assert.equal(first.status, 200)
    assert.equal((await listener.details()).last_event_at, '2026-08-17T19:30:24.500Z')

    // An offset form: 21:00+03:00 is 18:00Z, an hour and a half BEFORE the
    // event above, but its text sorts after it.
    const second = await listener.post(envelope([
      record('api_request', { request_id: REQUEST_ID }, '2026-08-17T21:00:00+03:00'),
    ]))
    assert.equal(second.status, 200)
    assert.equal(
      (await listener.details()).last_event_at,
      '2026-08-17T19:30:24.500Z',
      'an older event must not move the capture-gap baseline forwards'
    )
  } finally {
    await listener.cleanup()
  }
})
