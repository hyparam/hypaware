// @ts-check

/**
 * Issue #2277: a Hermes writer's authoritative read and its reconcile commit
 * are one guarded step per session scope, so a snapshot read before a rewind
 * can never commit after the rewind's own reconcile and leave withdrawn rows
 * in the cache with a watermark that never looks again.
 *
 * The race tests run the poll tick and the backfill in separate OS processes
 * against one real SQLite store and one real Iceberg cache root, ordered with
 * barrier files: a writer pauses inside its reconcile (guard held, snapshot
 * taken) until the parent has rewound the store.
 *
 * @ref LLP 0449#read-commit-guard [tests]: read, fingerprint and commit share one cross-process guard.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { isPartitionMutationBusy } from '../../src/core/util/mutation_guard.js'
import { AI_GATEWAY_MESSAGES_DATASET } from '../../src/core/backfill/scan_util.js'
import { HERMES_CLIENT_NAME, hermesReconcileScope } from '../../hypaware-core/plugins-workspace/hermes/src/projector.js'
import { openHermesStateDb } from '../../hypaware-core/plugins-workspace/hermes/src/state_db.js'

/** @import { TestContext } from 'node:test' */

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const url = (/** @type {string} */ rel) => new URL(rel, import.meta.url).href
const MODULES = {
  storage: url('../../src/core/cache/storage.js'),
  scanUtil: url('../../src/core/backfill/scan_util.js'),
  source: url('../../hypaware-core/plugins-workspace/hermes/src/source.js'),
  backfill: url('../../hypaware-core/plugins-workspace/hermes/src/backfill.js'),
  dataset: url('../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'),
  columns: url('../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'),
}

/**
 * One writer process. `role` is `poll` (run `ticks` poll ticks) or
 * `backfill` (run the provider the way the kernel runner does: materialize
 * and reconcile each item before resuming the generator). `pauseFile` makes
 * the first reconcile announce itself and wait for `resumeFile`; `busyFile`
 * is written the first time a scope claim reports busy.
 */
const CHILD = `
import fs from 'node:fs'
const args = JSON.parse(process.argv[1])
const m = args.modules
const { createQueryStorageService } = await import(m.storage)
const { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } = await import(m.scanUtil)
const { aiGatewayBackfillMaterializer } = await import(m.dataset)
const { AI_GATEWAY_MESSAGE_COLUMNS } = await import(m.columns)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const events = []
const log = { debug() {}, info(name, attrs) { events.push({ name, ...attrs }) },
  warn(name, attrs) { events.push({ name, ...attrs }) }, error(name, attrs) { events.push({ name, ...attrs }) } }
const storage = createQueryStorageService({ cacheRoot: args.cacheRoot })
let paused = false
const pauseOnce = async () => {
  if (args.pauseFile && !paused) {
    paused = true
    fs.writeFileSync(args.pauseFile, '')
    while (!fs.existsSync(args.resumeFile)) await sleep(5)
  }
}
// The poll commits through the batch call, the backfill through the single
// one: pause whichever this process reaches first, between read and commit.
const reconcile = storage.reconcileRows
storage.reconcileRows = async (...call) => { await pauseOnce(); return reconcile(...call) }
const reconcileBatch = storage.reconcileRowsBatch
storage.reconcileRowsBatch = async (...call) => { await pauseOnce(); return reconcileBatch(...call) }
const claim = storage.claimReconcileScope
let busy = 0
storage.claimReconcileScope = (...call) => {
  try { return claim(...call) } catch (err) {
    if (++busy === 1 && args.busyFile) fs.writeFileSync(args.busyFile, '')
    throw err
  }
}
const out = { busy, events }
const started = performance.now()
if (args.role === 'poll') {
  const { createHermesPollRunner, runHermesPollTick } = await import(m.source)
  const materializers = new Map([[PROJECTED_EXCHANGE_KIND, aiGatewayBackfillMaterializer()]])
  const ctx = { config: { state_db: args.dbPath }, env: {}, log, storage,
    paths: { rootDir: args.stateDir, stateDir: args.stateDir, cacheDir: args.stateDir, tempDir: args.stateDir },
    query: { getDataset: name => name === AI_GATEWAY_MESSAGES_DATASET
      ? { name, plugin: '@hypaware/ai-gateway', schema: { columns: AI_GATEWAY_MESSAGE_COLUMNS } } : undefined },
    backfillMaterializers: { get: kind => materializers.get(kind) } }
  const runner = createHermesPollRunner(ctx)
  for (let i = 0; i < (args.ticks ?? 1); i++) await runHermesPollTick(runner, ctx)
  runner.db?.close()
  Object.assign(out, { lastError: runner.lastError ?? null, rowsWritten: runner.rowsWritten })
} else {
  const { createHermesBackfillProvider } = await import(m.backfill)
  const provider = createHermesBackfillProvider({ stateDbPath: args.dbPath, homeDir: args.stateDir })
  const runCtx = { storage, env: {}, log, dryRun: false, since: args.since }
  const materializer = aiGatewayBackfillMaterializer()
  try {
    for await (const item of provider.run(runCtx)) {
      if (!('kind' in item)) continue
      const rows = await materializer.materialize(item, { storage, log, env: {} })
      await storage.reconcileRows(item.dataset, [...AI_GATEWAY_MESSAGE_COLUMNS], rows, item.reconcile)
    }
    out.error = null
  } catch (err) {
    out.error = String(err?.message ?? err)
    out.error_kind = err?.error_kind ?? null
  }
}
out.busy = busy
out.ms = performance.now() - started
process.stdout.write(JSON.stringify(out) + '\\n')
`

