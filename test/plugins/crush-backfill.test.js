// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createCrushBackfillProvider, CRUSH_SWEEP_CRON } from '../../hypaware-core/plugins-workspace/crush/src/backfill.js'
import { readCrushWatermark } from '../../hypaware-core/plugins-workspace/crush/src/watermark.js'
import { createCrushPollRunner, runCrushPollTick } from '../../hypaware-core/plugins-workspace/crush/src/source.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { sessionIgnoresDir } from '../../src/core/runtime/paths.js'
import { runBackfillProvider } from '../../src/core/commands/backfill.js'
import { withLogRecords } from '../helpers/log_records.js'
import { createBackfillMaterializerRegistry, createBackfillRegistry } from '../../src/core/registry/backfills.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { insertMessage, insertSession, openWriter } from '../helpers/crush_db_fixture.js'
import { createCrushHarness } from '../helpers/crush_source_fixture.js'

/**
 * @ref LLP 0573#backfill [tests]: the `updated_at` window, the unset window,
 *   reconcile-not-append on a re-run, the sweep contribution following
 *   `on_join`, and the runner shared with the poll, through the real kernel
 *   runner and materializer.
 * @ref LLP 0573#reconciliation [tests]: the sweep's digest catches an
 *   in-place edit and skips an unchanged session, a deleted or out-of-window
 *   session's entry is pruned and the floor raised, and a same-second entry
 *   is handed to the poll as unsettled.
 * @ref LLP 0573#privacy [tests]: an exclusion is skipped and not advanced,
 *   an unreadable exclusions store fails closed, a usage-policy ignore
 *   reconciles the project's sessions to no rows without opening the
 *   database, and an unreadable database is reported by kind with no path.
 *
 * The databases carry the Crush v0.99.0 schema, synthetic rows only.
 */

/** @param {string} text */
function textParts(text) {
  return [{ type: 'text', data: { text } }]
}

/**
 * One finished user-and-assistant turn.
 *
 * @param {ReturnType<typeof openWriter>} w
 * @param {string} sessionId
 * @param {string} tag
 */
function addTurn(w, sessionId, tag) {
  insertMessage(w, { id: `${sessionId}-${tag}-u`, session_id: sessionId, role: 'user', parts: textParts(`${tag} prompt`) })
  insertMessage(w, {
    id: `${sessionId}-${tag}-a`, session_id: sessionId, role: 'assistant',
    parts: textParts(`${tag} reply`), model: 'fixture-model', provider: 'fixture-provider',
  })
}

/**
 * One session holding one turn in the database at `dbPath`.
 *
 * @param {string} dbPath
 * @param {string} id
 * @param {string} [tag]
 */
function seedSession(dbPath, id, tag = 'history') {
  const w = openWriter(dbPath)
  insertSession(w, { id, title: 'Fixture title' })
  addTurn(w, id, tag)
  w.close()
}

/**
 * The `content_text` of one session's committed message rows.
 *
 * @param {Record<string, unknown>[]} committed
 * @param {string} sessionId
 */
function texts(committed, sessionId) {
  return committed
    .filter(row => row.session_id === `crush-${sessionId}` && row.part_type !== 'session_metadata')
    .map(row => row.content_text)
}

/** @param {Array<{ message: string, fields?: Record<string, unknown> }>} logs */
function scanComplete(logs) {
  const entry = logs.findLast(record => record.message === 'crush.backfill.scan_complete')
  assert.ok(entry, 'scan_complete logged')
  return /** @type {Record<string, unknown>} */ (entry.fields)
}

/**
 * Per-project databases and an index, a reconciling storage, and the crush
 * provider staged in the real backfill registries.
 *
 * @param {{ projects?: string[], config?: Record<string, unknown>,
 *   ignoredSessions?: (dir: string) => SessionIgnoreSet,
 *   busy?: (sessionId: string) => boolean, holder?: { runner?: any } }} [opts]
 */
