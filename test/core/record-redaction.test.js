// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService, repairMaskedTypedValues } from '../../src/core/cache/storage.js'
import { SECRET_MASK as MASK } from '../../src/core/secret_rules.js'
import { createRecordRedactor } from '../../src/core/sinks/redaction.js'
import { withLogRecords } from '../helpers/log_records.js'

/** @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js' */

// Built at runtime so no literal here looks like a live credential.
const repeat = (/** @type {string} */ unit, /** @type {number} */ count) => unit.repeat(count)
const jwt = [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
  Buffer.from('{"sub":"user-1"}').toString('base64url'),
  repeat('Qx9', 14),
].join('.')
/** Every format the built-in rules mask, each as it would appear in content. */
const SECRETS = {
  openai: 'sk-' + 'proj-' + repeat('aB3', 14),
  anthropic: 'sk-' + 'ant-' + repeat('aB3', 14),
  github: 'gh' + 'p_' + repeat('aB3', 12),
  githubPat: 'github_' + 'pat_' + repeat('aB3', 14),
  aws: 'AK' + 'IA' + repeat('ABCD', 4),
  slack: 'xo' + 'xb-' + repeat('aB3', 8),
  bearer: 'Bearer ' + repeat('b', 32),
  databaseUrl: 'postgres://' + 'alice:private@db.example/db',
  assignment: 'password = ' + 'hunter22',
  privateKey: '-----BEGIN ' + 'PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  google: 'AI' + 'za' + repeat('Xy7_k', 7),
  stripe: 'sk_' + 'live_' + repeat('aB3', 8),
  jwt,
  entropy: 'Aa0' + 'qZ8mW2xR7tY4uP1oK6jH3gF9dS5aL0zX7cV2bN4'.slice(0, 37),
}
const SECRET_VALUES = Object.values(SECRETS)
/** An assignment keeps its key name; every other format is replaced whole. */
const maskedAs = (/** @type {string} */ label) => label === 'assignment' ? `password = ${MASK}` : MASK
const expectedText = (/** @type {string} */ label) => `before ${maskedAs(label)} after`
const labelOf = (/** @type {Record<string, unknown>} */ row) => String(row.part_id).split('-')[1]

/** @type {ColumnSpec[]} */
const COLUMNS = ['client_name', 'session_id', 'part_id', 'message_hash', 'part_type', 'tool_name', 'tool_call_id',
  'tool_result_for', 'tool_args', 'content_text', 'raw_frame', 'attributes'].map(name => ({ name, type: 'STRING', nullable: true }))

/** @param {string} label @param {string} secret @param {number} index */
function rowWith(label, secret, index) {
  return {
    client_name: 'claude',
    session_id: 'record-session',
    part_id: `${label}-${index}`,
    message_hash: `hash-${label}-${index}`,
    content_text: `before ${secret} after`,
    raw_frame: JSON.stringify({ type: 'text', text: `frame ${secret}` }),
  }
}

/** @param {Record<string, unknown>[]} rows */
function leaked(rows) {
  const text = JSON.stringify(rows)
  return SECRET_VALUES.filter(secret => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))
}

/** @param {ReturnType<typeof createQueryStorageService>} storage */
async function committedRows(storage) {
  const rows = []
  for (const part of await storage.discoverCachePartitions()) for await (const row of storage.readRows(part.path)) rows.push(row)
  return rows
}

async function tempCache(/** @type {any} */ t) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-record-redaction-'))
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  return cacheRoot
}

