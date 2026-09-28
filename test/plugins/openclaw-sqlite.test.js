// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { defaultOpenclawAgentsDir, listOpenclawSessions, readOpenclawSession } from '../../hypaware-core/plugins-workspace/openclaw/src/session_file.js'
import test from 'node:test'
import { createOpenclawBackfillProvider } from '../../hypaware-core/plugins-workspace/openclaw/src/backfill.js'
import { createOpenclawSettlementEnricher } from '../../hypaware-core/plugins-workspace/openclaw/src/settle.js'
import { wireMatchKey } from '../../hypaware-core/plugins-workspace/openclaw/src/match_key.js'
import { aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { USAGE_POLICY_DROP } from '../../src/core/usage-policy/index.js'

// These are the columns read from OpenClaw 2026.9.6's session_windows and
// transcript_events tables. Acceptance also exercises the published schema.
const schema = `
CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, updated_at INTEGER, transcript_updated_at INTEGER);
CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER, event_zstd BLOB, event_utf8_bytes INTEGER, PRIMARY KEY(session_id, seq));
CREATE TABLE session_transcript_cold_archives (session_id TEXT PRIMARY KEY, generation TEXT, archive_name TEXT, archive_sha256 TEXT, event_count INTEGER, raw_bytes INTEGER, archive_bytes INTEGER, last_seq INTEGER, archived_at INTEGER, storage TEXT, archive_blob BLOB);
`
const stamp = Date.now() - 600000
const content = [{ type: 'text', text: 'SQLite compatibility probe' }]
const records = [
  { type: 'session', version: 3, id: 'native-session', cwd: '/project', timestamp: new Date(stamp).toISOString() },
  { type: 'message', id: 'native-user', timestamp: new Date(stamp + 1000).toISOString(), message: { role: 'user', content, timestamp: stamp + 1000 } },
  { type: 'message', id: 'native-assistant', timestamp: new Date(stamp + 2000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }], provider: 'anthropic', api: 'anthropic-messages', model: 'test', usage: { input: 12, output: 3 } } },
]
async function stage(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-openclaw-sqlite-'))
  const agentsDir = path.join(root, 'agents')
  const dir = path.join(agentsDir, 'main', 'agent')
  await fs.mkdir(dir, { recursive: true })
  const dbPath = path.join(dir, 'openclaw-agent.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(schema)
  db.prepare('INSERT INTO session_windows VALUES (?, ?, ?)').run('native-session', stamp + 2000, stamp + 2000)
  for (const [seq, record] of records.entries()) db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL, NULL)').run('native-session', seq, JSON.stringify(record), stamp + seq * 1000)
  t.after(async () => {
    try { db.close() } catch {}
    await fs.rm(root, { recursive: true, force: true })
  })
  const events = []
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (event, attrs) => events.push({ level, event, attrs })]))
  const provider = createOpenclawBackfillProvider({ homeDir: root, agentsDir, config: { backfill: { quiesce_ms: 0 } } })
  const run = async (overrides = {}) => {
    const out = []
    for await (const item of provider.run({ env: {}, cacheRoot: root, storage: /** @type {any} */ ({}), dryRun: false, log: /** @type {any} */ (log), ...overrides })) out.push(item)
    return out.filter(x => x.type !== 'event')
  }
  const row = { session_id: 'fallback', client_name: 'openclaw', conversation_source: 'openclaw', message_id: 'fallback-msg', part_id: 'fallback-msg#0', role: 'user', message_index: 0, part_index: 0, cwd: null, message_created_at: new Date(stamp + 1000).toISOString(), attributes: { gateway: { identity_source: 'gateway_fallback' }, openclaw: { match_key: wireMatchKey('user', content) } } }
  const settle = async (ignore = false) => createOpenclawSettlementEnricher({ homeDir: root, agentsDir, logger: /** @type {any} */ (log), ...(ignore ? { resolver: /** @type {any} */ ({ resolve: () => ({ class: 'ignore' }) }) } : {}) }).settle([structuredClone(row)], /** @type {any} */ ({}))
  return { root, agentsDir, dbPath, db, events, log, provider, run, row, settle }
}
test('SQLite-only OpenClaw history projects and settles with native identity and policy', async t => {
  const e = await stage(t)
  assert.equal((await e.run()).length, 1)
  assert.equal((/** @type {any} */ ((await e.settle())[0])).session_id, 'native-session')
  assert.equal((await e.settle(true))[0], USAGE_POLICY_DROP)
})
test('SQLite compressed event payloads retain native identity', { skip: !zlib.zstdCompressSync }, async t => {
  const e = await stage(t)
  const bytes = Buffer.from(JSON.stringify(records[1]))
  e.db.prepare('UPDATE transcript_events SET event_json=NULL,event_zstd=?,event_utf8_bytes=? WHERE seq=1').run(zlib.zstdCompressSync(bytes), bytes.length)
  assert.equal((await e.run()).length, 1)
  assert.equal((/** @type {any} */ ((await e.settle())[0])).message_id, 'native-user')
})
test('SQLite owns a session also present in legacy JSONL', async t => {
  const e = await stage(t)
  const dir = path.join(e.agentsDir, 'main', 'sessions')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, 'native-session.jsonl'), records.map(x => JSON.stringify(x)).join('\n'))
  assert.equal((await e.run()).length, 1)
})
test('unreadable SQLite does not silently pass live rows or report successful empty history', async t => {
  const e = await stage(t)
  e.db.exec('DROP TABLE transcript_events')
  await assert.rejects(e.run())
  assert.equal((await e.settle())[0], USAGE_POLICY_DROP)
  assert.ok(e.events.some(x => x.level === 'warn'))
})

