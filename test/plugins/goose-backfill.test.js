// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createGooseBackfillProvider, GOOSE_SWEEP_CRON } from '../../hypaware-core/plugins-workspace/goose/src/backfill.js'
import { readGooseWatermark } from '../../hypaware-core/plugins-workspace/goose/src/watermark.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { sessionIgnoresDir } from '../../src/core/runtime/paths.js'
import { runBackfillProvider } from '../../src/core/commands/backfill.js'
import { createBackfillMaterializerRegistry, createBackfillRegistry } from '../../src/core/registry/backfills.js'
import { AI_GATEWAY_MESSAGE_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @ref LLP 0570#backfill [tests]: the `updated_at` window, the unset window,
 *   reconcile-not-append on a re-run, and the sweep contribution following
 *   `on_join`, through the real kernel runner and materializer.
 * @ref LLP 0570#reconciliation [tests]: the sweep's digest catches an
 *   in-place edit and a bare truncation, skips an unchanged session, and
 *   prunes the entry of a deleted one.
 * @ref LLP 0570#privacy [tests]: an exclusion is skipped and not pruned, an
 *   unreadable exclusions store fails closed, and a usage-policy ignore
 *   reconciles the session to no rows.
 *
 * The fixture is a reduced copy of the Goose v1.57.0 schema v17, synthetic
 * rows only.
 */

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

let clock = 0
/** A strictly increasing `updated_at` in Goose's `YYYY-MM-DD HH:MM:SS` form. */
function nextTimestamp() {
  clock += 1
  return new Date(Date.UTC(2026, 10, 2, 22, 0, 0) + clock * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * @param {string} dbPath
 * @returns {DatabaseSync}
 */
function createFixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      session_type TEXT NOT NULL DEFAULT 'user',
      working_dir TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      provider_name TEXT,
      model_config_json TEXT,
      parent_session_id TEXT
    )
  `)
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT
  )`)
  return db
}

/**
 * One session holding one exchange.
 *
 * @param {DatabaseSync} db
 * @param {{ id: string, workingDir: string }} opts
 */
function insertExchange(db, opts) {
  const at = nextTimestamp()
  db.prepare(`INSERT INTO sessions (id, name, session_type, working_dir, created_at, updated_at, provider_name, model_config_json)
    VALUES (?, 'Fixture session', 'user', ?, ?, ?, 'openai', '{"model_name":"fixture-model"}')`)
    .run(opts.id, opts.workingDir, at, at)
  for (const [role, text] of [['user', 'fixture prompt'], ['assistant', 'fixture reply']]) {
    db.prepare(`INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json)
      VALUES (NULL, ?, ?, ?, ?, '{"userVisible":true,"agentVisible":true}')`)
      .run(opts.id, role, JSON.stringify([{ type: 'text', text }]), 1793744391 + clock)
  }
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nextTimestamp(), opts.id)
}

/**
 * A fixture `sessions.db`, a fake reconciling storage, and the goose
 * provider staged in the real backfill registries.
 *
 * @param {{ config?: Record<string, unknown>, ignoredSessions?: (dir: string) => SessionIgnoreSet,
 *   busy?: (sessionId: string) => boolean }} [opts]
 */