// @ref LLP 0568#seam [tests]: every write method persists only redacted content
test('every supported secret format is masked before the spool and before each commit path', async t => {
  const cacheRoot = await tempCache(t)
  const storage = createQueryStorageService({ cacheRoot })
  const entries = Object.entries(SECRETS)
  const spoolTable = storage.cacheTablePath('messages', ['source=claude'])
  await storage.appendRows(spoolTable, COLUMNS, entries.map(([label, secret], i) => rowWith(`spool-${label}`, secret, i)))
  // Spooled, not yet committed: the spool file itself holds no secret.
  const spooled = await Array.fromAsync(storage.readSpooledRows('messages'))
  assert.equal(spooled.length, entries.length)
  assert.deepEqual(leaked(spooled), [])
  assert.deepEqual(spooled.map(row => row.content_text), entries.map(([label]) => expectedText(label)))
  // Identity columns are kept verbatim.
  assert.deepEqual(spooled.map(row => row.part_id), entries.map(([label], i) => `spool-${label}-${i}`))
  assert.ok(spooled.every(row => String(row.message_hash).startsWith('hash-')))

  await storage.appendRowsToPartition('messages', ['source=direct'], COLUMNS, entries.map(([label, secret], i) => rowWith(`direct-${label}`, secret, i)))
  assert.ok(storage.reconcileRows && storage.reconcileRowsBatch)
  const scope = { where: { client_name: 'claude', session_id: 'record-session' }, key: 'part_id' }
  await storage.reconcileRows('snapshots', COLUMNS, entries.map(([label, secret], i) => rowWith(`reconcile-${label}`, secret, i)), scope)
  await storage.reconcileRowsBatch('batched', COLUMNS, [{ scope, rows: entries.map(([label, secret], i) => rowWith(`batch-${label}`, secret, i)) }])
  await storage.flushAll({ force: true })

  const rows = await committedRows(storage)
  assert.equal(rows.length, entries.length * 4)
  assert.deepEqual(leaked(rows), [])
  for (const row of rows) {
    assert.equal(row.content_text, expectedText(labelOf(row)), String(row.part_id))
    assert.equal(JSON.parse(String(row.raw_frame)).text, `frame ${maskedAs(labelOf(row))}`, String(row.part_id))
  }
})

test('a reconcile of the same snapshot is a no-op once its rows are recorded redacted', async t => {
  const cacheRoot = await tempCache(t)
  const storage = createQueryStorageService({ cacheRoot })
  assert.ok(storage.reconcileRows)
  const scope = { where: { client_name: 'claude', session_id: 'record-session' }, key: 'part_id' }
  const rows = [rowWith('again', SECRETS.openai, 0)]
  assert.equal(await storage.reconcileRows('snapshots', COLUMNS, rows, scope), 1)
  assert.equal(await storage.reconcileRows('snapshots', COLUMNS, rows, scope), 0)
  assert.equal(rows[0].content_text, `before ${SECRETS.openai} after`, 'the caller keeps its own rows')
})

test('content a settle hook writes into a spooled row is redacted before the commit', async t => {
  const cacheRoot = await tempCache(t)
  let sawRedactedSpool = false
  const storage = createQueryStorageService({
    cacheRoot,
    getSettleHook: () => async rows => {
      sawRedactedSpool = rows.every(row => row.content_text === `before ${MASK} after`)
      // The enricher rebuilds a frame from the source transcript, raw.
      return rows.map(row => ({ ...row, raw_frame: JSON.stringify({ type: 'text', text: `transcript ${SECRETS.anthropic}` }) }))
    },
  })
  const table = storage.cacheTablePath('messages', ['source=claude'])
  await storage.appendRows(table, COLUMNS, [rowWith('settled', SECRETS.github, 0)])
  await storage.flushAll({ force: true })
  assert.ok(sawRedactedSpool)
  const rows = await committedRows(storage)
  assert.deepEqual(leaked(rows), [])
  assert.equal(JSON.parse(String(rows[0].raw_frame)).text, `transcript ${MASK}`)
})

test('a sensitive-file read is masked when its call and its result arrive in separate appends', async t => {
  const cacheRoot = await tempCache(t)
  const storage = createQueryStorageService({ cacheRoot })
  const table = storage.cacheTablePath('messages', ['source=claude'])
  const base = { client_name: 'claude', session_id: 'record-session' }
  await storage.appendRows(table, COLUMNS, [{ ...base, part_id: 'call', part_type: 'tool_call', tool_name: 'Read', tool_call_id: 'c1', tool_args: '{"file_path":"/work/.env"}', content_text: 'reading' }])
  await storage.appendRows(table, COLUMNS, [
    { ...base, part_id: 'result', part_type: 'tool_result', tool_name: 'Read', tool_result_for: 'c1', content_text: 'DB_HOST=internal-only' },
    // A read whose call this process never saw is kept: a record-time mask cannot be undone.
    { ...base, part_id: 'other', part_type: 'tool_result', tool_name: 'Read', tool_result_for: 'c2', content_text: 'plain source text' },
  ])
  const spooled = await Array.fromAsync(storage.readSpooledRows('messages'))
  assert.deepEqual(spooled.map(row => [row.part_id, row.content_text]), [['call', MASK], ['result', MASK], ['other', 'plain source text']])
  assert.equal(spooled[0].tool_args, '{"file_path":"/work/.env"}', 'the path itself is kept')
})

