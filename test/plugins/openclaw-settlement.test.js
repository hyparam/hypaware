// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createOpenclawSettlementEnricher } from '../../hypaware-core/plugins-workspace/openclaw/src/settle.js'
import { wireMatchKey } from '../../hypaware-core/plugins-workspace/openclaw/src/match_key.js'
import { USAGE_POLICY_DROP } from '../../src/core/usage-policy/index.js'

/**
 * @import { UsagePolicyResolver } from '../../src/core/usage-policy/types.js'
 */

// The `@hypaware/openclaw` flush-time settlement enricher (LLP 0161
// Section 6). Two properties are load-bearing and tested here directly:
//
//  - identity: a live row captured under gateway fallback identity must
//    upgrade to the session JSONL's native message id, because that id is
//    what the backfill provider will emit for the same turn and what the
//    `part_id` dedupe uses to collapse the two routes (LLP 0159).
//  - policy: this is the ONLY `.hypignore` seam OpenClaw has (live proxy
//    rows carry no cwd at all), so a session whose header cwd resolves to
//    `ignore` must drop here or never (LLP 0157 R14 / LLP 0085).
//
// @ref LLP 0161#settlement-enricher [tests]
// @ref LLP 0157#requirements [tests]: R14

/**
 * Session start. Anchored to "ten minutes ago" rather than a fixed instant
 * because the enricher windows candidate session files by `mtime` against
 * the batch's own row timestamps (a flush cannot belong to a file written
 * long before it), and these fixtures are written at test time.
 */
const T0 = Date.now() - 10 * 60 * 1000
const SESSION_CWD = '/repo/proj'
const NATIVE_SESSION_ID = 'sess-native-0001'
/** The prompt-head hash the live projector keys the session on (LLP 0144). */
const HASH_SESSION_ID = 'a1b2c3d4e5f60011'

/**
 * A realistic OpenClaw session transcript: a user turn, an assistant turn
 * that both speaks and calls a tool, the tool's standalone `toolResult`
 * record (OpenClaw's own shape, which the Anthropic wire nests inside a
 * `user` turn instead), and the assistant's closing turn.
 *
 * @returns {Record<string, unknown>[]}
 */
function realisticSessionRecords() {
  return [
    { type: 'session', version: 3, id: NATIVE_SESSION_ID, cwd: SESSION_CWD, timestamp: iso(T0) },
    {
      type: 'message',
      id: 'msg-0001',
      role: 'user',
      content: [{ type: 'text', text: 'list the files' }],
      timestamp: iso(T0 + 1_000),
    },
    {
      type: 'message',
      id: 'msg-0002',
      role: 'assistant',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      api: 'anthropic-messages',
      stopReason: 'toolUse',
      usage: { input: 120, output: 34 },
      content: [
        { type: 'text', text: 'Sure, listing them now.' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
      ],
      timestamp: iso(T0 + 2_000),
    },
    {
      type: 'message',
      id: 'msg-0003',
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'bash',
      isError: false,
      content: 'a.txt\nb.txt',
      timestamp: iso(T0 + 3_000),
    },
    {
      type: 'message',
      id: 'msg-0004',
      role: 'assistant',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      api: 'anthropic-messages',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Two files: a.txt and b.txt.' }],
      timestamp: iso(T0 + 4_000),
    },
  ]
}

/**
 * The wire-shaped messages the gateway saw for the same session: the
 * Anthropic Messages request history plus the assistant response. Position
 * i here is position i in the session file, which is what makes the
 * ordinal/time fallback's positional alignment true.
 *
 * @returns {Array<{ role: string, content: unknown, ts: number }>}
 */
function realisticWireMessages() {
  return [
    { role: 'user', content: [{ type: 'text', text: 'list the files' }], ts: T0 + 1_000 },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Sure, listing them now.' },
        { type: 'tool_use', id: 'toolu_9', name: 'bash', input: { command: 'ls' } },
      ],
      ts: T0 + 2_000,
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'a.txt\nb.txt' }],
      ts: T0 + 3_000,
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Two files: a.txt and b.txt.' }], ts: T0 + 4_000 },
  ]
}

/** @param {number} ms */
function iso(ms) {
  return new Date(ms).toISOString()
}