test('quiet period is per session and rechecked after enumeration', async t => {
  const e = await stage(t)
  const sources = []
  for await (const source of listOpenclawSessions(e.agentsDir)) sources.push(source)
  e.db.prepare('UPDATE session_windows SET transcript_updated_at=?').run(Date.now())
  assert.equal(await readOpenclawSession(sources[0], { quietBeforeMs: Date.now() - 180000 }), undefined)
  const provider = createOpenclawBackfillProvider({ homeDir: e.root, agentsDir: e.agentsDir })
  const out = []
  for await (const item of provider.run({ env: {}, cacheRoot: e.root, storage: /** @type {any} */ ({}), dryRun: false, log: /** @type {any} */ (e.log) })) out.push(item)
  assert.equal(out.length, 0)
  // Bookkeeping on the database is recent; the transcript itself is quiet.
  e.db.prepare('UPDATE session_windows SET updated_at=?, transcript_updated_at=?').run(Date.now(), stamp)
  for await (const item of provider.run({ env: {}, cacheRoot: e.root, storage: /** @type {any} */ ({}), dryRun: false, log: /** @type {any} */ (e.log) })) out.push(item)
  assert.equal(out.length, 1)
})
test('retention applies to SQLite message timestamps', async t => {
  const e = await stage(t)
  assert.equal((await e.run({ since: new Date(stamp + 100000).toISOString() })).length, 0)
})
test('SQLite WAL commits are visible without a checkpoint or gateway restart', async t => {
  const e = await stage(t)
  e.db.exec('PRAGMA journal_mode=WAL')
  e.db.prepare('UPDATE transcript_events SET event_json=? WHERE seq=1').run(JSON.stringify({ ...records[1], id: 'wal-user' }))
  assert.equal((/** @type {any} */ ((await e.settle())[0])).message_id, 'wal-user')
})
test('oversized or malformed compressed records fail visibly', async t => {
  const e = await stage(t)
  e.db.prepare('UPDATE transcript_events SET event_json=NULL,event_zstd=?,event_utf8_bytes=? WHERE seq=1').run(Buffer.from('invalid'), 4194305)
  await assert.rejects(e.run(), /invalid_or_oversized_event/)
  assert.equal((await e.settle())[0], USAGE_POLICY_DROP)
})
test('read failures preserve already native rows with their own policy context', async t => {
  const e = await stage(t)
  e.db.exec('DROP TABLE transcript_events')
  const row = { ...e.row, cwd: '/known', attributes: { gateway: { identity_source: 'native' } } }
  const enricher = createOpenclawSettlementEnricher({ homeDir: e.root, agentsDir: e.agentsDir, logger: /** @type {any} */ (e.log) })
  assert.deepEqual(await enricher.settle([row], /** @type {any} */ ({})), [row])
})
test('state directory override points discovery at the actual OpenClaw store', () => {
  assert.equal(defaultOpenclawAgentsDir({ OPENCLAW_STATE_DIR: '/state' }, '/home'), '/state/agents')
  assert.equal(defaultOpenclawAgentsDir({ OPENCLAW_STATE_DIR: '~/state' }, '/home'), '/home/state/agents')
})
for (const storage of ['sqlite', 'file']) {
  test(`verified ${storage} cold archives project without restoring the upstream database`, { skip: !zlib.zstdCompressSync }, async t => {
    const e = await stage(t)
    const events = records.map((r, seq) => ({ kind: 'event', row: { seq, event_json: JSON.stringify(r), created_at: stamp + seq * 1000 } }))
    const text = [{ kind: 'header', version: 1, sessionId: 'native-session', generation: 'test-generation' }, ...events].map(x => JSON.stringify(x)).join('\n') + '\n'
    const bytes = zlib.zstdCompressSync(Buffer.from(text))
    const digest = createHash('sha256').update(bytes).digest('hex')
    const name = digest + '.jsonl.zst'
    if (storage === 'file') {
      const dir = path.join(e.agentsDir, 'main', 'sessions', 'cold')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, name), bytes)
    }
    const rawBytes = events.reduce((sum, event) => sum + Buffer.byteLength(event.row.event_json), 0) + events.length - 1
    e.db.prepare('INSERT INTO session_transcript_cold_archives VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('native-session', 'test-generation', name, digest, 3, rawBytes, bytes.length, 2, Date.now(), storage, storage === 'sqlite' ? bytes : null)
    e.db.exec('DELETE FROM transcript_events')
    assert.equal((await e.run()).length, 1)
    assert.equal((/** @type {any} */ ((await e.settle())[0])).message_id, 'native-user')
    assert.equal(e.db.prepare('SELECT count(*) AS n FROM transcript_events').get()?.n, 0)
    e.db.prepare('UPDATE session_transcript_cold_archives SET archive_sha256=?').run('0'.repeat(64))
    await assert.rejects(e.run(), /archive_digest_mismatch/)
  })
}