test('a sensitive-file read written again after its first write is still masked', async t => {
  const cacheRoot = await tempCache(t)
  const storage = createQueryStorageService({ cacheRoot })
  const table = storage.cacheTablePath('messages', ['source=claude'])
  const base = { client_name: 'claude', session_id: 'record-session' }
  await storage.appendRows(table, COLUMNS, [{ ...base, part_id: 'call', part_type: 'tool_call', tool_name: 'Read', tool_call_id: 'c1', tool_args: '{"file_path":"/work/.env"}' }])
  // The gateway replays a result whose append failed; the call is not sent again.
  const result = { ...base, part_id: 'result', part_type: 'tool_result', tool_name: 'Read', tool_result_for: 'c1', content_text: 'DB_HOST=internal-only' }
  await storage.appendRows(table, COLUMNS, [result])
  await storage.appendRows(table, COLUMNS, [result])
  const spooled = await Array.fromAsync(storage.readSpooledRows('messages'))
  assert.deepEqual(spooled.filter(row => row.part_id === 'result').map(row => row.content_text), [MASK, MASK])
})

// @ref LLP 0568#irreversible [tests]: an over-budget row is written, and only the column past the budget degrades
test('a row past the traversal budget is still written, keeping the columns that fit the budget', async t => {
  const cacheRoot = await tempCache(t)
  const big = `${SECRETS.stripe} ${repeat('x', 9 * 1024 * 1024)}`
  const attributes = { gateway: { identity_source: 'gateway_fallback' }, usage: { input_tokens: 5 }, note: SECRETS.openai }
  const { result: [row], records } = await withLogRecords(async () => {
    const storage = createQueryStorageService({ cacheRoot })
    const table = storage.cacheTablePath('messages', ['source=claude'])
    await storage.appendRows(table, COLUMNS, [{ client_name: 'claude', session_id: 's', part_id: 'big', content_text: big, attributes }])
    return Array.fromAsync(storage.readSpooledRows('messages'))
  })
  assert.equal(row.part_id, 'big')
  assert.equal(String(row.content_text).length, big.length - SECRETS.stripe.length + MASK.length)
  assert.ok(String(row.content_text).startsWith(`${MASK} xxx`))
  // The column that fit its budget got the full walk: marker and usage kept, its secret masked.
  const kept = typeof row.attributes === 'string' ? JSON.parse(row.attributes) : row.attributes
  assert.deepEqual(kept, { gateway: { identity_source: 'gateway_fallback' }, usage: { input_tokens: 5 }, note: MASK })
  assert.ok(records.some(record => record.body === 'cache.record_redaction_over_budget'))
})

test('a sensitive-file write past the traversal budget keeps only its path', async t => {
  const cacheRoot = await tempCache(t)
  const storage = createQueryStorageService({ cacheRoot })
  const table = storage.cacheTablePath('messages', ['source=claude'])
  const content = `API_TOKEN=plain ${repeat('x', 9 * 1024 * 1024)}`
  await storage.appendRows(table, COLUMNS, [{
    client_name: 'claude', session_id: 's', part_id: 'write', part_type: 'tool_call', tool_name: 'Write', tool_call_id: 'w1',
    tool_args: JSON.stringify({ file_path: '/work/.env', content }), content_text: 'writing the env file',
  }])
  const [row] = await Array.fromAsync(storage.readSpooledRows('messages'))
  assert.deepEqual(JSON.parse(String(row.tool_args)), { file_path: '/work/.env', content: MASK })
  assert.equal(row.content_text, MASK)
})

test('a row holding a token run of several million characters is masked and its batch is written whole', async t => {
  // The run overflowed a secret rule, so the append rejected and every row in the batch was lost (issue #2991).
  const storage = createQueryStorageService({ cacheRoot: await tempCache(t) })
  const long = SECRETS.anthropic + repeat('aB3', 2_000_000)
  await storage.appendRows(storage.cacheTablePath('messages', ['source=claude']), COLUMNS,
    [rowWith('plain', 'nothing', 0), rowWith('long', long, 1), rowWith('slack', SECRETS.slack, 2)])
  const spooled = await Array.fromAsync(storage.readSpooledRows('messages'))
  assert.deepEqual(spooled.map(row => row.content_text), ['before nothing after', `before ${MASK} after`, `before ${MASK} after`])
})