/**
 * Put a `type: "message"` record's message fields where OpenClaw puts them:
 * `id`, `parentId`, and `timestamp` stay on the record line, `role`,
 * `content`, `model`, `provider`, `api`, `stopReason`, and `usage` nest under
 * `message` (verified against a live install, #543). Tests above author the
 * records flat and this is the one place that nests them, so the enricher is
 * always measured against the shape it will meet on disk rather than against
 * the flat envelope the suite used to invent.
 *
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
function sessionFileLine(record) {
  if (record.type !== 'message') return record
  const { type, id, timestamp, parentId, ...message } = record
  return {
    type,
    ...(id !== undefined ? { id } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    parentId: parentId ?? null,
    message: { ...message, ...(timestamp !== undefined ? { timestamp } : {}) },
  }
}

/**
 * Write a session file under a throwaway `agents/<agentId>/sessions/` root
 * and return the root.
 *
 * @param {Record<string, unknown>[]} records
 * @param {{ agentsDir?: string, agentId?: string, fileName?: string }} [opts]
 * @returns {string} the agents root
 */
function writeSessionFile(records, opts = {}) {
  const agentsDir = opts.agentsDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-openclaw-agents-'))
  const sessionsDir = path.join(agentsDir, opts.agentId ?? 'agent-main', 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionsDir, opts.fileName ?? `${NATIVE_SESSION_ID}.jsonl`),
    records.map((record) => JSON.stringify(sessionFileLine(record))).join('\n') + '\n'
  )
  return agentsDir
}

/**
 * One fallback-identity row as the gateway's expansion writes it: a
 * synthesized `message_id`, `gateway.identity_source = 'gateway_fallback'`,
 * and the projector's `openclaw.match_key` stamp (R8).
 *
 * @param {{
 *   role: string,
 *   content: unknown,
 *   messageIndex: number,
 *   partIndex?: number,
 *   ts: number,
 *   sessionId?: string,
 *   matchKey?: string,
 *   attributesAsJson?: boolean,
 * }} spec
 * @returns {Record<string, unknown>}
 */
function fallbackRow(spec) {
  const partIndex = spec.partIndex ?? 0
  const messageId = `fallbackhash${spec.messageIndex}${partIndex}`
  const attributes = {
    gateway: { identity_source: 'gateway_fallback' },
    openclaw: { match_key: spec.matchKey ?? wireMatchKey(spec.role, spec.content) },
  }
  return {
    session_id: spec.sessionId ?? HASH_SESSION_ID,
    client_name: 'openclaw',
    conversation_source: 'openclaw',
    message_id: messageId,
    part_id: `${messageId}#${partIndex}`,
    message_index: spec.messageIndex,
    part_index: partIndex,
    role: spec.role,
    message_created_at: iso(spec.ts),
    cwd: null,
    attributes: spec.attributesAsJson ? JSON.stringify(attributes) : attributes,
  }
}

/**
 * The rows one flush holds for the realistic session: every wire message,
 * with the assistant tool-calling turn expanded into its two part rows.
 *
 * @returns {Record<string, unknown>[]}
 */
function realisticRows() {
  const wire = realisticWireMessages()
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (let i = 0; i < wire.length; i++) {
    const message = wire[i]
    const parts = i === 1 ? 2 : 1
    for (let part = 0; part < parts; part++) {
      rows.push(fallbackRow({
        role: message.role,
        content: message.content,
        messageIndex: i,
        partIndex: part,
        ts: message.ts,
      }))
    }
  }
  return rows
}

/**
 * A resolver stub: every cwd resolves to `verdict`. Injected so these tests
 * assert the enricher's own behavior rather than the shared matcher's,
 * which has its own suite.
 *
 * @param {'ignore' | 'local-only' | 'full'} verdict
 * @returns {UsagePolicyResolver}
 */
function resolverStub(verdict) {
  return {
    resolve() {
      return { class: verdict, governedBy: verdict === 'full' ? null : `${SESSION_CWD}/.hypignore`, declared: verdict === 'full' ? null : verdict }
    },
    isIgnored() {
      return verdict === 'ignore'
    },
  }
}

