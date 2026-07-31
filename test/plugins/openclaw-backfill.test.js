// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createOpenclawBackfillProvider } from '../../hypaware-core/plugins-workspace/openclaw/src/backfill.js'
import { sessionMatchKey, wireMatchKey } from '../../hypaware-core/plugins-workspace/openclaw/src/match_key.js'
import { createOpenclawExchangeProjector } from '../../hypaware-core/plugins-workspace/openclaw/src/projector.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/index.js'

/**
 * End-to-end tests for the `@hypaware/openclaw` backfill provider. They run the
 * real provider against on-disk OpenClaw session JSONL and feed the yielded
 * items through the real `@hypaware/ai-gateway`
 * `ai_gateway.projected_exchange` materializer, so the assertions cover the
 * exact path `hyp backfill openclaw` exercises in production.
 *
 * @import { BackfillEvent, BackfillItem, BackfillRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-backfill-'))
  return {
    homeDir,
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

/**
 * Write one `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`.
 *
 * @param {{ homeDir: string }} env
 * @param {{
 *   agentId?: string,
 *   sessionId?: string,
 *   header?: Record<string, unknown> | null,
 *   records?: Array<Record<string, unknown>>,
 * }} doc
 * @returns {Promise<string>}
 */
async function writeSession(env, doc) {
  const agentId = doc.agentId ?? 'main'
  const sessionId = doc.sessionId ?? 'sess-1'
  const dir = path.join(env.homeDir, '.openclaw', 'agents', agentId, 'sessions')
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  /** @type {string[]} */
  const lines = []
  if (doc.header !== null) {
    lines.push(JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-07-30T10:00:00.000Z',
      ...doc.header,
    }))
  }
  for (const record of doc.records ?? []) lines.push(JSON.stringify({ type: 'message', ...record }))
  await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8')
  return filePath
}

function captureLog() {
  /** @type {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} */
  const entries = []
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ message, /** @type {Record<string, unknown>=} */ fields) => {
    entries.push({ level, message, fields })
  }
  return {
    entries,
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  }
}

/**
 * @param {{ since?: string, until?: string, retentionDays?: number }} [overrides]
 * @returns {{ ctx: BackfillRunContext, entries: any[] }}
 */
function runContext(overrides = {}) {
  const { entries, log } = captureLog()
  /** @type {BackfillRunContext} */
  const ctx = {
    env: {},
    cacheRoot: path.join(os.tmpdir(), 'openclaw-backfill-cache-unused'),
    dryRun: false,
    log,
    storage: /** @type {any} */ ({}),
    ...(overrides.since !== undefined ? { since: overrides.since } : {}),
    ...(overrides.until !== undefined ? { until: overrides.until } : {}),
    ...(overrides.retentionDays !== undefined ? { retentionDays: overrides.retentionDays } : {}),
  }
  return { ctx, entries }
}

/**
 * @param {AsyncIterable<BackfillItem | BackfillEvent>} iterable
 * @returns {Promise<{ items: BackfillItem[], events: BackfillEvent[] }>}
 */
async function collect(iterable) {
  /** @type {BackfillItem[]} */
  const items = []
  /** @type {BackfillEvent[]} */
  const events = []
  for await (const yielded of iterable) {
    if (yielded.type === 'event') events.push(/** @type {BackfillEvent} */ (yielded))
    else items.push(/** @type {BackfillItem} */ (yielded))
  }
  return { items, events }
}

/** @param {BackfillItem} item */
function value(item) {
  return /** @type {any} */ (item.value)
}

/**
 * A materialized row's `attributes`, as an object. The gateway's row builder
 * leaves it structured; only the storage layer stringifies.
 *
 * @param {Record<string, unknown>} row
 * @returns {any}
 */
function attributesOf(row) {
  return typeof row.attributes === 'string' ? JSON.parse(row.attributes) : (row.attributes ?? {})
}

/**
 * @param {BackfillItem} item
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function materialize(item) {
  const materializer = aiGatewayBackfillMaterializer()
  const ctx = /** @type {any} */ ({ log: captureLog().log, env: {}, storage: {} })
  return materializer.materialize(item, ctx)
}