test('the record redactor returns the same batch and rows when nothing is masked', () => {
  const redact = createRecordRedactor()
  const rows = [{ session_id: 's', content_text: 'nothing secret here', raw_frame: '{"text":"plain"}' }]
  const result = redact(rows)
  assert.equal(result.rows, rows)
  assert.equal(result.rows[0], rows[0])
  assert.equal(result.redacted, 0)
  const masked = redact([...rows, { content_text: SECRETS.slack }])
  assert.equal(masked.redacted, 1)
  assert.equal(masked.rows[0], rows[0])
})

test('a sensitive-file mask hides the payload but keeps timestamps and metadata, so the commit succeeds', async t => {
  const cacheRoot = await tempCache(t)
  const storage = createQueryStorageService({ cacheRoot })
  /** @type {ColumnSpec[]} */
  const columns = [...COLUMNS, { name: 'git_branch', type: 'STRING', nullable: true }, { name: 'client_version', type: 'STRING', nullable: true },
    { name: 'conversation_started_at', type: 'TIMESTAMP', nullable: false }, { name: 'received_at', type: 'TIMESTAMP', nullable: true }]
  const at = '2026-11-03T12:00:00.000Z'
  const base = { client_name: 'claude', session_id: 'record-session', git_branch: 'main', client_version: '2.1.316', conversation_started_at: at, received_at: at }
  await storage.appendRowsToPartition('messages', ['source=direct'], columns, [
    { ...base, part_id: 'call', part_type: 'tool_call', tool_name: 'Read', tool_call_id: 'c1', tool_args: '{"file_path":"/work/.env"}', content_text: 'reading' },
    { ...base, part_id: 'result', part_type: 'tool_result', tool_name: 'Read', tool_result_for: 'c1', content_text: 'DB_PASS=internal-only', raw_frame: '{"text":"DB_PASS=internal-only"}' },
  ])
  const rows = await committedRows(storage)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(new Date(/** @type {any} */ (row.conversation_started_at)).toISOString(), at)
    assert.equal(row.git_branch, 'main')
    assert.equal(row.client_version, '2.1.316')
    assert.equal(JSON.stringify(row).includes('internal-only'), false)
  }
})

test('a storage service built without record redaction persists rows as given', async t => {
  const cacheRoot = await tempCache(t)
  const storage = createQueryStorageService({ cacheRoot, recordRedaction: false })
  await storage.appendRowsToPartition('messages', ['source=direct'], COLUMNS, [rowWith('plain', SECRETS.github, 0)])
  const rows = await committedRows(storage)
  assert.equal(rows[0].content_text, `before ${SECRETS.github} after`)
})

// @ref LLP 0572#spool-repair [tests]: a date column is exempt by type, so a text rule that matches it changes nothing
test('a date column is kept verbatim at record time even when a text rule matches its value', async t => {
  const redact = createRecordRedactor()
  const row = { session_id: 's', started_at: SECRETS.slack, content_text: SECRETS.slack }
  const result = redact([row], undefined, new Set(['started_at']))
  assert.equal(result.rows[0].started_at, SECRETS.slack)
  assert.equal(result.rows[0].content_text, MASK)

  const cacheRoot = await tempCache(t)
  const storage = createQueryStorageService({ cacheRoot })
  /** @type {ColumnSpec[]} */
  const columns = [...COLUMNS, { name: 'conversation_started_at', type: 'TIMESTAMP', nullable: false }]
  await storage.appendRows(storage.cacheTablePath('messages', ['source=claude']), columns, [
    { client_name: 'claude', session_id: 's', part_id: 'p', content_text: SECRETS.slack, conversation_started_at: SECRETS.entropy },
  ])
  const [spooled] = await Array.fromAsync(storage.readSpooledRows('messages'))
  assert.equal(spooled.conversation_started_at, SECRETS.entropy)
  assert.equal(spooled.content_text, MASK)
})