test('actual OpenClaw 2026.9.6 CLI records preserve tools, usage, and message identity', async t => {
  const e = await stage(t)
  // Captured from a real local CLI turn against a mock provider, including a
  // real read-tool result. Only the temporary state path is sanitized.
  const actual = JSON.parse(await fs.readFile(new URL('../fixtures/openclaw/2026.9.6-transcript.json', import.meta.url), 'utf8'))
  e.db.exec('DELETE FROM transcript_events')
  actual[0].id = 'native-session'
  for (const [seq, record] of actual.entries()) e.db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL, NULL)').run('native-session', seq, JSON.stringify(record), stamp + seq)
  const sources = []
  for await (const source of listOpenclawSessions(e.agentsDir)) sources.push(source)
  const session = await readOpenclawSession(sources[0])
  assert.deepEqual(session?.messages.map(m => m.role), ['user', 'assistant', 'toolResult', 'assistant'])
  assert.equal(session?.messages[1].id, actual[2].id)
  assert.ok(session?.messages[3].usage)
  const items = await e.run()
  assert.equal(items.length, 1)
})
test('busy reads retry briefly, remain policy-safe, then recover after unlock', async t => {
  const e = await stage(t)
  e.db.exec('BEGIN EXCLUSIVE')
  const start = Date.now()
  assert.equal((await e.settle())[0], USAGE_POLICY_DROP)
  assert.ok(Date.now() - start >= 70)
  assert.ok(Date.now() - start < 2000)
  e.db.exec('ROLLBACK')
  assert.equal((await e.run()).length, 1)
  assert.equal((/** @type {any} */ ((await e.settle())[0])).message_id, 'native-user')
})
test('gateway flush drops only unsafe OpenClaw copies, while maintenance preserves committed history', async t => {
  const e = await stage(t)
  e.db.exec('DROP TABLE transcript_events')
  const state = createGatewayState()
  state.enrichers.set('openclaw', createOpenclawSettlementEnricher({ homeDir: e.root, agentsDir: e.agentsDir, logger: /** @type {any} */ (e.log) }))
  const dataset = aiGatewayDatasetRegistration(state)
  const other = { ...e.row, client_name: 'other-client', session_id: 'other-session', message_id: 'other', part_id: 'other#0' }
  const storage = { async discoverCachePartitions() { return [] }, async *readRows() {} }
  const ctx = /** @type {any} */ ({ storage })
  assert.deepEqual(await dataset.settleBatch?.([e.row, other], ctx), [other])
  assert.deepEqual(await dataset.resettleBatch?.([e.row, other], ctx), [e.row, other])
})

test('empty session windows are not read failures and discovery crosses metadata pages', async t => {
  const e = await stage(t)
  const add = e.db.prepare('INSERT INTO session_windows VALUES (?, ?, ?)')
  for (let i = 0; i < 260; i++) add.run(`empty-${i}`, stamp, stamp)
  const sources = []
  for await (const source of listOpenclawSessions(e.agentsDir)) sources.push(source)
  assert.equal(sources.length, 261)
  assert.equal((await e.run()).length, 1)
})
test('real directory ignore prevents parsing an ignored SQLite payload', async t => {
  const e = await stage(t)
  const cwd = path.join(e.root, 'ignored')
  await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, '.hypignore'), 'ignore\n')
  e.db.prepare('UPDATE transcript_events SET event_json=? WHERE seq=0').run(JSON.stringify({ ...records[0], cwd }))
  e.db.prepare('UPDATE transcript_events SET event_json=? WHERE seq=1').run('invalid JSON')
  assert.equal((await e.run()).length, 0)
  assert.ok(e.events.some(x => x.event === 'openclaw.backfill.usage_policy_drop'))
})
test('reset windows and independent agents retain distinct native sessions', async t => {
  const e = await stage(t)
  e.db.prepare('INSERT INTO session_windows VALUES (?, ?, ?)').run('reset-session', stamp, stamp)
  const write = e.db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL, NULL)')
  for (const [seq, record] of records.entries()) write.run('reset-session', seq, JSON.stringify({ ...record, id: seq === 0 ? 'reset-session' : 'reset-' + record.id }), stamp + seq)
  const dir = path.join(e.agentsDir, 'other', 'agent')
  await fs.mkdir(dir, { recursive: true })
  await fs.copyFile(e.dbPath, path.join(dir, 'openclaw-agent.sqlite'))
  const sources = []
  for await (const source of listOpenclawSessions(e.agentsDir)) sources.push(source)
  assert.deepEqual(sources.map(x => [x.agentId, x.sessionId]), [['main','native-session'], ['main','reset-session'], ['other','native-session'], ['other','reset-session']])
  assert.equal((await e.run()).length, 4)
})