/** A logger that records every event for shape assertions. */
function recordingLogger() {
  /** @type {Array<{ event: string, fields: Record<string, unknown> }>} */
  const events = []
  return {
    events,
    /** @param {string} event @param {Record<string, unknown>} [fields] */
    info(event, fields) { events.push({ event, fields: fields ?? {} }) },
    /** @param {string} event @param {Record<string, unknown>} [fields] */
    warn(event, fields) { events.push({ event, fields: fields ?? {} }) },
  }
}

/**
 * @param {{ agentsDir: string, verdict?: 'ignore' | 'local-only' | 'full', logger?: ReturnType<typeof recordingLogger> }} opts
 */
function enricher(opts) {
  return createOpenclawSettlementEnricher({
    homeDir: '/nonexistent-home',
    agentsDir: opts.agentsDir,
    resolver: resolverStub(opts.verdict ?? 'full'),
    logger: opts.logger ?? recordingLogger(),
  })
}

const NO_CTX = /** @type {any} */ ({})

test('the enricher registers under the LLP 0161 name and client', () => {
  const settlement = enricher({ agentsDir: writeSessionFile(realisticSessionRecords()) })
  assert.equal(settlement.name, 'openclaw-settlement')
  assert.equal(settlement.clientName, 'openclaw')
})

// The open item LLP 0162 pins to this task: "does OpenClaw append session
// JSONL lines in real time, or buffer until session end?" The enricher's
// answer is measured, not assumed - this test IS the measurement harness,
// run against a session file whose records carry the shapes a real one does
// (toolCall blocks, a standalone toolResult record, a multi-block assistant
// turn). Every row settles by CONTENT here, so a match rate below 1 in the
// field is a statement about write latency, not about the normalization.
test('every row of a realistic, fully-written session settles by content match (rate 1.00)', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const logger = recordingLogger()
  const rows = realisticRows()
  const out = await enricher({ agentsDir, logger }).settle(rows, NO_CTX)

  const summary = logger.events.find((e) => e.event === 'plugin.openclaw.settlement')
  assert.ok(summary, 'a settlement summary is emitted per session')
  assert.equal(summary.fields.status, 'ok')
  assert.equal(summary.fields.rows, rows.length)
  assert.equal(summary.fields.content_matches, rows.length)
  assert.equal(summary.fields.ordinal_matches, 0)
  assert.equal(summary.fields.unmatched, 0)
  assert.equal(summary.fields.native_session_id, NATIVE_SESSION_ID)
  // The measured settlement match rate, the number LLP 0159's Consequences
  // say would trigger revisiting the route-agreement design.
  const matchRate = Number(summary.fields.content_matches) / Number(summary.fields.rows)
  assert.equal(matchRate, 1)

  // Native identity, per message, with the two part rows of the assistant
  // tool-calling turn sharing one native message id.
  assert.deepEqual(out.map((row) => /** @type {any} */ (row).message_id), [
    'msg-0001', 'msg-0002', 'msg-0002', 'msg-0003', 'msg-0004',
  ])
  assert.deepEqual(out.map((row) => /** @type {any} */ (row).part_id), [
    'msg-0001#0', 'msg-0002#0', 'msg-0002#1', 'msg-0003#0', 'msg-0004#0',
  ])
  for (const row of out) {
    const settled = /** @type {any} */ (row)
    // The session container id is native too, so a backfilled twin lands in
    // the same partition (LLP 0159#decision).
    assert.equal(settled.session_id, NATIVE_SESSION_ID)
    // The header cwd is stamped: live OpenClaw rows have no other source.
    assert.equal(settled.cwd, SESSION_CWD)
    // Spent provenance is gone now that identity is native.
    assert.equal(settled.attributes.gateway.identity_source, undefined)
    assert.equal(settled.attributes.openclaw, undefined)
  }
})

test('a match_key stored as a JSON attributes string settles the same way', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const row = fallbackRow({
    role: 'user',
    content: [{ type: 'text', text: 'list the files' }],
    messageIndex: 0,
    ts: T0 + 1_000,
    attributesAsJson: true,
  })
  const out = await enricher({ agentsDir }).settle([row], NO_CTX)
  assert.equal(/** @type {any} */ (out[0]).message_id, 'msg-0001')
  assert.equal(/** @type {any} */ (out[0]).attributes.openclaw, undefined)
})