/**
 * @param {Record<string, unknown>} args
 * @returns {{ done: Promise<any>, pid: number | undefined }}
 */
function runWriter(args) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, JSON.stringify({ ...args, modules: MODULES })],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`writer timed out: ${stderr}`)) }, 60_000)
    child.on('exit', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`writer exited ${code}: ${stderr}`))
      resolve(JSON.parse(stdout.trim().split('\n').pop() ?? '{}'))
    })
  })
  return { done, pid: child.pid }
}

/** @param {string} file @param {Promise<unknown>} [writer] fails fast if the writer exits first */
async function waitForFile(file, writer) {
  let exited = false
  writer?.then(() => { exited = true }, () => { exited = true })
  const deadline = Date.now() + 30_000
  while (!fs.existsSync(file)) {
    if (exited) throw new Error(`writer exited before ${path.basename(file)}`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path.basename(file)}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** @param {string} dbPath */
function createStore(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, cwd TEXT,
      parent_session_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT,
      billing_provider TEXT, billing_base_url TEXT, system_prompt TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, reasoning TEXT,
      timestamp TEXT NOT NULL, token_count INTEGER, finish_reason TEXT,
      active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0);
  `)
  return db
}

/** @param {DatabaseSync} db @param {string} id @param {string} startedAt */
function insertSession(db, id, startedAt = '2026-07-20T10:00:00Z') {
  db.prepare(`INSERT INTO sessions (id, source, model, cwd, started_at, billing_provider, billing_base_url)
    VALUES (?, 'cli', 'gpt-4o', '/home/dev/project', ?, 'openai', 'https://api.openai.com/v1')`).run(id, startedAt)
}

/** @param {DatabaseSync} db @param {number} id @param {string} sessionId @param {string} role @param {string} content */
function insertMessage(db, id, sessionId, role, content) {
  db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp)
    VALUES (?, ?, ?, ?, '2026-07-20T10:00:01Z')`).run(id, sessionId, role, content)
}

/** A rewind: the message leaves the visible transcript without any new ID. */
function rewind(/** @type {DatabaseSync} */ db, /** @type {number} */ id) {
  db.prepare('UPDATE messages SET active = 0, compacted = 0 WHERE id = ?').run(id)
}

/** @param {string} cacheRoot */
async function cachedTexts(cacheRoot) {
  const storage = createQueryStorageService({ cacheRoot })
  /** @type {string[]} */
  const texts = []
  for (const part of await storage.discoverCachePartitions()) {
    for await (const row of storage.readRows(part.path)) texts.push(String(row.content_text))
  }
  return texts.sort()
}

/** @param {TestContext} t */
async function fixture(t, label = 'guard') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `hermes-${label}-`))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'state.db')
  const db = createStore(dbPath)
  t.after(() => db.close())
  const pollDir = path.join(dir, 'poll')
  await fsp.mkdir(pollDir)
  const common = { dbPath, cacheRoot: path.join(dir, 'cache') }
  return { dir, db, common, pollArgs: { ...common, role: 'poll', stateDir: pollDir },
    backfillArgs: { ...common, role: 'backfill', stateDir: path.join(dir, 'home') },
    barrier: (/** @type {string} */ name) => path.join(dir, name) }
}

const deferredCount = (/** @type {any} */ out) => out.events.filter((/** @type {any} */ e) => e.name === 'hermes.session_deferred').length

