// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createMastracodeBackfillProvider, MASTRACODE_SWEEP_CRON } from '../../hypaware-core/plugins-workspace/mastracode/src/backfill.js'
import { createMastracodePollRunner, runMastracodePollTick } from '../../hypaware-core/plugins-workspace/mastracode/src/source.js'
import { readMastraWatermark } from '../../hypaware-core/plugins-workspace/mastracode/src/watermark.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { sessionIgnoresDir } from '../../src/core/runtime/paths.js'
import { runBackfillProvider } from '../../src/core/commands/backfill.js'
import { withLogRecords } from '../helpers/log_records.js'
import { createBackfillMaterializerRegistry, createBackfillRegistry } from '../../src/core/registry/backfills.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { addThread, addTurn, createMastracodeHarness, mastracodePollLogs, nextUpdatedAt, texts } from '../helpers/mastracode_source_fixture.js'
import { openWriter, rewriteMessage, updateThread } from '../helpers/mastracode_db_fixture.js'

/**
 * @ref LLP 0586#backfill [tests]: the `updatedAt` window, the unset window,
 *   reconcile-not-append on a re-run, and the sweep contribution following
 *   `on_join`, through the real kernel runner and materializer.
 * @ref LLP 0586#reconciliation [tests]: the sweep's digest catches an
 *   in-place edit and a removed message, skips an unchanged thread, and
 *   recovers threads written while no poll ran, which the poll then leaves alone.
 * @ref LLP 0586#prune [tests]: a deleted or out-of-scope thread loses only
 *   its entry, which raises the floor, so the poll does not hash it as new.
 *
 * Synthetic rows only, in Mastra Code 0.49.0's shape.
 */

/** @import { MastraRunnerHolder } from '../../hypaware-core/plugins-workspace/mastracode/src/types.js' */

/**
 * The mastracode harness's `mastra.db` and fake storage, the provider staged
 * in the real backfill registries, and an optional poll runner sharing its
 * holder, as `activate` wires them.
 *
 * @param {{ config?: Record<string, unknown>, ignoredSessions?: (dir: string) => SessionIgnoreSet,
 *   poll?: boolean, location?: { kind: 'remote' } }} [opts]
 */
async function stage(opts = {}) {
  const harness = await createMastracodeHarness()
  const { dir, dbPath, storage } = harness
  let claims = 0
  let appends = 0
  const claim = storage.claimReconcileScope
  storage.claimReconcileScope = (/** @type {string} */ dataset, /** @type {Record<string, string>} */ where) => {
    claims += 1
    return claim(dataset, where)
  }
  storage.cacheRoot = path.join(dir, 'cache')
  storage.cacheTablePath = (/** @type {string} */ dataset, /** @type {string[]} */ segs) => path.join(dir, 'cache', dataset, ...segs)
  storage.appendRows = async (/** @type {string} */ _table, /** @type {unknown} */ _columns, /** @type {Record<string, unknown>[]} */ rows) => {
    appends += 1
    harness.committed.push(...rows)
  }
  storage.flushTable = async () => {}

  const ignoredSessions = opts.ignoredSessions?.(dir)
  /** @type {MastraRunnerHolder} */
  const holder = {}
  if (opts.poll) {
    holder.runner = createMastracodePollRunner(harness.ctx, ignoredSessions ? { ignoredSessions } : {})
    await runMastracodePollTick(holder.runner, harness.ctx)
  }
  const provider = createMastracodeBackfillProvider({
    location: opts.location ?? { kind: 'local', path: dbPath },
    stateDir: dir,
    ...(opts.config ? { config: /** @type {any} */ (opts.config) } : {}),
    ...(ignoredSessions ? { ignoredSessions } : {}),
    localOnlyListPath: path.join(dir, 'local-only.json'),
    holder,
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
    query: harness.ctx.query,
    storage,
  })
  const w = openWriter(dbPath)

  return {
    ...harness,
    w,
    holder,
    get claims() { return claims },
    get appends() { return appends },
    /** @param {{ sweep?: boolean, dryRun?: boolean, since?: string, until?: string }} [args] */
    run: (args = {}) => runBackfillProvider({ ctx, provider: 'mastracode', dryRun: args.dryRun ?? false, ...args }),
    /**
     * One sweep through the real runner, so items commit, with the
     * provider's `scan_complete` fields read off the kernel log records.
     *
     * @param {{ since?: string }} [args]
     */
    async sweep(args = {}) {
      const { result, records } = await withLogRecords(() => runBackfillProvider({ ctx, provider: 'mastracode', dryRun: false, sweep: true, ...args }))
      assert.equal(result.ok, true)
      const complete = records.findLast(record => record.body === 'mastracode.backfill.scan_complete')
      assert.ok(complete, 'scan_complete logged')
      return /** @type {Record<string, unknown>} */ (complete.attributes)
    },
    /**
     * Drive the provider directly, so its own log records and error_kind
     * are visible (the runner logs through its own logger).
     *
     * @param {{ sweep?: boolean, dryRun?: boolean, since?: string, signal?: AbortSignal }} [args]
     * @param {unknown[]} [items]
     */
    async direct(args = {}, items = []) {
      const runCtx = /** @type {any} */ ({ env: ctx.env, storage, cacheRoot: storage.cacheRoot, dryRun: false, itemsFailed: 0, log: harness.ctx.log, ...args })
      for await (const item of provider.run(runCtx)) items.push(item)
      return items
    },
    /** Run one poll tick on the shared runner. */
    poll: async () => {
      const runner = holder.runner
      assert.ok(runner, 'staged with a poll')
      await runMastracodePollTick(runner, harness.ctx)
      return /** @type {Record<string, unknown>} */ (mastracodePollLogs(harness.logs).at(-1)?.fields)
    },
  }
}