// OpenClaw prepends `[Mon 2026-08-03 15:33 PDT] ` to user messages on the
// wire while its session file stores the bare text. Before the match-key
// normalization, this row content-missed and stayed at fallback identity
// while its exchange's assistant rows settled - the exact residual observed
// live on 2026-08-03 (20 stray prefixed user rows, zero stray assistant
// rows).
// @ref LLP 0175#root-cause [tests]: a timestamp-prefixed wire user turn
// settles by content onto the bare session-file record
test('a timestamp-prefixed wire user turn settles onto its bare session record', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const logger = recordingLogger()
  const row = fallbackRow({
    role: 'user',
    content: [{ type: 'text', text: '[Mon 2026-08-03 15:33 PDT] list the files' }],
    messageIndex: 0,
    ts: T0 + 1_000,
  })
  const out = await enricher({ agentsDir, logger }).settle([row], NO_CTX)
  assert.equal(/** @type {any} */ (out[0]).message_id, 'msg-0001')
  assert.equal(/** @type {any} */ (out[0]).session_id, NATIVE_SESSION_ID)
  const summary = logger.events.find((e) => e.event === 'plugin.openclaw.settlement')
  assert.equal(summary?.fields.content_matches, 1)
  assert.equal(summary?.fields.ordinal_matches, 0)
})

// @ref LLP 0157#requirements [tests]: R14, a row whose session cwd resolves
// to `ignore` is dropped at settlement, before it is committed.
test('an ignore-classed session cwd drops every row of that session', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const logger = recordingLogger()
  const rows = realisticRows()
  const out = await enricher({ agentsDir, verdict: 'ignore', logger }).settle(rows, NO_CTX)

  assert.equal(out.length, rows.length, 'drops are positional sentinels, not removals')
  for (const entry of out) assert.equal(entry, USAGE_POLICY_DROP)

  const drops = logger.events.filter((e) => e.event === 'plugin.openclaw.usage_policy_drop')
  assert.equal(drops.length, rows.length)
  const fields = drops[0].fields
  assert.equal(fields.component, 'openclaw')
  assert.equal(fields.operation, 'usage_policy_drop')
  assert.equal(fields.policy_source, 'settlement_late_resolve')
  assert.equal(fields.session_id, HASH_SESSION_ID)
  assert.equal(fields.declared, 'ignore')
  // @ref LLP 0085#telemetry [tests]: the event carries a hashed cwd, never
  // the raw local path.
  assert.match(String(fields.cwd_hash), /^[0-9a-f]{16}$/)
  for (const value of Object.values(fields)) {
    assert.notEqual(value, SESSION_CWD)
  }
})

// The drop is independent of match success: it is the session header's cwd,
// not the matched message's, so an unmatchable row in an ignored session
// must still drop rather than commit unnoticed.
test('a row that matches nothing still drops when its session cwd is ignored', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const rows = [
    ...realisticRows(),
    fallbackRow({
      role: 'assistant',
      content: [{ type: 'text', text: 'a turn the session file never recorded' }],
      messageIndex: 42,
      ts: T0 + 5_000,
    }),
  ]
  const out = await enricher({ agentsDir, verdict: 'ignore' }).settle(rows, NO_CTX)
  assert.equal(out[out.length - 1], USAGE_POLICY_DROP)
})

// @ref LLP 0161#match-keys [tests]: the ordinal/time fallback is a separate
// SECOND pass, tried only after content matching misses.
test('a content miss settles through the ordinal/time fallback when position, role and time align', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const logger = recordingLogger()
  const rows = realisticRows()
  // Rewrite the closing assistant row's content key to something the file
  // never carried (the shape divergence LLP 0159 warns content matching can
  // hit); its position, role and timestamp still line up with msg-0004.
  const last = rows[rows.length - 1]
  last.attributes = {
    gateway: { identity_source: 'gateway_fallback' },
    openclaw: { match_key: wireMatchKey('assistant', [{ type: 'text', text: 'normalized differently' }]) },
  }
  const out = await enricher({ agentsDir, logger }).settle(rows, NO_CTX)

  assert.equal(/** @type {any} */ (out[out.length - 1]).message_id, 'msg-0004')
  const summary = logger.events.find((e) => e.event === 'plugin.openclaw.settlement')
  assert.equal(summary?.fields.content_matches, rows.length - 1)
  assert.equal(summary?.fields.ordinal_matches, 1)
})