test('a backfill snapshot read before a rewind cannot land after it (backfill first, separate processes)', async t => {
  const { db, common, pollArgs, backfillArgs, barrier } = await fixture(t)
  insertSession(db, 's1')
  insertMessage(db, 1, 's1', 'user', 'question')
  insertMessage(db, 2, 's1', 'assistant', 'withdrawn answer')
  let poll = await runWriter(pollArgs).done
  assert.equal(poll.lastError, null)
  assert.deepEqual(await cachedTexts(common.cacheRoot), ['question', 'withdrawn answer'])

  // The backfill reads the pre-rewind view and pauses inside its reconcile,
  // holding the session's guard.
  const backfill = runWriter({ ...backfillArgs, pauseFile: barrier('bf.paused'), resumeFile: barrier('bf.resume') })
  await waitForFile(barrier('bf.paused'), backfill.done)
  rewind(db, 2)

  // The poll sees the rewind but the scope is held: it defers without
  // touching the watermark, rather than committing the newer view first.
  poll = await runWriter(pollArgs).done
  assert.equal(poll.lastError, null)
  assert.equal(deferredCount(poll), 1, 'the poll defers the held session')
  assert.equal(poll.rowsWritten, 0)

  fs.writeFileSync(barrier('bf.resume'), '')
  const done = await backfill.done
  assert.equal(done.error, null)
  assert.deepEqual(await cachedTexts(common.cacheRoot), ['question', 'withdrawn answer'],
    'the stale backfill committed first, inside its guard')

  // Its stale view did not land after the rewind's reconcile: the poll's
  // unadvanced watermark brings the rewind back and it commits last.
  poll = await runWriter(pollArgs).done
  assert.equal(poll.lastError, null)
  assert.equal(deferredCount(poll), 0)
  assert.deepEqual(await cachedTexts(common.cacheRoot), ['question'])

  poll = await runWriter(pollArgs).done
  assert.equal(poll.rowsWritten, 0, 'converged: the watermark names the committed view')
  assert.deepEqual(await cachedTexts(common.cacheRoot), ['question'])
})

test('a poll snapshot read before a rewind commits before the backfill reads the rewind (poll first, separate processes)', async t => {
  const { db, common, pollArgs, backfillArgs, barrier } = await fixture(t)
  insertSession(db, 's1')
  insertMessage(db, 1, 's1', 'user', 'question')
  insertMessage(db, 2, 's1', 'assistant', 'withdrawn answer')

  const poll = runWriter({ ...pollArgs, pauseFile: barrier('poll.paused'), resumeFile: barrier('poll.resume') })
  await waitForFile(barrier('poll.paused'), poll.done)
  rewind(db, 2)

  // The backfill finds the scope held and waits (bounded) instead of reading.
  const backfill = runWriter({ ...backfillArgs, busyFile: barrier('bf.busy') })
  await waitForFile(barrier('bf.busy'), backfill.done)
  fs.writeFileSync(barrier('poll.resume'), '')

  const polled = await poll.done
  assert.equal(polled.lastError, null)
  const done = await backfill.done
  assert.equal(done.error, null)
  assert.ok(done.busy >= 1, 'the backfill waited on the held scope')
  const complete = done.events.find((/** @type {any} */ e) => e.name === 'hermes.backfill.scan_complete')
  assert.equal(complete.sessions_busy, 0)
  assert.equal(complete.status, 'ok')
  assert.deepEqual(await cachedTexts(common.cacheRoot), ['question'],
    'the backfill read the rewound view only after the stale poll committed')

  // The poll's watermark names the view it committed (pre-rewind), so the
  // next tick re-reads and agrees with the cache.
  const next = await runWriter({ ...pollArgs, ticks: 2 }).done
  assert.equal(next.lastError, null)
  assert.equal(deferredCount(next), 0)
  assert.deepEqual(await cachedTexts(common.cacheRoot), ['question'])
})