async function stage(opts = {}) {
  const h = await createCrushHarness({ projects: opts.projects ?? ['p1'] })
  let appends = 0
  let claims = 0
  const storage = h.storage
  storage.cacheRoot = path.join(h.dir, 'cache')
  storage.cacheTablePath = (/** @type {string} */ dataset, /** @type {string[]} */ segs) => path.join(h.dir, 'cache', dataset, ...segs)
  storage.appendRows = async (/** @type {string} */ _table, /** @type {unknown} */ _columns, /** @type {Record<string, unknown>[]} */ rows) => {
    appends += 1
    h.committed.push(...rows)
  }
  storage.flushTable = async () => {}
  // The runner commits while the provider holds the scope, so this guard
  // counts claims and fails busy ones without holding anything.
  storage.claimReconcileScope = (/** @type {string} */ _dataset, /** @type {Record<string, string>} */ where) => {
    claims += 1
    if (opts.busy?.(where.session_id)) {
      throw Object.assign(new Error('scope busy'), { error_kind: 'cache_partition_mutation_busy' })
    }
    return () => {}
  }

  const ignoredSessions = opts.ignoredSessions?.(h.dir)
  const provider = createCrushBackfillProvider({
    indexPath: h.indexPath,
    dataDirs: [],
    stateDir: h.dir,
    ...(opts.config ? { config: /** @type {any} */ (opts.config) } : {}),
    ...(ignoredSessions ? { ignoredSessions } : {}),
    localOnlyListPath: path.join(h.dir, 'local-only.json'),
    ...(opts.holder ? { holder: opts.holder } : {}),
  })
  const backfills = createBackfillRegistry()
  backfills.register(provider)
  const materializers = createBackfillMaterializerRegistry()
  materializers.register(aiGatewayBackfillMaterializer())
  const ctx = /** @type {any} */ ({
    env: h.ctx.env,
    config: {},
    stdout: { write: () => true },
    stderr: { write: () => true },
    backfills,
    backfillMaterializers: materializers,
    query: { ...h.ctx.query, registerDataset() {}, listDatasets() { return [] } },
    storage,
  })

  return {
    ...h,
    provider,
    get appends() { return appends },
    get claims() { return claims },
    /** @param {{ sweep?: boolean, dryRun?: boolean, since?: string, until?: string }} [args] */
    run: (args = {}) => runBackfillProvider({ ctx, provider: 'crush', dryRun: args.dryRun ?? false, ...args }),
    /**
     * Drive the provider directly, so its own log records and error_kind
     * are visible (the runner logs through its own logger).
     *
     * @param {{ sweep?: boolean, dryRun?: boolean, since?: string, signal?: AbortSignal }} [args]
     * @param {unknown[]} [items]
     */
    async direct(args = {}, items = []) {
      const runCtx = /** @type {any} */ ({
        env: ctx.env, storage, cacheRoot: storage.cacheRoot, dryRun: false, itemsFailed: 0, log: h.ctx.log, ...args,
      })
      for await (const item of provider.run(runCtx)) items.push(item)
      return items
    },
  }
}

test('crush backfill: the sweep contribution follows on_join', () => {
  const on = createCrushBackfillProvider({ indexPath: '/nonexistent', dataDirs: [], stateDir: '/nonexistent' })
  assert.equal(on.name, 'crush')
  assert.equal(on.plugin, '@hypaware/crush')
  assert.deepEqual(on.datasets, ['ai_gateway_messages'])
  assert.deepEqual(on.sweep, { cron: CRUSH_SWEEP_CRON })

  const off = createCrushBackfillProvider({
    indexPath: '/nonexistent',
    dataDirs: [],
    stateDir: '/nonexistent',
    config: { backfill: { on_join: false } },
  })
  assert.equal(off.sweep, undefined)
})