test('the ordinal fallback declines outside its five-minute window', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const rows = realisticRows()
  const last = rows[rows.length - 1]
  last.attributes = {
    gateway: { identity_source: 'gateway_fallback' },
    openclaw: { match_key: wireMatchKey('assistant', [{ type: 'text', text: 'normalized differently' }]) },
  }
  last.message_created_at = iso(T0 + 20 * 60 * 1000)
  const out = await enricher({ agentsDir }).settle(rows, NO_CTX)
  const settled = /** @type {any} */ (out[out.length - 1])
  assert.equal(settled.message_id, /** @type {any} */ (last).message_id, 'identity stays at fallback')
  // The cwd still lands: policy rides the session, not the match.
  assert.equal(settled.cwd, SESSION_CWD)
})

test('the ordinal fallback declines when the file records a different role at that position', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const rows = realisticRows()
  const last = rows[rows.length - 1]
  last.attributes = {
    gateway: { identity_source: 'gateway_fallback' },
    openclaw: { match_key: wireMatchKey('user', [{ type: 'text', text: 'normalized differently' }]) },
  }
  last.role = 'user'
  const out = await enricher({ agentsDir }).settle(rows, NO_CTX)
  assert.equal(/** @type {any} */ (out[out.length - 1]).message_id, /** @type {any} */ (last).message_id)
})

// Two session messages with identical content own one content key between
// them: upgrading both rows to one native message id would give them one
// part_id as well, and part_id dedupe would then collapse two distinct
// messages into one committed row. Declining costs only an unsettled row.
test('an ambiguous content key declines to upgrade rather than duplicating a native id', async () => {
  const records = [
    { type: 'session', version: 3, id: NATIVE_SESSION_ID, cwd: SESSION_CWD, timestamp: iso(T0) },
    {
      type: 'message', id: 'msg-0001', role: 'user',
      content: [{ type: 'text', text: 'anchor' }], timestamp: iso(T0 + 1_000),
    },
    {
      type: 'message', id: 'msg-0002', role: 'assistant',
      content: [{ type: 'text', text: 'same' }], timestamp: iso(T0 + 2_000),
    },
    {
      type: 'message', id: 'msg-0003', role: 'assistant',
      content: [{ type: 'text', text: 'same' }], timestamp: iso(T0 + 3_000),
    },
  ]
  const agentsDir = writeSessionFile(records)
  const anchor = fallbackRow({
    role: 'user', content: [{ type: 'text', text: 'anchor' }], messageIndex: 0, ts: T0 + 1_000,
  })
  // Out of the fallback window, so the second pass cannot rescue what the
  // ambiguity check refused.
  const twins = [1, 2].map((i) => fallbackRow({
    role: 'assistant',
    content: [{ type: 'text', text: 'same' }],
    messageIndex: i,
    ts: T0 + 30 * 60 * 1000,
  }))
  const out = await enricher({ agentsDir }).settle([anchor, ...twins], NO_CTX)

  assert.equal(/** @type {any} */ (out[0]).message_id, 'msg-0001', 'the unambiguous row still settles')
  assert.equal(/** @type {any} */ (out[1]).message_id, /** @type {any} */ (twins[0]).message_id)
  assert.equal(/** @type {any} */ (out[2]).message_id, /** @type {any} */ (twins[1]).message_id)
})

// A wrong binding would apply an unrelated session's cwd verdict, and that
// verdict DROPS rows: an absent binding must degrade to "unsettled", never
// to "settled against whatever session was running".
test('rows no session file claims are neither upgraded nor dropped', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const logger = recordingLogger()
  const stranger = fallbackRow({
    role: 'user',
    content: [{ type: 'text', text: 'a session this machine never wrote to disk' }],
    messageIndex: 0,
    ts: T0 + 1_000,
    sessionId: 'ffffffffffffffff',
  })
  const out = await enricher({ agentsDir, verdict: 'ignore', logger }).settle([stranger], NO_CTX)
  assert.equal(out[0], stranger, 'returned by identity: nothing settled, nothing dropped')
  const summary = logger.events.find((e) => e.event === 'plugin.openclaw.settlement')
  assert.equal(summary?.fields.status, 'unbound')
})