/** @param {Array<{ message: string, fields?: Record<string, unknown> }>} logs */
function scanComplete(logs) {
  const entry = logs.findLast(record => record.message === 'mastracode.backfill.scan_complete')
  assert.ok(entry, 'scan_complete logged')
  return /** @type {Record<string, unknown>} */ (entry.fields)
}

test('mastracode backfill: the sweep contribution follows on_join', () => {
  const location = /** @type {const} */ ({ kind: 'local', path: '/nonexistent/mastra.db' })
  const on = createMastracodeBackfillProvider({ location, stateDir: '/nonexistent' })
  assert.equal(on.name, 'mastracode')
  assert.equal(on.plugin, '@hypaware/mastracode')
  assert.deepEqual(on.datasets, ['ai_gateway_messages'])
  assert.deepEqual(on.sweep, { cron: MASTRACODE_SWEEP_CRON })

  const off = createMastracodeBackfillProvider({ location, stateDir: '/nonexistent', config: { backfill: { on_join: false } } })
  assert.equal(off.sweep, undefined)
})

test('mastracode backfill: an unset window imports every thread, and a re-run reconciles rather than appends', async () => {
  const h = await stage()
  addThread(h.w, 't1', h.projectDir, { updatedAt: '2025-01-01T00:00:00.000Z' })
  addTurn(h.w, 't1', 'old', { bump: false })
  addThread(h.w, 't2', h.projectDir)
  addTurn(h.w, 't2', 'new')

  const first = await h.run()
  assert.equal(first.ok, true)
  assert.equal(first.scanned, 2)
  assert.deepEqual(texts(h.committed, 't1'), ['old prompt', 'old reply'])
  assert.deepEqual(texts(h.committed, 't2'), ['new prompt', 'new reply'])
  const total = h.committed.length

  const second = await h.run()
  assert.equal(second.ok, true)
  assert.equal(h.committed.length, total, 'a re-run replaces each thread scope')
  assert.equal(h.appends, 0, 'every item reconciles its scope')
})