test('crush backfill: an unset window imports every session in every database, and a re-run reconciles', async () => {
  const h = await stage({ projects: ['p1', 'p2'] })
  seedSession(h.dbPaths[0], 's1')
  seedSession(h.dbPaths[1], 's2')
  const w = openWriter(h.dbPaths[0])
  insertSession(w, { id: 'title-x' })
  addTurn(w, 'title-x', 'naming')
  w.close()

  const first = await h.run()
  assert.equal(first.ok, true)
  assert.equal(first.scanned, 2, 'the title session is not a session')
  assert.deepEqual(texts(h.committed, 's1'), ['history prompt', 'history reply'])
  assert.deepEqual(texts(h.committed, 's2'), ['history prompt', 'history reply'])
  assert.equal(texts(h.committed, 'title-x').length, 0)
  const total = h.committed.length

  const second = await h.run()
  assert.equal(second.ok, true)
  assert.equal(h.committed.length, total, 'a re-run replaces each session scope')
  assert.equal(h.appends, 0, 'every item reconciles its scope')
})

test('crush backfill: since and until bound sessions by updated_at', async () => {
  const h = await stage()
  const w = openWriter(h.dbPaths[0])
  insertSession(w, { id: 's-old' })
  addTurn(w, 's-old', 'old')
  insertSession(w, { id: 's-new' })
  addTurn(w, 's-new', 'new')
  // Pin the old session's second; the trigger would move it back to now.
  w.exec('DROP TRIGGER update_sessions_updated_at')
  w.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(1767225600, 's-old')
  w.close()

  const since = await h.run({ since: '2026-06-01T00:00:00.000Z' })
  assert.equal(since.ok, true)
  assert.equal(texts(h.committed, 's-old').length, 0)
  assert.deepEqual(texts(h.committed, 's-new'), ['new prompt', 'new reply'])

  h.committed.length = 0
  const until = await h.run({ until: '2026-06-01T00:00:00.000Z' })
  assert.equal(until.ok, true)
  assert.deepEqual(texts(h.committed, 's-old'), ['old prompt', 'old reply'])
  assert.equal(texts(h.committed, 's-new').length, 0)
})