/** @type {ColumnSpec[]} */
const DATED = [...COLUMNS,
  { name: 'message_id', type: 'STRING', nullable: true },
  { name: 'message_index', type: 'INT32', nullable: true },
  { name: 'conversation_started_at', type: 'TIMESTAMP', nullable: false },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false }]
const started = '2026-11-03T10:00:00.000Z'
/** @param {number} minute */
const minuteAt = minute => `2026-11-03T10:${String(minute).padStart(2, '0')}:00.000Z`

// @ref LLP 0572#spool-repair [tests]: v1.48.0 rows with a masked date drain, rebuilt from their conversation or dropped
test('a spooled row with a masked date is rebuilt from its conversation, or dropped when nothing can rebuild it', async t => {
  const cacheRoot = await tempCache(t)
  const storage = createQueryStorageService({ cacheRoot })
  const base = { client_name: 'claude', session_id: 'dated', conversation_started_at: started }
  // The preserve set keeps the mask verbatim in the spool, as v1.48.0 wrote it.
  await storage.appendRows(storage.cacheTablePath('messages', ['source=claude']), DATED, [
    { ...base, part_id: 'm1-a', message_id: 'm1', message_index: 0, message_created_at: minuteAt(1) },
    { ...base, part_id: 'm1-b', message_id: 'm1', message_index: 1, message_created_at: MASK },
    { ...base, part_id: 'm2', message_id: 'm2', message_index: 7, conversation_started_at: MASK, message_created_at: MASK },
    { ...base, part_id: 'm3', message_id: 'm3', message_index: 8, message_created_at: minuteAt(9) },
    { ...base, session_id: 'lonely', part_id: 'lost', message_id: 'x1', message_index: 0, conversation_started_at: MASK, message_created_at: MASK },
  ])
  const { records } = await withLogRecords(() => storage.flushAll({ force: true }))
  const rows = await committedRows(storage)
  const byPart = new Map(rows.map(row => [row.part_id, row]))
  const iso = (/** @type {unknown} */ value) => new Date(/** @type {any} */ (value)).toISOString()
  assert.deepEqual([...byPart.keys()].sort(), ['m1-a', 'm1-b', 'm2', 'm3'])
  // Same message first, then the nearest message in the conversation.
  assert.equal(iso(byPart.get('m1-b')?.message_created_at), minuteAt(1))
  assert.equal(iso(byPart.get('m2')?.message_created_at), minuteAt(9))
  assert.equal(iso(byPart.get('m2')?.conversation_started_at), started)
  assert.deepEqual(await Array.fromAsync(storage.readSpooledRows('messages')), [])
  const warn = records.find(record => record.body === 'cache.record_redaction_unstorable')
  assert.ok(warn)
  assert.equal(warn.attributes.reconstructed_count, 3)
  assert.equal(warn.attributes.dropped_count, 1)
  assert.equal(warn.attributes.nulled_count, undefined)
})

// @ref LLP 0572#spool-repair [tests]: a date is never nulled; other typed columns null when nullable, else drop
test('the masked-value repair never nulls a date and returns the same batch when nothing is masked', () => {
  /** @type {ColumnSpec[]} */
  const columns = [
    { name: 'session_id', type: 'STRING', nullable: true },
    { name: 'received_at', type: 'TIMESTAMP', nullable: true },
    { name: 'tokens', type: 'INT64', nullable: true },
    { name: 'turn', type: 'INT32', nullable: false },
  ]
  const clean = [{ session_id: 's', received_at: started, tokens: 3, turn: 1 }]
  assert.equal(repairMaskedTypedValues(columns, clean).rows, clean)
  const rows = [
    { session_id: 'alone', received_at: MASK, tokens: 1, turn: 1 },
    { session_id: 's', received_at: started, tokens: MASK, turn: 2 },
    { session_id: 's', received_at: started, tokens: 4, turn: MASK },
    { received_at: MASK, tokens: 5, turn: 3 },
  ]
  const result = repairMaskedTypedValues(columns, rows)
  assert.deepEqual(result.rows, [{ session_id: 's', received_at: started, tokens: null, turn: 2 }])
  assert.deepEqual([result.reconstructed, result.nulled, result.dropped], [0, 1, 3])
  assert.equal(rows[1].tokens, MASK, 'the caller keeps its own rows')
})