async function stage(opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goose-backfill-'))
  const workingDir = path.join(dir, 'work')
  await fs.mkdir(workingDir)
  const sessionsDb = path.join(dir, 'sessions.db')
  const db = createFixtureDb(sessionsDb)

  /** @type {Record<string, unknown>[]} */
  const committed = []
  let appends = 0
  let claims = 0
  const storage = {
    cacheRoot: path.join(dir, 'cache'),
    /** @param {string} dataset @param {string[]} segs */
    cacheTablePath: (dataset, segs) => path.join(dir, 'cache', dataset, ...segs),
    /** @param {string} _table @param {unknown} _columns @param {Record<string, unknown>[]} rows */
    async appendRows(_table, _columns, rows) { appends += 1; committed.push(...rows) },
    /**
     * @param {string} _dataset @param {unknown} _columns @param {Record<string, unknown>[]} rows
     * @param {{ where: Record<string, unknown> }} scope
     */
    async reconcileRows(_dataset, _columns, rows, scope) {
      for (let i = committed.length - 1; i >= 0; i--) {
        if (Object.entries(scope.where).every(([key, value]) => committed[i][key] === value)) committed.splice(i, 1)
      }
      committed.push(...rows)
      return rows.length
    },
    /** @param {string} _dataset @param {Record<string, string>} where */
    claimReconcileScope(_dataset, where) {
      claims += 1
      if (opts.busy?.(where.session_id)) {
        throw Object.assign(new Error('scope busy'), { error_kind: 'cache_partition_mutation_busy' })
      }
      return () => {}
    },
    async flushTable() {},
  }

  const ignoredSessions = opts.ignoredSessions?.(dir)
  const provider = createGooseBackfillProvider({
    sessionsDbPath: sessionsDb,
    stateDir: dir,
    ...(opts.config ? { config: /** @type {any} */ (opts.config) } : {}),
    ...(ignoredSessions ? { ignoredSessions } : {}),
    localOnlyListPath: path.join(dir, 'local-only.json'),
  })
  const backfills = createBackfillRegistry()
  backfills.register(provider)
  const materializers = createBackfillMaterializerRegistry()
  materializers.register(aiGatewayBackfillMaterializer())
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: dir },
    config: {},
    stdout: { write: () => true },
    stderr: { write: () => true },
    backfills,
    backfillMaterializers: materializers,
    query: {
      /** @param {string} name */
      getDataset(name) {
        if (name !== 'ai_gateway_messages') return undefined
        return { name, plugin: '@hypaware/ai-gateway', schema: { columns: AI_GATEWAY_MESSAGE_COLUMNS } }
      },
      registerDataset() {},
      listDatasets() { return [] },
    },
    storage,
  })

  /** @type {Array<{ message: string, fields?: Record<string, unknown> }>} */
  const logs = []
  const log = {
    /** @param {string} message @param {Record<string, unknown>} [fields] */
    debug(message, fields) { logs.push({ message, fields }) },
    /** @param {string} message @param {Record<string, unknown>} [fields] */
    info(message, fields) { logs.push({ message, fields }) },
    /** @param {string} message @param {Record<string, unknown>} [fields] */
    warn(message, fields) { logs.push({ message, fields }) },
    /** @param {string} message @param {Record<string, unknown>} [fields] */
    error(message, fields) { logs.push({ message, fields }) },
  }

  return {
    dir,
    workingDir,
    sessionsDb,
    db,
    provider,
    committed,
    get appends() { return appends },
    get claims() { return claims },
    logs,
    /** @param {{ sweep?: boolean, dryRun?: boolean, since?: string, until?: string }} [args] */
    run: (args = {}) => runBackfillProvider({ ctx, provider: 'goose', dryRun: args.dryRun ?? false, ...args }),
    /**
     * Drive the provider directly, so its own log records and error_kind
     * are visible (the runner logs through its own logger).
     *
     * @param {{ sweep?: boolean, dryRun?: boolean, since?: string, signal?: AbortSignal }} [args]
     * @param {unknown[]} [items]
     */
    async direct(args = {}, items = []) {
      const runCtx = /** @type {any} */ ({ env: ctx.env, storage, cacheRoot: storage.cacheRoot, dryRun: false, itemsFailed: 0, log, ...args })
      for await (const item of provider.run(runCtx)) items.push(item)
      return items
    },
  }
}

/** @param {Record<string, unknown>[]} rows @param {string} sessionId */
function rowsFor(rows, sessionId) {
  return rows.filter(row => row.session_id === `goose-${sessionId}`)
}

/** @param {Array<{ message: string, fields?: Record<string, unknown> }>} logs */
function scanComplete(logs) {
  const entry = logs.find(record => record.message === 'goose.backfill.scan_complete')
  assert.ok(entry, 'scan_complete logged')
  return /** @type {Record<string, unknown>} */ (entry.fields)
}

test('goose backfill: the sweep contribution follows on_join', () => {
  const on = createGooseBackfillProvider({ sessionsDbPath: '/nonexistent', stateDir: '/nonexistent' })
  assert.equal(on.name, 'goose')
  assert.equal(on.plugin, '@hypaware/goose')
  assert.deepEqual(on.datasets, ['ai_gateway_messages'])
  assert.deepEqual(on.sweep, { cron: GOOSE_SWEEP_CRON })

  const off = createGooseBackfillProvider({
    sessionsDbPath: '/nonexistent',
    stateDir: '/nonexistent',
    config: { backfill: { on_join: false } },
  })
  assert.equal(off.sweep, undefined)
})

test('goose backfill: an unset window imports every session, and a re-run reconciles rather than appends', async () => {
  const h = await stage()
  insertExchange(h.db, { id: 's1', workingDir: h.workingDir })
  insertExchange(h.db, { id: 's2', workingDir: h.workingDir })

  const first = await h.run()
  assert.equal(first.ok, true)
  assert.equal(first.scanned, 2)
  const s1Rows = rowsFor(h.committed, 's1').length
  assert.ok(s1Rows > 0)
  assert.ok(rowsFor(h.committed, 's2').length > 0)
  const total = h.committed.length

  const second = await h.run()
  assert.equal(second.ok, true)
  assert.equal(h.committed.length, total, 'a re-run replaces each session scope')
  assert.equal(rowsFor(h.committed, 's1').length, s1Rows)
  assert.equal(h.appends, 0, 'every item reconciles its scope')
})