test('crush backfill: the sweep catches an in-place edit and skips an unchanged session', async () => {
  const h = await stage()
  seedSession(h.dbPaths[0], 's1')
  seedSession(h.dbPaths[0], 's2')
  assert.equal((await h.run({ sweep: true })).ok, true)

  const w = openWriter(h.dbPaths[0])
  w.prepare('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(textParts('edited reply')), 's1-history-a')
  assert.equal((await h.run({ sweep: true })).ok, true)
  assert.deepEqual(texts(h.committed, 's1'), ['history prompt', 'edited reply'])

  w.prepare('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(textParts('edited again')), 's1-history-a')
  w.close()
  await h.direct({ sweep: true })
  const fields = scanComplete(h.logs)
  assert.equal(fields.sessions_projected, 1)
  assert.equal(fields.sessions_unchanged, 1)
  assert.equal(fields.status, 'ok')
})

test('crush backfill: a project added to the index between runs is imported by the next run', async () => {
  const h = await stage({ projects: ['p1', 'p2'] })
  seedSession(h.dbPaths[0], 's1')
  seedSession(h.dbPaths[1], 's2')
  await h.writeIndex([path.join(h.projectDirs[0], '.crush')])
  assert.equal((await h.run()).ok, true)
  assert.equal(texts(h.committed, 's2').length, 0)

  await h.writeIndex(h.projectDirs.map(dir => path.join(dir, '.crush')))
  assert.equal((await h.run()).ok, true)
  assert.deepEqual(texts(h.committed, 's2'), ['history prompt', 'history reply'])
})

test('crush backfill: a sweep shares the poll runner, hands it same-second entries, and raises the floor', async () => {
  /** @type {{ runner?: any }} */
  const holder = {}
  const h = await stage({ holder })
  const future = Math.floor(Date.now() / 1000) + 3600
  const w = openWriter(h.dbPaths[0])
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'history')
  w.exec('DROP TRIGGER update_sessions_updated_at')
  w.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(future, 's1')

  const runner = createCrushPollRunner(h.ctx)
  holder.runner = runner
  await runCrushPollTick(runner, h.ctx)
  assert.equal(h.committed.length, 0, 'the poll baselines without importing history')

  assert.equal((await h.run({ sweep: true })).ok, true)
  assert.deepEqual(texts(h.committed, 's1'), ['history prompt', 'history reply'])
  assert.equal(runner.watermark?.sessions.s1?.updated_at, future, 'the sweep settles the poll watermark')
  assert.ok(runner.unsettled?.has('s1'), 'an entry in its own second is left for the poll to hash again')
  const total = h.committed.length

  await runCrushPollTick(runner, h.ctx)
  assert.equal(h.committed.length, total, 'the poll does not duplicate the swept session')

  const since = new Date((future + 60) * 1000).toISOString()
  assert.equal((await h.run({ sweep: true, since })).ok, true)
  assert.equal(runner.watermark?.sessions.s1, undefined, 'an out-of-window entry is pruned')
  const floor = runner.watermark?.dbs[h.dbPaths[0]]?.floor
  assert.ok(floor >= future, 'the pruned entry raises the floor')

  insertSession(w, { id: 's2' })
  addTurn(w, 's2', 'later')
  w.close()
  await runCrushPollTick(runner, h.ctx)
  assert.deepEqual(texts(h.committed, 's2'), ['later prompt', 'later reply'])
  assert.equal(runner.watermark?.sessions.s1, undefined, 'the floor keeps the pruned session out')
  assert.equal(readCrushWatermark(h.dir).sessions.s1, undefined)
})

test('crush backfill: a deleted session has its entry pruned', async () => {
  const h = await stage()
  seedSession(h.dbPaths[0], 's1')
  seedSession(h.dbPaths[0], 's2')
  assert.equal((await h.run({ sweep: true })).ok, true)
  assert.ok(readCrushWatermark(h.dir).sessions.s2)

  const w = openWriter(h.dbPaths[0])
  w.prepare('DELETE FROM messages WHERE session_id = ?').run('s2')
  w.prepare('DELETE FROM sessions WHERE id = ?').run('s2')
  w.close()
  await h.direct({ sweep: true })
  assert.equal(scanComplete(h.logs).entries_pruned, 1)
  assert.equal(readCrushWatermark(h.dir).sessions.s2, undefined)
  assert.ok(readCrushWatermark(h.dir).sessions.s1)
})

test('crush backfill: a briefly busy session is retried and imported', async () => {
  let busyFor = 3
  const h = await stage({ busy: () => busyFor-- > 0 })
  seedSession(h.dbPaths[0], 's1')
  const result = await h.run()
  assert.equal(result.ok, true)
  assert.ok(texts(h.committed, 's1').length > 0)
  assert.equal(h.claims, 4)
})

test('crush backfill: a session that stays busy fails the run after the rest is imported', async () => {
  const h = await stage({ busy: sessionId => sessionId === 'crush-held' })
  seedSession(h.dbPaths[0], 'free')
  seedSession(h.dbPaths[0], 'held')
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

test('crush backfill: an excluded session is skipped and its entry does not advance', async () => {
  const h = await stage({ ignoredSessions: dir => new SessionIgnoreSet(dir) })
  seedSession(h.dbPaths[0], 's1')
  assert.equal((await h.run({ sweep: true })).ok, true)
  const before = readCrushWatermark(h.dir).sessions.s1
  assert.ok(before)

  new SessionIgnoreSet(h.dir).add('crush-s1')
  const w = openWriter(h.dbPaths[0])
  addTurn(w, 's1', 'private')
  w.close()
  const committedBefore = h.committed.length
  assert.equal((await h.run({ sweep: true })).ok, true)
  assert.equal(h.committed.length, committedBefore, 'the excluded edit is not committed')
  assert.deepEqual(readCrushWatermark(h.dir).sessions.s1, before)
  await h.direct({ sweep: true })
  assert.equal(scanComplete(h.logs).sessions_excluded, 1)
})

test('crush backfill: an unreadable exclusions store fails the run closed', async () => {
  const h = await stage({ ignoredSessions: dir => new SessionIgnoreSet(dir) })
  seedSession(h.dbPaths[0], 's1')
  await fs.mkdir(sessionIgnoresDir(h.dir), { recursive: true })
  await fs.writeFile(path.join(sessionIgnoresDir(h.dir), 'not-a-marker'), 'x')
  await assert.rejects(h.direct(),
    /** @param {any} err */ err => err.error_kind === 'session_ignore_load_failed')
  const result = await h.run()
  assert.equal(result.ok, false)
  assert.equal(h.committed.length, 0, 'nothing is projected')
})

test('crush backfill: an ignore-policy project is emptied without opening its database', async () => {
  const h = await stage()
  seedSession(h.dbPaths[0], 's1')
  assert.equal((await h.run({ sweep: true })).ok, true)
  assert.ok(texts(h.committed, 's1').length > 0)

  await fs.writeFile(path.join(h.projectDirs[0], '.hypignore'), 'ignore\n')
  assert.equal((await h.run({ sweep: true })).ok, true)
  assert.equal(texts(h.committed, 's1').length, 0, 'rows captured before the ignore are removed')
  assert.equal(readCrushWatermark(h.dir).sessions.s1, undefined)
  await h.direct({ sweep: true })
  const fields = scanComplete(h.logs)
  assert.equal(fields.dbs_ignored, 1)
  assert.equal(fields.sessions_seen, 0, 'the database is not opened')
})

test('crush backfill: an unreadable database fails by kind and keeps its path out of every record', { skip: process.platform === 'win32' && 'chmod 0o000 does not make a file unreadable on win32' }, async () => {
  const h = await stage()
  seedSession(h.dbPaths[0], 's1')
  await fs.chmod(h.dbPaths[0], 0o000)
  try {
    await assert.rejects(h.direct({ sweep: true }),
      /** @param {any} err */ err => err.code === 'permission_denied' && !err.message.includes(h.dbPaths[0]))
    const failed = h.logs.find(record => record.message === 'crush.backfill.open_failed')
    assert.equal(failed?.fields?.error_kind, 'permission_denied')
    assert.equal(scanComplete(h.logs).dbs_failed, 1)
    assert.ok(!JSON.stringify(h.logs).includes(h.projectDirs[0]), 'no path in the provider log')

    const { result, records } = await withLogRecords(() => h.run({ sweep: true }))
    assert.equal(result.ok, false)
    assert.ok(records.some(record => record.body === 'backfill.provider_error'), 'the kernel logs the failure')
    assert.ok(!JSON.stringify(records).includes(h.projectDirs[0]), 'no path in any log record')
    assert.ok(!JSON.stringify(result).includes(h.projectDirs[0]), 'no path in the run result')
  } finally {
    await fs.chmod(h.dbPaths[0], 0o600)
  }
})

test('crush backfill: a dry run takes no scope guard and writes no watermark', async () => {
  const h = await stage()
  seedSession(h.dbPaths[0], 's1')
  const result = await h.run({ sweep: true, dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.scanned, 1)
  assert.equal(h.claims, 0)
  assert.deepEqual(readCrushWatermark(h.dir).sessions, {})
})

test('crush backfill: no Crush store is a no-op', async () => {
  const h = await stage()
  await fs.rm(h.indexPath)
  for (const dir of h.projectDirs) await fs.rm(path.join(dir, '.crush'), { recursive: true })
  const items = await h.direct({ sweep: true })
  assert.deepEqual(items, [])
  assert.ok(h.logs.some(record => record.message === 'crush.backfill.no_store'))
  const result = await h.run({ sweep: true })
  assert.equal(result.ok, true)
  assert.equal(result.scanned, 0)
})