// An OpenClaw install accumulates sessions, so both lanes routinely meet a
// window they cannot read: settlement scans the 32 newest whatever the batch
// is about, and the sweep walks every one of them in session_id order. A
// single such window must cost only itself.
test('one unreadable window costs only itself, not the flush batch or the rest of the sweep', async t => {
  const e = await stage(t)
  // Sorts before `native-session`, so discovery reaches it first.
  e.db.prepare('INSERT INTO session_windows VALUES (?, ?, ?)').run('aaa-broken', stamp + 2000, stamp + 2000)
  e.db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL, NULL)').run('aaa-broken', 0, JSON.stringify(records[1]), stamp)

  // Settlement binds the group to the candidate that actually claims its
  // content instead of dropping the row over an unrelated neighbour.
  assert.equal((/** @type {any} */ ((await e.settle())[0])).session_id, 'native-session')

  // The sweep still fails visibly (LLP 0444#failure-policy), but only after
  // the readable sessions have been yielded: otherwise the recovery import
  // the settlement drop is paid for by could never reach them.
  const items = []
  await assert.rejects(async () => {
    for await (const item of e.provider.run({ env: {}, cacheRoot: e.root, storage: /** @type {any} */ ({}), dryRun: false, log: /** @type {any} */ (e.log) })) {
      if (item.type !== 'event') items.push(item)
    }
  }, /session_header_missing_or_mismatched/)
  assert.equal(items.length, 1)
  assert.ok(e.events.some(x => x.event === 'openclaw.backfill.session_read_failed' && x.attrs?.session_id === 'aaa-broken'))
  assert.ok(e.events.some(x => x.event === 'openclaw.backfill.scan_complete' && x.attrs?.sessions_failed === 1))
})

test('a discovery failure leaves rows this pass never settles alone', async t => {
  const e = await stage(t)
  e.db.exec('DROP TABLE session_windows')
  // No `session_id` means the row never entered `bySession`, so the healthy
  // path never touches it and the failure path must not remove it either.
  const orphan = { ...e.row, session_id: null }
  const out = await createOpenclawSettlementEnricher({ homeDir: e.root, agentsDir: e.agentsDir, logger: /** @type {any} */ (e.log) })
    .settle([structuredClone(e.row), orphan], /** @type {any} */ ({}))
  assert.equal(out[0], USAGE_POLICY_DROP)
  assert.deepEqual(out[1], orphan)
})

// LLP 0444#failure-policy carves out "a healthy scan with no content match",
// and a group with no match key at all is exactly that: it reads no candidate,
// so no storage failure ever prevented settling it. Only a group that actually
// met the unreadable window pays the sentinel.
test('a group with no match key keeps its fallback when an unrelated window is unreadable', async t => {
  const e = await stage(t)
  e.db.prepare('INSERT INTO session_windows VALUES (?, ?, ?)').run('aaa-broken', stamp + 2000, stamp + 2000)
  e.db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL, NULL)').run('aaa-broken', 0, JSON.stringify(records[1]), stamp)

  // Distinct `session_id`s, so each is its own group and the keyed one runs
  // first and records the failure the keyless one must not inherit.
  const keyed = { ...e.row, session_id: 'keyed', attributes: { gateway: { identity_source: 'gateway_fallback' }, openclaw: { match_key: wireMatchKey('user', [{ type: 'text', text: 'matches no transcript' }]) } } }
  const keyless = { ...e.row, session_id: 'keyless', attributes: { gateway: { identity_source: 'gateway_fallback' } } }
  const out = await createOpenclawSettlementEnricher({ homeDir: e.root, agentsDir: e.agentsDir, logger: /** @type {any} */ (e.log) })
    .settle([keyed, keyless], /** @type {any} */ ({}))
  assert.equal(out[0], USAGE_POLICY_DROP)
  assert.deepEqual(out[1], keyless)
})