test('goose backfill: the window filters on the session updated_at', async () => {
  const h = await stage()
  insertExchange(h.db, { id: 'recent', workingDir: h.workingDir })
  insertExchange(h.db, { id: 'old', workingDir: h.workingDir })
  h.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-01-01 00:00:00', 'old')

  const result = await h.run({ since: '2026-11-01T00:00:00.000Z' })
  assert.equal(result.ok, true)
  assert.equal(result.scanned, 1)
  assert.ok(rowsFor(h.committed, 'recent').length > 0)
  assert.equal(rowsFor(h.committed, 'old').length, 0)

  await h.direct({ since: '2026-11-01T00:00:00.000Z' })
  assert.equal(scanComplete(h.logs).sessions_skipped_window, 1)

  const until = await stage()
  insertExchange(until.db, { id: 'recent', workingDir: until.workingDir })
  insertExchange(until.db, { id: 'old', workingDir: until.workingDir })
  until.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-01-01 00:00:00', 'old')
  await until.run({ until: '2026-02-01T00:00:00.000Z' })
  assert.ok(rowsFor(until.committed, 'old').length > 0)
  assert.equal(rowsFor(until.committed, 'recent').length, 0)
})

test('goose backfill: the sweep catches an in-place edit and a truncation, and skips an unchanged session', async () => {
  const h = await stage()
  insertExchange(h.db, { id: 's1', workingDir: h.workingDir })
  insertExchange(h.db, { id: 's2', workingDir: h.workingDir })

  assert.equal((await h.run({ sweep: true })).ok, true)
  const marks = readGooseWatermark(h.dir).sessions
  assert.ok(marks.s1 && marks.s2, 'a sweep records each session it settled')

  // An in-place edit Goose makes without moving updated_at.
  h.db.prepare("UPDATE messages SET content_json = ? WHERE session_id = 's1' AND role = 'assistant'")
    .run(JSON.stringify([{ type: 'text', text: 'edited fixture reply' }]))
  await h.run({ sweep: true })
  assert.match(JSON.stringify(rowsFor(h.committed, 's1')), /edited fixture reply/)
  const before = rowsFor(h.committed, 's1').length

  // A bare truncation: the last message goes, updated_at does not move.
  h.db.prepare("DELETE FROM messages WHERE session_id = 's1' AND role = 'assistant'").run()
  await h.run({ sweep: true })
  assert.ok(rowsFor(h.committed, 's1').length < before, 'the truncated rows are removed')
  assert.doesNotMatch(JSON.stringify(rowsFor(h.committed, 's1')), /edited fixture reply/)

  // The scan counts: only the edited session is projected again. Driven
  // directly for its log fields, which settles the mark without a write, so
  // it comes after the write assertions above.
  h.db.prepare("UPDATE messages SET content_json = ? WHERE session_id = 's2' AND role = 'assistant'")
    .run(JSON.stringify([{ type: 'text', text: 'second edit' }]))
  h.logs.length = 0
  const items = await h.direct({ sweep: true })
  let fields = scanComplete(h.logs)
  assert.equal(fields.sessions_projected, 1)
  assert.equal(fields.sessions_unchanged, 1)
  assert.equal(fields.status, 'ok')
  assert.match(JSON.stringify(items), /second edit/)

  h.logs.length = 0
  await h.direct({ sweep: true })
  fields = scanComplete(h.logs)
  assert.equal(fields.sessions_projected, 0)
  assert.equal(fields.sessions_unchanged, 2)
})

test('goose backfill: a deleted session loses its watermark entry', async () => {
  const h = await stage()
  insertExchange(h.db, { id: 's1', workingDir: h.workingDir })
  insertExchange(h.db, { id: 's2', workingDir: h.workingDir })
  await h.run({ sweep: true })

  h.db.prepare("DELETE FROM messages WHERE session_id = 's2'").run()
  h.db.prepare("DELETE FROM sessions WHERE id = 's2'").run()
  await h.direct({ sweep: true })
  assert.equal(scanComplete(h.logs).entries_pruned, 1)
  const marks = readGooseWatermark(h.dir).sessions
  assert.ok(marks.s1)
  assert.equal(marks.s2, undefined)
})