test('two concurrent sessions each bind to their own file', async () => {
  const other = [
    { type: 'session', version: 3, id: 'sess-native-0002', cwd: '/repo/other', timestamp: iso(T0) },
    {
      type: 'message', id: 'other-0001', role: 'user',
      content: [{ type: 'text', text: 'a different conversation' }], timestamp: iso(T0 + 1_000),
    },
  ]
  const agentsDir = writeSessionFile(realisticSessionRecords())
  writeSessionFile(other, { agentsDir, agentId: 'agent-two', fileName: 'sess-native-0002.jsonl' })

  const rows = [
    ...realisticRows(),
    fallbackRow({
      role: 'user',
      content: [{ type: 'text', text: 'a different conversation' }],
      messageIndex: 0,
      ts: T0 + 1_000,
      sessionId: 'bbbbbbbbbbbbbbbb',
    }),
  ]
  const out = await enricher({ agentsDir }).settle(rows, NO_CTX)
  assert.equal(/** @type {any} */ (out[0]).session_id, NATIVE_SESSION_ID)
  assert.equal(/** @type {any} */ (out[out.length - 1]).session_id, 'sess-native-0002')
  assert.equal(/** @type {any} */ (out[out.length - 1]).cwd, '/repo/other')
})

// Best-effort, never throws: a settlement failure degrades to "row stays at
// fallback identity, no drop", never to a lost row (LLP 0161 Section 6).
test('a missing agents root settles nothing and throws nothing', async () => {
  const rows = realisticRows()
  const out = await enricher({
    agentsDir: path.join(os.tmpdir(), 'hyp-openclaw-absent-agents-root'),
    verdict: 'ignore',
  }).settle(rows, NO_CTX)
  assert.deepEqual(out, rows)
})

test('an unparseable session file settles nothing and throws nothing', async () => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-openclaw-agents-'))
  const sessionsDir = path.join(agentsDir, 'agent-main', 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.writeFileSync(path.join(sessionsDir, 'broken.jsonl'), 'not json at all\n{"type":"message"\n')
  const rows = realisticRows()
  const out = await enricher({ agentsDir, verdict: 'ignore' }).settle(rows, NO_CTX)
  assert.deepEqual(out, rows)
})

// A header with no usable cwd (absent, or the relative value the LLP 0158
// reader refuses) leaves the session ungated: identity still settles, and
// nothing drops, since nothing established what directory governs it.
test('a session header with no usable cwd upgrades identity without gating', async () => {
  const records = realisticSessionRecords()
  records[0] = { type: 'session', version: 3, id: NATIVE_SESSION_ID, cwd: '../elsewhere', timestamp: iso(T0) }
  const agentsDir = writeSessionFile(records)
  const rows = realisticRows()
  const out = await enricher({ agentsDir, verdict: 'ignore' }).settle(rows, NO_CTX)
  assert.equal(/** @type {any} */ (out[0]).message_id, 'msg-0001')
  assert.equal(/** @type {any} */ (out[0]).cwd, null)
  for (const entry of out) assert.notEqual(entry, USAGE_POLICY_DROP)
})

test('an already-populated row cwd is never overwritten by the header', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const row = fallbackRow({
    role: 'user', content: [{ type: 'text', text: 'list the files' }], messageIndex: 0, ts: T0 + 1_000,
  })
  row.cwd = '/somewhere/already/known'
  const out = await enricher({ agentsDir }).settle([row], NO_CTX)
  assert.equal(/** @type {any} */ (out[0]).cwd, '/somewhere/already/known')
})

test('an empty batch is returned untouched', async () => {
  const agentsDir = writeSessionFile(realisticSessionRecords())
  const out = await enricher({ agentsDir }).settle([], NO_CTX)
  assert.deepEqual(out, [])
})