/**
 * A real usage-policy resolver wired to an injected fs that reports exactly one
 * governing `.hypignore` (class `ignore`) at `ignoredDir`. Mirrors the Codex and
 * Claude backfill drop tests: exercise the shared matcher, not a stub.
 *
 * @param {string} ignoredDir
 */
function ignoringResolver(ignoredDir) {
  const hypignore = path.join(ignoredDir, '.hypignore')
  return createUsagePolicyResolver({
    existsSync: (p) => p === hypignore,
    readFileSync: () => 'ignore\n',
  })
}

// The turn every test below shares: one user prompt, one assistant reply, both
// with the native ids OpenClaw wrote into the session file.
const USER_RECORD = {
  id: 'msg-user-1',
  timestamp: '2026-07-30T10:00:01.000Z',
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
}

const ASSISTANT_RECORD = {
  id: 'msg-asst-1',
  timestamp: '2026-07-30T10:00:02.000Z',
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  model: 'claude-sonnet-4-5',
  provider: 'anthropic',
  api: 'anthropic-messages',
  stopReason: 'end_turn',
  usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 },
}

/**
 * @param {{ homeDir: string }} env
 * @param {{ resolver?: any }} [opts]
 */
function provider(env, opts = {}) {
  return createOpenclawBackfillProvider({ homeDir: env.homeDir, ...opts })
}

// ---------------------------------------------------------------------------
// Shape and native identity
// ---------------------------------------------------------------------------

test('projects one item per session file, with the header cwd and native session id', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, {
      header: { cwd: '/work/repo' },
      records: [USER_RECORD, ASSISTANT_RECORD],
    })
    const { items, events } = await collect(provider(env).run(runContext().ctx))
    assert.equal(items.length, 1)
    assert.equal(events.length, 0)
    const exchange = value(items[0])
    assert.equal(exchange.session_id, 'sess-1')
    assert.equal(exchange.client_name, 'openclaw')
    assert.equal(exchange.conversation_source, 'openclaw')
    assert.equal(exchange.provider, 'anthropic')
    assert.equal(exchange.cwd, '/work/repo')
    assert.equal(exchange.conversation_started_at, '2026-07-30T10:00:00.000Z')
    assert.equal(exchange.messages.length, 2)
    assert.equal(items[0].provenance?.native_id, 'sess-1')
    assert.equal(items[0].provenance?.client_name, 'openclaw')
  } finally {
    await env.cleanup()
  }
})

test('backfilled rows carry the session file\'s own message ids, never a fallback hash', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, { header: { cwd: '/work/repo' }, records: [USER_RECORD, ASSISTANT_RECORD] })
    const { items } = await collect(provider(env).run(runContext().ctx))
    const rows = await materialize(items[0])
    assert.deepEqual(rows.map((r) => r.message_id), ['msg-user-1', 'msg-asst-1'])
    assert.deepEqual(rows.map((r) => r.part_id), ['msg-user-1#0', 'msg-asst-1#0'])
    // Fallback identity would have stamped this; native identity must not.
    for (const row of rows) {
      assert.equal(attributesOf(row).gateway?.identity_source, undefined)
    }
  } finally {
    await env.cleanup()
  }
})

test('the gateway chains previous_message_id across the session, rooting the first message', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, { header: { cwd: '/work/repo' }, records: [USER_RECORD, ASSISTANT_RECORD] })
    const { items } = await collect(provider(env).run(runContext().ctx))
    const rows = await materialize(items[0])
    assert.deepEqual(rows[0].previous_message_id, [])
    assert.deepEqual(rows[1].previous_message_id, ['msg-user-1'])
  } finally {
    await env.cleanup()
  }
})

test('assistant usage lands under the gateway-wide token names, whatever spelling the file used', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, { header: { cwd: '/work/repo' }, records: [USER_RECORD, ASSISTANT_RECORD] })
    const { items } = await collect(provider(env).run(runContext().ctx))
    const rows = await materialize(items[0])
    assert.deepEqual(attributesOf(rows[1]).usage, {
      input_tokens: 11,
      output_tokens: 7,
      cache_read_tokens: 3,
      cache_write_tokens: 2,
    })
    // Usage rides the assistant record only (LLP 0035 one-carrier).
    assert.equal(attributesOf(rows[0]).usage, undefined)
    // The per-message model mirrors the transcript: assistant-only.
    assert.equal(rows[1].model, 'claude-sonnet-4-5')
    assert.equal(rows[0].model, undefined)
  } finally {
    await env.cleanup()
  }
})