test('usage-only updates replace one snapshot through poll, backfill and restart', async () => {
  const h = await stage({ poll: true })
  try {
    addThread(h.w, 'usage', h.projectDir)
    addTurn(h.w, 'usage', 'first')
    const tokenUsage = { promptTokens: 100, cachedInputTokens: 60, cacheCreationInputTokens: 30,
      completionTokens: 20, reasoningTokens: 5, totalTokens: 120 }
    const writeUsage = () => updateThread(h.w, 'usage', { updatedAt: nextUpdatedAt(),
      metadata: { projectPath: h.projectDir, currentModelId: 'anthropic/fixture', tokenUsage } })
    writeUsage()
    await h.poll()
    const first = h.committed.find(r => r.provider_subtype === 'session_usage')
    assert.ok(first)
    assert.equal(first.input_tokens, 10)
    assert.equal(first.output_tokens, 20)
    const initialId = first.part_id

    // No message changes: only the thread's persisted counters advance.
    tokenUsage.promptTokens = 170
    tokenUsage.cachedInputTokens = 120
    tokenUsage.completionTokens = 25
    tokenUsage.totalTokens = 195
    writeUsage()
    await h.poll()
    h.holder.runner = createMastracodePollRunner(h.ctx)
    await h.poll()
    assert.equal((await h.run()).ok, true)
    assert.equal((await h.run()).ok, true)
    const rows = h.committed.filter(r => r.provider_subtype === 'session_usage')
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0].part_id, initialId)
    assert.equal(rows[0].message_created_at, first.message_created_at)
    assert.equal(rows[0].input_tokens, 20)
    assert.equal(rows[0].output_tokens, 25)
    assert.equal(rows[0].cache_read_tokens, 120)
    assert.equal(rows[0].cache_write_tokens, 30)
    assert.equal(h.committed.filter(r => r.part_type === 'text').length, 2)
    assert.ok(h.committed.filter(r => r.part_type === 'text').every(r => r.output_tokens == null))
    assert.ok(mastracodePollLogs(h.logs).some(l => Number(l.fields?.threads_changed) === 1))
  } finally { h.w.close() }
})

test('mastracode backfill: the window filters on the thread updatedAt', async () => {
  const h = await stage()
  addThread(h.w, 'old', h.projectDir, { updatedAt: '2025-01-01T00:00:00.000Z' })
  addTurn(h.w, 'old', 'old', { bump: false })
  addThread(h.w, 'recent', h.projectDir)
  addTurn(h.w, 'recent', 'recent')

  const result = await h.run({ since: '2026-01-01T00:00:00.000Z' })
  assert.equal(result.ok, true)
  assert.equal(result.scanned, 1)
  assert.deepEqual(texts(h.committed, 'old'), [])
  assert.deepEqual(texts(h.committed, 'recent'), ['recent prompt', 'recent reply'])
})

test('mastracode backfill: the sweep catches an in-place edit and a removed message, and skips an unchanged thread', async () => {
  const h = await stage()
  for (const id of ['edited', 'trimmed', 'same']) {
    addThread(h.w, id, h.projectDir)
    addTurn(h.w, id, 'one')
  }
  addTurn(h.w, 'trimmed', 'two')
  assert.equal((await h.sweep()).threads_projected, 3)
  const db = readMastraWatermark(h.dir).db
  assert.equal(db?.path, h.dbPath, 'a sweep with no poll records the baseline')
  assert.equal(Object.keys(readMastraWatermark(h.dir).threads).length, 3)

  // Neither change moves updatedAt or adds a row, so the poll's gates miss both.
  rewriteMessage(h.w, 'edited-one-a', { format: 2, parts: [{ type: 'text', text: 'edited reply' }], metadata: {} })
  h.w.prepare("DELETE FROM mastra_messages WHERE id IN ('trimmed-two-u', 'trimmed-two-a')").run()
  const fields = await h.sweep()
  assert.equal(fields.threads_projected, 2)
  assert.equal(fields.threads_unchanged, 1)
  assert.deepEqual(texts(h.committed, 'edited'), ['one prompt', 'edited reply'])
  assert.deepEqual(texts(h.committed, 'trimmed'), ['one prompt', 'one reply'], 'the sweep removes the pruned messages')
  const threads = readMastraWatermark(h.dir).threads
  assert.equal(threads.edited.open, true, 'a digest the sweep saw move marks the thread open')
  assert.equal(threads.same.open, false)
})

test('mastracode backfill: threads written while no poll ran are recovered by the sweep, and the poll leaves them alone', async () => {
  const h = await stage({ poll: true })
  addThread(h.w, 'down', h.projectDir)
  addTurn(h.w, 'down', 'offline')
  await h.sweep()
  assert.deepEqual(texts(h.committed, 'down'), ['offline prompt', 'offline reply'])
  const total = h.committed.length
  assert.equal(h.holder.runner?.watermark?.threads.down?.open, false, 'the sweep settles the shared watermark')

  const tick = await h.poll()
  assert.equal(tick.threads_changed, 0, 'the poll re-hashes the new rows and finds the thread settled')
  assert.equal(h.committed.length, total)
})