test('goose backfill: an excluded session is skipped and keeps its watermark entry', async () => {
  const h = await stage({ ignoredSessions: dir => new SessionIgnoreSet(dir) })
  insertExchange(h.db, { id: 's1', workingDir: h.workingDir })
  insertExchange(h.db, { id: 's2', workingDir: h.workingDir })
  await h.run({ sweep: true })
  const mark = readGooseWatermark(h.dir).sessions.s1
  assert.ok(mark)

  new SessionIgnoreSet(h.dir).add('s1')
  h.db.prepare("UPDATE messages SET content_json = ? WHERE session_id = 's1' AND role = 'assistant'")
    .run(JSON.stringify([{ type: 'text', text: 'edited while excluded' }]))
  await h.direct({ sweep: true })
  const fields = scanComplete(h.logs)
  assert.equal(fields.sessions_excluded, 1)
  assert.equal(fields.entries_pruned, 0)
  assert.deepEqual(readGooseWatermark(h.dir).sessions.s1, mark, 'the entry does not advance while excluded')
  assert.doesNotMatch(JSON.stringify(h.committed), /edited while excluded/)
})

test('goose backfill: unreadable exclusions fail the run closed', async () => {
  const h = await stage({ ignoredSessions: dir => new SessionIgnoreSet(dir) })
  insertExchange(h.db, { id: 's1', workingDir: h.workingDir })
  await fs.mkdir(sessionIgnoresDir(h.dir), { recursive: true })
  await fs.writeFile(path.join(sessionIgnoresDir(h.dir), 'not-a-marker'), 'x')

  await assert.rejects(h.direct(), /** @param {any} err */ err => err.error_kind === 'session_ignore_load_failed')
  const result = await h.run()
  assert.equal(result.ok, false)
  assert.equal(h.committed.length, 0, 'nothing is projected')
})

test('goose backfill: a usage-policy ignore reconciles the session to no rows', async () => {
  const h = await stage()
  insertExchange(h.db, { id: 's1', workingDir: h.workingDir })
  await h.run()
  assert.ok(rowsFor(h.committed, 's1').length > 0)

  await fs.writeFile(path.join(h.workingDir, '.hypignore'), 'ignore\n')
  const result = await h.run()
  assert.equal(result.ok, true)
  assert.equal(rowsFor(h.committed, 's1').length, 0, 'rows captured before the ignore are removed')
  await h.direct()
  assert.equal(scanComplete(h.logs).sessions_skipped_policy, 1)
})

test('goose backfill: a briefly busy session is retried and imported', async () => {
  let busyFor = 3
  const h = await stage({ busy: () => busyFor-- > 0 })
  insertExchange(h.db, { id: 's1', workingDir: h.workingDir })
  const result = await h.run()
  assert.equal(result.ok, true)
  assert.ok(rowsFor(h.committed, 's1').length > 0)
  assert.equal(h.claims, 4)
})

test('goose backfill: a session that stays busy fails the run after the rest is imported', async () => {
  const h = await stage({ busy: sessionId => sessionId === 'goose-held' })
  insertExchange(h.db, { id: 'free', workingDir: h.workingDir })
  insertExchange(h.db, { id: 'held', workingDir: h.workingDir })
  const controller = new AbortController()
  // Abort once the held session has been retried a few times, so the test
  // does not wait out the whole retry budget; the run still reports it busy.
  const timer = setTimeout(() => controller.abort(), 250)
  /** @type {unknown[]} */
  const items = []
  try {
    await assert.rejects(h.direct({ signal: controller.signal }, items),
      /** @param {any} err */ err => err.error_kind === 'cache_partition_mutation_busy')
  } finally {
    clearTimeout(timer)
  }
  assert.equal(items.length, 1, 'the free session is still imported')
  assert.ok(h.claims > 2, 'the held session is retried')
  const fields = scanComplete(h.logs)
  assert.equal(fields.sessions_busy, 1)
  assert.equal(fields.status, 'partial')
})

test('goose backfill: a missing sessions.db is a no-op', async () => {
  const h = await stage()
  h.db.close()
  await fs.rm(h.sessionsDb)
  const items = await h.direct({ sweep: true })
  assert.deepEqual(items, [])
  assert.ok(h.logs.some(record => record.message === 'goose.backfill.no_store'))
  const result = await h.run({ sweep: true })
  assert.equal(result.ok, true)
  assert.equal(result.scanned, 0)
})

test('goose backfill: a dry run takes no scope guard and writes no watermark', async () => {
  const h = await stage()
  insertExchange(h.db, { id: 's1', workingDir: h.workingDir })
  const result = await h.run({ sweep: true, dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.scanned, 1)
  assert.equal(h.claims, 0)
  assert.equal(h.committed.length, 0)
  assert.deepEqual(readGooseWatermark(h.dir).sessions, {})
})