test('a toolResult record lands under the role the sibling adapters already write', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, {
      header: { cwd: '/work/repo' },
      records: [
        USER_RECORD,
        {
          id: 'msg-tool-1',
          timestamp: '2026-07-30T10:00:03.000Z',
          role: 'toolResult',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'ok' }],
        },
        ASSISTANT_RECORD,
      ],
    })
    const { items } = await collect(provider(env).run(runContext().ctx))
    const rows = await materialize(items[0])
    assert.deepEqual(rows.map((r) => r.role), ['user', 'tool', 'assistant'])
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// R11: backfilled and settled-live rows are identity-identical
// ---------------------------------------------------------------------------

// @ref LLP 0157#requirements [tests]: R11, backfilled rows MUST be
// identity-identical to settled live rows so route overlap resolves to zero
// writes through the existing `part_id` dedupe.
//
// The live half of this test stands in for the settlement enricher (T8, a
// separate task): it runs the REAL live projector over the wire exchange, then
// performs exactly the upgrade the enricher performs -- look the row's LLP 0159
// match key up in an index built from the same session file, and replace the
// gateway's fallback id with the record's native id -- and expands the result
// through the same `aiGatewayRowsFromProjectedExchange` the live recorder uses.
// Anything the enricher does beyond that (cwd gating, attribute cleanup) cannot
// change `message_id`/`part_id`, which is what R11 is about.
test('a backfilled row and a settled live row for the same turn carry identical message_id/part_id', async () => {
  const env = await stageEnv()
  try {
    const records = [USER_RECORD, ASSISTANT_RECORD]
    await writeSession(env, { header: { cwd: '/work/repo' }, records })

    // --- Route 1: backfill, straight off the authoritative session file.
    const { items } = await collect(provider(env).run(runContext().ctx))
    const backfilledRows = await materialize(items[0])

    // --- Route 2: live capture of the same turn, then settlement.
    const requestBody = {
      model: 'claude-sonnet-4-5',
      system: 'You are OpenClaw.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const responseBody = {
      id: 'msg_wire_01',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 7 },
    }
    const projection = createOpenclawExchangeProjector().project(
      /** @type {any} */ ({
        exchange_id: 'ex-1',
        ts_start: '2026-07-30T10:00:01.000Z',
        duration_ms: 250,
        request_headers: JSON.stringify({ 'x-hypaware-client': 'openclaw' }),
        request_body: JSON.stringify(requestBody),
        response_body: JSON.stringify(responseBody),
        stream_events: [],
      }),
      /** @type {any} */ ({ log: { debug() {}, info() {}, warn() {}, error() {} } })
    )
    assert.ok(projection, 'the live projector must claim this exchange')

    // The enricher's per-session index: LLP 0159 match key -> native id.
    /** @type {Map<string, string>} */
    const index = new Map()
    for (const record of records) {
      index.set(sessionMatchKey(record.role, record.content), record.id)
    }
    let upgraded = 0
    for (const message of /** @type {any} */ (projection).messages) {
      const nativeId = index.get(wireMatchKey(message.role, message.content))
      if (!nativeId) continue
      message.message_id = nativeId
      upgraded += 1
    }
    assert.equal(upgraded, 2, 'both live messages must settle onto a session-file record')

    const settledRows = aiGatewayRowsFromProjectedExchange(/** @type {any} */ (projection))

    // The whole point: same ids from both routes, so `part_id` dedupe collapses
    // the overlap to zero writes rather than landing the turn twice.
    assert.deepEqual(
      backfilledRows.map((r) => r.message_id),
      settledRows.map((r) => r.message_id)
    )
    assert.deepEqual(
      backfilledRows.map((r) => r.part_id),
      settledRows.map((r) => r.part_id)
    )
    assert.deepEqual(backfilledRows.map((r) => r.part_id), ['msg-user-1#0', 'msg-asst-1#0'])
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// R10: the per-session usage-policy gate
// ---------------------------------------------------------------------------

// @ref LLP 0161#backfill-provider [tests]: a usable cwd is resolved once per
// file and an `ignore` verdict skips the whole file, never projecting any row.
test('a session whose header cwd is policy-ignored projects nothing at all', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, { header: { cwd: '/work/repo' }, records: [USER_RECORD, ASSISTANT_RECORD] })
    const { ctx, entries } = runContext()
    const { items, events } = await collect(
      provider(env, { resolver: ignoringResolver('/work/repo') }).run(ctx)
    )
    assert.equal(items.length, 0)
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'usage_policy_drop')
    assert.equal(events[0].attributes?.session_id, 'sess-1')
    const drop = entries.find((e) => e.message === 'openclaw.backfill.usage_policy_drop')
    assert.ok(drop, 'the drop must be logged')
    assert.equal(drop.fields.class, 'ignore')
    assert.equal(drop.fields.cwd, undefined, 'the raw cwd must never be logged')
    assert.match(String(drop.fields.cwd_hash), /^[0-9a-f]{16}$/)
  } finally {
    await env.cleanup()
  }
})