test('mastracode backfill: a pruned entry raises the floor and is not hashed by the poll as new', async () => {
  const h = await stage({ poll: true })
  addThread(h.w, 'aging', h.projectDir, { updatedAt: '2026-11-05T00:00:00.000Z' })
  addTurn(h.w, 'aging', 'one', { bump: false })
  await h.sweep()
  assert.ok(h.holder.runner?.watermark?.threads.aging)
  // The poll's next tick moves its cursor past the thread's rows.
  assert.equal((await h.poll()).threads_changed, 0)

  // A later sweep whose window has moved past the thread prunes its entry.
  const fields = await h.sweep({ since: '2026-11-05T12:00:00.000Z' })
  assert.equal(fields.entries_pruned, 1)
  const watermark = h.holder.runner?.watermark
  assert.equal(watermark?.threads.aging, undefined)
  assert.ok(watermark?.db?.floor && watermark.db.floor >= '2026-11-05T00:00:00.000Z', 'pruning raises the floor')
  assert.deepEqual(texts(h.committed, 'aging'), ['one prompt', 'one reply'], 'the cached rows stay')

  addThread(h.w, 'other', h.projectDir)
  addTurn(h.w, 'other', 'fresh')
  const tick = await h.poll()
  assert.equal(tick.threads_changed, 1, 'only the new thread is projected')
  assert.equal(h.holder.runner?.watermark?.threads.aging, undefined)
})

test('mastracode backfill: a thread deleted upstream keeps its cached rows and loses only its entry', async () => {
  const h = await stage()
  addThread(h.w, 'gone', h.projectDir)
  addTurn(h.w, 'gone', 'one')
  addThread(h.w, 'kept', h.projectDir)
  addTurn(h.w, 'kept', 'one')
  await h.sweep()

  h.w.prepare("DELETE FROM mastra_messages WHERE thread_id = 'gone'").run()
  h.w.prepare("DELETE FROM mastra_threads WHERE id = 'gone'").run()
  assert.equal((await h.sweep()).entries_pruned, 1)
  const threads = readMastraWatermark(h.dir).threads
  assert.equal(threads.gone, undefined)
  assert.ok(threads.kept)
  assert.deepEqual(texts(h.committed, 'gone'), ['one prompt', 'one reply'])
})

test('mastracode backfill: an excluded thread is skipped and keeps its watermark entry', async () => {
  const h = await stage({ ignoredSessions: dir => new SessionIgnoreSet(dir) })
  addThread(h.w, 't1', h.projectDir)
  addTurn(h.w, 't1', 'one')
  await h.sweep()
  const mark = readMastraWatermark(h.dir).threads.t1
  assert.ok(mark)

  // Written by another process after activation: the run refreshes the set.
  new SessionIgnoreSet(h.dir).add('mastracode-t1')
  rewriteMessage(h.w, 't1-one-a', { format: 2, parts: [{ type: 'text', text: 'edited while excluded' }], metadata: {} })
  const fields = await h.sweep()
  assert.equal(fields.threads_excluded, 1)
  assert.equal(fields.entries_pruned, 0, 'an excluded thread is still in scope')
  assert.deepEqual(readMastraWatermark(h.dir).threads.t1, mark, 'the entry does not advance')
  assert.deepEqual(texts(h.committed, 't1'), ['one prompt', 'one reply'])
})

test('mastracode backfill: unreadable exclusions fail the run closed', async () => {
  const h = await stage({ ignoredSessions: dir => new SessionIgnoreSet(dir) })
  addThread(h.w, 't1', h.projectDir)
  addTurn(h.w, 't1', 'one')
  await fs.mkdir(sessionIgnoresDir(h.dir), { recursive: true })
  await fs.writeFile(path.join(sessionIgnoresDir(h.dir), 'not-a-marker'), 'x')
  await assert.rejects(h.direct({ sweep: true }),
    /** @param {any} err */ err => err.error_kind === 'session_ignore_load_failed')
  assert.equal(h.committed.length, 0)
})