test('a held session does not serialize writers on other sessions; measured overhead', async t => {
  const { db, common, pollArgs, backfillArgs, barrier } = await fixture(t)
  // Sorts first, so it is the session the paused poll reconciles and holds.
  insertSession(db, 'a-held', '2026-07-20T10:00:00Z')
  insertMessage(db, 1, 'a-held', 'user', 'held question')

  // A poll holds the `a-held` session's guard for the whole backfill. A poll
  // holds every session of its batch until the batch commits (LLP 0527), so
  // the other sessions arrive after its listing and are not in that batch.
  const poll = runWriter({ ...pollArgs, pauseFile: barrier('poll.paused'), resumeFile: barrier('poll.resume') })
  await waitForFile(barrier('poll.paused'), poll.done)
  const others = 12
  for (let i = 0; i < others; i++) {
    insertSession(db, `free-${i}`, '2026-07-21T10:00:00Z')
    insertMessage(db, 100 + i * 2, `free-${i}`, 'user', `question ${i}`)
    insertMessage(db, 101 + i * 2, `free-${i}`, 'assistant', `answer ${i}`)
  }
  const solo = await runWriter({ ...backfillArgs, cacheRoot: path.join(common.cacheRoot, '..', 'solo'), since: '2026-07-21T00:00:00Z' }).done
  assert.equal(solo.error, null)
  const concurrent = await runWriter({ ...backfillArgs, since: '2026-07-21T00:00:00Z' }).done
  fs.writeFileSync(barrier('poll.resume'), '')
  assert.equal((await poll.done).lastError, null)

  assert.equal(concurrent.error, null)
  assert.equal(concurrent.busy, 0, 'no session the backfill imports ever reported busy')
  const texts = await cachedTexts(common.cacheRoot)
  assert.equal(texts.length, 1 + others * 2)
  assert.equal(new Set(texts).size, texts.length, 'no duplicate rows')
  t.diagnostic(`backfill of ${others} sessions: ${solo.ms.toFixed(0)}ms alone, ${concurrent.ms.toFixed(0)}ms beside a held session`)

  // An uncontended claim and release, per session, in this process.
  const storage = createQueryStorageService({ cacheRoot: common.cacheRoot })
  const rounds = 500
  const started = performance.now()
  for (let i = 0; i < rounds; i++) {
    storage.claimReconcileScope?.(AI_GATEWAY_MESSAGES_DATASET, hermesReconcileScope(HERMES_CLIENT_NAME, `free-${i % others}`))()
  }
  const perClaim = (performance.now() - started) / rounds
  t.diagnostic(`uncontended scope claim + release: ${(perClaim * 1000).toFixed(0)}us per session`)
  assert.ok(perClaim < 20, `claim + release costs ${perClaim.toFixed(2)}ms per session`)
})

test('ordinary concurrent poll and backfill with no rewind converge with bounded waits', async t => {
  const { db, common, pollArgs, backfillArgs } = await fixture(t)
  const sessions = 12
  for (let i = 0; i < sessions; i++) {
    insertSession(db, `s-${i}`)
    insertMessage(db, 1 + i * 2, `s-${i}`, 'user', `question ${i}`)
    insertMessage(db, 2 + i * 2, `s-${i}`, 'assistant', `answer ${i}`)
  }
  const started = performance.now()
  const [poll, backfill] = await Promise.all([runWriter(pollArgs).done, runWriter(backfillArgs).done])
  const wall = performance.now() - started
  // Both writers share one source partition, whose own guard (LLP 0347)
  // already fails one of two simultaneous commits fast, with or without the
  // scope guard. That refusal is the only error either writer may report.
  const busyMessage = /cache partition mutation busy/
  if (poll.lastError !== null) assert.match(poll.lastError, busyMessage)
  if (backfill.error !== null) assert.equal(backfill.error_kind, 'cache_partition_mutation_busy')
  // Whatever either writer deferred or refused, the next ticks finish it,
  // and then nothing is left.
  const next = await runWriter({ ...pollArgs, ticks: 2 }).done
  assert.equal(next.lastError, null)
  assert.equal(deferredCount(next), 0)
  const texts = await cachedTexts(common.cacheRoot)
  assert.equal(texts.length, sessions * 2)
  assert.equal(new Set(texts).size, texts.length, 'no duplicate rows')
  t.diagnostic(`${sessions} sessions, both writers at once: wall ${wall.toFixed(0)}ms, poll ${poll.ms.toFixed(0)}ms ` +
    `(${deferredCount(poll)} deferred, error ${poll.lastError ? 'partition busy' : 'none'}), ` +
    `backfill ${backfill.ms.toFixed(0)}ms (${backfill.busy} scope waits, error ${backfill.error ? 'partition busy' : 'none'})`)
})