test('a session with no usable cwd is not gated, matching the existing convention', async () => {
  const env = await stageEnv()
  try {
    // A relative cwd is unconfirmable, so the LLP 0158 reader refuses it: the
    // session is ungated rather than resolved against the daemon's own cwd.
    await writeSession(env, { header: { cwd: '../elsewhere' }, records: [USER_RECORD, ASSISTANT_RECORD] })
    const { items } = await collect(
      provider(env, { resolver: ignoringResolver('/work/repo') }).run(runContext().ctx)
    )
    assert.equal(items.length, 1)
    assert.equal(value(items[0]).cwd, undefined)
  } finally {
    await env.cleanup()
  }
})

test('an unrelated ignored directory leaves the session projecting', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, { header: { cwd: '/work/repo' }, records: [USER_RECORD, ASSISTANT_RECORD] })
    const { items } = await collect(
      provider(env, { resolver: ignoringResolver('/work/other') }).run(runContext().ctx)
    )
    assert.equal(items.length, 1)
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// R10: the CLI-backend allowlist, which fails closed
// ---------------------------------------------------------------------------

// @ref LLP 0147 [tests]: a CLI-backend turn belongs to the sibling Claude/Codex
// transcript adapters, so backfill excludes it and names the route that covers
// it instead of re-projecting it under client_name = openclaw.
test('a claude-cli turn is excluded whole, prompt included, and reported as covered elsewhere', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, {
      header: { cwd: '/work/repo' },
      records: [
        USER_RECORD,
        ASSISTANT_RECORD,
        {
          id: 'msg-user-2',
          timestamp: '2026-07-30T10:01:00.000Z',
          role: 'user',
          content: [{ type: 'text', text: 'delegate this' }],
        },
        {
          id: 'msg-asst-2',
          timestamp: '2026-07-30T10:01:05.000Z',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          model: 'claude-cli/sonnet',
          provider: 'claude-cli',
          api: 'anthropic-messages',
        },
      ],
    })
    const { items, events } = await collect(provider(env).run(runContext().ctx))
    const exchange = value(items[0])
    assert.deepEqual(exchange.messages.map((/** @type {any} */ m) => m.message_id), ['msg-user-1', 'msg-asst-1'])
    const excluded = events.filter((e) => e.event === 'excluded_backend')
    assert.equal(excluded.length, 1)
    assert.equal(excluded[0].attributes?.provider, 'claude-cli')
    // The prompt of the delegated turn goes with it: the Claude transcript
    // already holds that whole turn.
    assert.equal(excluded[0].attributes?.record_count, 2)
    assert.equal(excluded[0].attributes?.covered_by, 'claude_transcript')
  } finally {
    await env.cleanup()
  }
})