test('mastracode backfill: a usage-policy ignore reconciles the thread to no rows', async () => {
  const h = await stage()
  addThread(h.w, 't1', h.projectDir)
  addTurn(h.w, 't1', 'one')
  await h.run()
  assert.ok(texts(h.committed, 't1').length > 0)

  await fs.mkdir(h.projectDir, { recursive: true })
  await fs.writeFile(path.join(h.projectDir, '.hypignore'), '')
  const result = await h.run()
  assert.equal(result.ok, true)
  assert.equal(h.committed.filter(row => row.session_id === 'mastracode-t1').length, 0)
  assert.ok(!JSON.stringify(h.logs).includes(h.projectDir), 'the drop log names no project path')
})

test('mastracode backfill: a thread that stays busy fails the run after the rest is imported', async () => {
  const h = await stage()
  addThread(h.w, 'free', h.projectDir)
  addTurn(h.w, 'free', 'one')
  addThread(h.w, 'held', h.projectDir)
  addTurn(h.w, 'held', 'one')
  h.held.add('mastracode-held')
  const controller = new AbortController()
  // Abort once the held thread has been retried a few times, so the test
  // does not wait out the whole retry budget; the run still reports it busy.
  const timer = setTimeout(() => controller.abort(), 250)
  /** @type {unknown[]} */
  const items = []
  try {
    await assert.rejects(h.direct({ sweep: true, signal: controller.signal }, items),
      /** @param {any} err */ err => err.error_kind === 'cache_partition_mutation_busy')
  } finally {
    clearTimeout(timer)
  }
  assert.equal(items.length, 1, 'the free thread is still imported')
  assert.ok(h.claims > 2, 'the held thread is retried')
  const fields = scanComplete(h.logs)
  assert.equal(fields.threads_busy, 1)
  assert.equal(fields.status, 'partial')
  assert.ok(h.logs.some(record => record.message === 'mastracode.backfill.thread_busy'
    && record.fields?.error_kind === 'cache_partition_mutation_busy'))
})

test('mastracode backfill: a missing mastra.db is a no-op', async () => {
  const h = await stage()
  h.w.close()
  for (const suffix of ['', '-wal', '-shm']) await fs.rm(h.dbPath + suffix, { force: true })
  const items = await h.direct({ sweep: true })
  assert.deepEqual(items, [])
  assert.ok(h.logs.some(record => record.message === 'mastracode.backfill.no_store'))
  const result = await h.run({ sweep: true })
  assert.equal(result.ok, true)
  assert.equal(result.scanned, 0)
})

test('mastracode backfill: a remote store fails a manual run by kind and keeps a sweep quiet', async () => {
  const h = await stage({ location: { kind: 'remote' } })
  await assert.rejects(h.direct(), /** @param {any} err */ err => err.code === 'remote_store_unsupported')
  assert.deepEqual(await h.direct({ sweep: true }), [])
  assert.equal(h.claims, 0)
})

test('mastracode backfill: an unreadable mastra.db fails by kind and keeps the path out of every log', { skip: process.platform === 'win32' && 'chmod 0o000 does not make a file unreadable on win32' }, async () => {
  const h = await stage()
  h.w.close()
  await fs.chmod(h.dbPath, 0o000)
  try {
    await assert.rejects(h.direct({ sweep: true }),
      /** @param {any} err */ err => err.code === 'permission_denied' && !err.message.includes(h.dbPath))
    const failed = h.logs.find(record => record.message === 'mastracode.backfill.open_failed')
    assert.equal(failed?.fields?.error_kind, 'permission_denied')
    assert.ok(!JSON.stringify(h.logs).includes(h.dbPath), 'the path stays out of the plugin log')
    const { result, records } = await withLogRecords(() => h.run({ sweep: true }))
    assert.equal(result.ok, false)
    assert.ok(records.some(record => record.body === 'backfill.provider_error'))
    assert.ok(!JSON.stringify(records).includes(h.dbPath), 'the path stays out of the kernel log')
    assert.ok(!JSON.stringify(result).includes(h.dbPath), 'the path stays out of the run result')
  } finally {
    await fs.chmod(h.dbPath, 0o600)
  }
})

test('mastracode backfill: a dry run takes no scope guard and writes no watermark', async () => {
  const h = await stage()
  addThread(h.w, 't1', h.projectDir)
  addTurn(h.w, 't1', 'one')
  const result = await h.run({ sweep: true, dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.scanned, 1)
  assert.equal(h.claims, 0)
  assert.equal(h.committed.length, 0)
  assert.equal(readMastraWatermark(h.dir).db, null)
})