test('a backfill still busy after its bounded wait fails visibly and imports the rest', async t => {
  const { db, common, backfillArgs } = await fixture(t)
  insertSession(db, 'held')
  insertMessage(db, 1, 'held', 'user', 'held question')
  insertSession(db, 'free')
  insertMessage(db, 2, 'free', 'user', 'free question')
  const storage = createQueryStorageService({ cacheRoot: common.cacheRoot })
  const release = /** @type {() => void} */ (storage.claimReconcileScope?.(AI_GATEWAY_MESSAGES_DATASET,
    hermesReconcileScope(HERMES_CLIENT_NAME, 'held')))
  let out
  try {
    out = await runWriter(backfillArgs).done
  } finally {
    release()
  }
  assert.equal(out.error_kind, 'cache_partition_mutation_busy')
  assert.match(out.error, /1 hermes session\(s\) stayed busy/)
  const complete = out.events.find((/** @type {any} */ e) => e.name === 'hermes.backfill.scan_complete')
  assert.equal(complete.sessions_busy, 1)
  assert.equal(complete.status, 'partial')
  assert.deepEqual(await cachedTexts(common.cacheRoot), ['free question'])
})

test('a scope guard left by a dead process is recovered', async t => {
  const { common } = await fixture(t)
  const where = hermesReconcileScope(HERMES_CLIENT_NAME, 's1')
  const child = `
    const { createQueryStorageService } = await import(${JSON.stringify(MODULES.storage)})
    createQueryStorageService({ cacheRoot: process.argv[1] }).claimReconcileScope(
      ${JSON.stringify(AI_GATEWAY_MESSAGES_DATASET)}, ${JSON.stringify(where)})
    process.exit(0)
  `
  await new Promise((resolve, reject) => {
    spawn(process.execPath, ['--input-type=module', '-e', child, common.cacheRoot], { stdio: 'ignore' })
      .on('exit', code => code === 0 ? resolve(undefined) : reject(new Error(`exit ${code}`)))
  })
  const datasetDir = path.join(common.cacheRoot, 'datasets', AI_GATEWAY_MESSAGES_DATASET)
  assert.equal(fs.readdirSync(datasetDir).filter(name => name.endsWith('.mutation-lock')).length, 1, 'the dead writer left its guard')
  const storage = createQueryStorageService({ cacheRoot: common.cacheRoot })
  storage.claimReconcileScope?.(AI_GATEWAY_MESSAGES_DATASET, where)()
  assert.deepEqual(fs.readdirSync(datasetDir).filter(name => name.endsWith('.mutation-lock')), [], 'released clean')
})

test('scope guards are per session and fail fast while held', async t => {
  const { common } = await fixture(t)
  const storage = createQueryStorageService({ cacheRoot: common.cacheRoot })
  const claim = (/** @type {string} */ id) => /** @type {() => void} */ (
    storage.claimReconcileScope?.(AI_GATEWAY_MESSAGES_DATASET, hermesReconcileScope(HERMES_CLIENT_NAME, id)))
  const a = claim('a')
  const b = claim('b')
  assert.throws(() => claim('a'), err => isPartitionMutationBusy(err))
  a()
  claim('a')()
  b()
  assert.throws(() => storage.claimReconcileScope?.(AI_GATEWAY_MESSAGES_DATASET, { client_name: HERMES_CLIENT_NAME }),
    /Invalid snapshot scope/)
})

test('the guarded snapshot mark equals the change-scan mark, so a committed view is not rescanned', async t => {
  const { db, common } = await fixture(t)
  insertSession(db, 's1')
  insertMessage(db, 1, 's1', 'user', 'question')
  insertMessage(db, 2, 's1', 'assistant', 'answer')
  rewind(db, 2)
  const reader = await openHermesStateDb(common.dbPath)
  t.after(() => reader.close())
  const [scanned] = await reader.listChangedSessions({})
  const snapshot = await reader.readSessionSnapshot('s1')
  assert.ok(snapshot)
  assert.equal(snapshot.mark.fingerprint, scanned.fingerprint)
  assert.equal(snapshot.mark.max_message_id, 1)
  assert.deepEqual(snapshot.messages.map(message => message.id), [1])
  assert.equal(await reader.readSessionSnapshot('missing'), null)
})

test('a dry-run backfill takes no scope guard', async t => {
  const { db, common } = await fixture(t)
  insertSession(db, 's1')
  insertMessage(db, 1, 's1', 'user', 'question')
  const { createHermesBackfillProvider } = await import('../../hypaware-core/plugins-workspace/hermes/src/backfill.js')
  const provider = createHermesBackfillProvider({ stateDbPath: common.dbPath, homeDir: common.cacheRoot })
  let claims = 0
  const storage = { claimReconcileScope() { claims++; return () => {} } }
  const log = { debug() {}, info() {}, warn() {}, error() {} }
  let items = 0
  for await (const item of provider.run(/** @type {any} */ ({ storage, env: {}, log, dryRun: true }))) if ('kind' in item) items++
  assert.equal(items, 1)
  assert.equal(claims, 0)
})