test('an unrecognized provider fails closed: excluded, reported, and not covered_by anything', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, {
      header: { cwd: '/work/repo' },
      records: [
        { ...ASSISTANT_RECORD, id: 'msg-x', provider: 'some-future-vendor' },
      ],
    })
    const { items, events } = await collect(provider(env).run(runContext().ctx))
    assert.equal(items.length, 0, 'nothing projectable survived, so no item is yielded')
    assert.equal(events.length, 1)
    assert.equal(events[0].attributes?.provider, 'some-future-vendor')
    assert.equal(events[0].attributes?.covered_by, undefined)
  } finally {
    await env.cleanup()
  }
})

test('a session that never states a provider projects nothing', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, { header: { cwd: '/work/repo' }, records: [USER_RECORD] })
    const { items, events } = await collect(provider(env).run(runContext().ctx))
    assert.equal(items.length, 0)
    assert.equal(events[0].attributes?.provider, 'unknown')
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Scan bounds and degradation
// ---------------------------------------------------------------------------

test('records outside the resolved window are not projected', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, { header: { cwd: '/work/repo' }, records: [USER_RECORD, ASSISTANT_RECORD] })
    const { ctx } = runContext({ since: '2026-07-30T10:00:01.500Z' })
    const { items } = await collect(provider(env).run(ctx))
    assert.equal(items.length, 1)
    assert.deepEqual(value(items[0]).messages.map((/** @type {any} */ m) => m.message_id), ['msg-asst-1'])
  } finally {
    await env.cleanup()
  }
})

test('every agent under the agents root is scanned, in a deterministic order', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, { agentId: 'beta', sessionId: 'sess-b', header: { cwd: '/work/repo' }, records: [ASSISTANT_RECORD] })
    await writeSession(env, { agentId: 'alpha', sessionId: 'sess-a', header: { cwd: '/work/repo' }, records: [ASSISTANT_RECORD] })
    const { items } = await collect(provider(env).run(runContext().ctx))
    assert.deepEqual(items.map((item) => value(item).session_id), ['sess-a', 'sess-b'])
    assert.deepEqual(items.map((item) => value(item).attributes.openclaw.agent_id), ['alpha', 'beta'])
  } finally {
    await env.cleanup()
  }
})

test('a missing OpenClaw install scans to zero sessions rather than failing the run', async () => {
  const env = await stageEnv()
  try {
    const { ctx, entries } = runContext()
    const { items, events } = await collect(provider(env).run(ctx))
    assert.equal(items.length, 0)
    assert.equal(events.length, 0)
    const complete = entries.find((e) => e.message === 'openclaw.backfill.scan_complete')
    assert.equal(complete.fields.files_seen, 0)
  } finally {
    await env.cleanup()
  }
})

test('a session file with no readable header still projects, ungated', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, { header: null, records: [USER_RECORD, ASSISTANT_RECORD] })
    const { items } = await collect(provider(env).run(runContext().ctx))
    assert.equal(items.length, 1)
    // `session_id` is the non-null partition key, so it falls back to the file
    // name OpenClaw derives from the session id.
    assert.equal(value(items[0]).session_id, 'sess-1')
    assert.equal(value(items[0]).cwd, undefined)
  } finally {
    await env.cleanup()
  }
})

test('plan() reports the session files a run would scan without projecting them', async () => {
  const env = await stageEnv()
  try {
    const filePath = await writeSession(env, { header: { cwd: '/work/repo' }, records: [ASSISTANT_RECORD] })
    const plan = await provider(env).plan?.(/** @type {any} */ ({ env: {}, cacheRoot: '', log: captureLog().log }))
    assert.equal(plan?.estimated_items, 1)
    assert.deepEqual(plan?.sources, [filePath])
  } finally {
    await env.cleanup()
  }
})

test('reruns are deterministic: the same session yields byte-identical row identity', async () => {
  const env = await stageEnv()
  try {
    await writeSession(env, { header: { cwd: '/work/repo' }, records: [USER_RECORD, ASSISTANT_RECORD] })
    const first = await collect(provider(env).run(runContext().ctx))
    const second = await collect(provider(env).run(runContext().ctx))
    const firstRows = await materialize(first.items[0])
    const secondRows = await materialize(second.items[0])
    assert.deepEqual(firstRows.map((r) => r.part_id), secondRows.map((r) => r.part_id))
  } finally {
    await env.cleanup()
  }
})
