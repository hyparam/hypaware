// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runGithubBackfill } from '../../hypaware-core/plugins-workspace/github/src/commands.js'
import { writeCursors } from '../../hypaware-core/plugins-workspace/github/src/cursors.js'
import { createLocalObservedReposIndex } from '../../hypaware-core/plugins-workspace/github/src/observed-repos.js'
import { setGithubRuntime } from '../../hypaware-core/plugins-workspace/github/src/runtime.js'
import { runCaptureTick } from '../../hypaware-core/plugins-workspace/github/src/tick.js'

/** @import { QueryStorageService } from '../../hypaware-core/plugins-workspace/github/src/types.d.ts' */

test('local session inventory is incremental, durable, narrow, and privacy-aware', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-observed-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  let phase = 0
  let discoveries = 0
  /** @type {Array<{ tablePath: string, since: unknown, includeLegacy: boolean | undefined, columns: string[] | undefined }>} */
  const reads = []
  const storage = /** @type {QueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      discoveries += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return [
        { dataset: 'ai_gateway_messages', path: '/cache/messages/a', epoch: 0, rowCount: phase === 0 ? 3 : 5, partition: {} },
        { dataset: 'other', path: '/cache/other', epoch: 0, rowCount: 1, partition: {} },
        { dataset: 'ai_gateway_messages', path: '/cache/messages/a', epoch: 0, rowCount: phase === 0 ? 3 : 5, partition: {} },
        { dataset: 'ai_gateway_messages', path: '/cache/messages/b', epoch: 0, rowCount: 4, partition: {} },
      ]
    },
    async *readRowsSince(tablePath, opts) {
      reads.push({ tablePath, since: opts.since, includeLegacy: opts.includeLegacy, columns: opts.columns })
      if (phase === 0 && tablePath.endsWith('/a')) {
        yield { row: { git_remote: 'git@github.com:Acme/Widgets.git' }, after: { v: 1, seq: '1' } }
        yield { row: { git_remote: 'https://gitlab.com/acme/not-github.git' }, after: { v: 1, seq: '2' } }
        yield { dropped: true, after: { v: 1, seq: '3' } }
      }
      if (phase === 0 && tablePath.endsWith('/b')) {
        yield { row: { git_remote: 'https://www.github.com/Beta/Tool/' }, after: { v: 1, seq: '4' } }
      }
      if (phase === 1 && tablePath.endsWith('/a')) {
        yield { row: { git_remote: 'https://github.com/acme/new-repo.git' }, after: { v: 1, seq: '5' } }
      }
    },
  }))

  const index = createLocalObservedReposIndex({ storage, stateDir })
  const [first, concurrent] = await Promise.all([index.list(), index.list()])
  assert.equal(discoveries, 1)
  assert.deepEqual(first, ['acme/widgets', 'beta/tool'])
  assert.deepEqual(concurrent, first)
  assert.equal(reads.length, 2)
  assert.ok(reads.every((read) => read.since === undefined && read.includeLegacy === true))
  assert.ok(reads.every((read) => JSON.stringify(read.columns) === JSON.stringify(['git_remote'])))

  const persisted = fs.readFileSync(path.join(stateDir, 'github-observed-repos.json'), 'utf8')
  assert.match(persisted, /acme\/widgets/)
  assert.match(persisted, /beta\/tool/)
  assert.doesNotMatch(persisted, /github\.com|gitlab\.com/)

  phase = 1
  reads.length = 0
  const resumed = await createLocalObservedReposIndex({ storage, stateDir }).list()
  assert.equal(reads.length, 1)
  assert.ok(reads[0].tablePath.endsWith('/a'))
  assert.deepEqual(reads[0].since, { v: 1, seq: '3' })
  assert.equal(reads[0].includeLegacy, false)
  assert.deepEqual(resumed, ['acme/new-repo', 'acme/widgets', 'beta/tool'])

  reads.length = 0
  const unchanged = await createLocalObservedReposIndex({ storage, stateDir }).list()
  assert.deepEqual(unchanged, resumed)
  assert.equal(reads.length, 0)
})

test('default capture tick uses local session evidence without GitHub enumeration', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-empty-tick-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  let observedReads = 0
  let viewerEnumerations = 0

  const report = await runCaptureTick(
    /** @type {any} */ ({
      stateDir,
      config: {
        ignore: [],
        token_env: 'GITHUB_TOKEN',
        poll_interval: '24h',
        inventory: 'session_repos',
      },
      observedRepos: {
        async list() {
          observedReads += 1
          return []
        },
      },
      clientFactory: () => ({
        async listViewerRepos() { viewerEnumerations += 1; return ['outside/not-used'] },
      }),
      storage: {
        cacheTablePath() { return '/cache/github_events' },
        async appendRows() { throw new Error('empty evidence must not append') },
      },
      log: { error() {}, info() {} },
    }),
    { mode: 'backfill' },
  )

  assert.equal(observedReads, 1)
  assert.equal(viewerEnumerations, 0)
  assert.deepEqual(report, { repos: 0, events: 0, requests: 0, pending: false, errors: [] })
})

// ---------------------------------------------------------------------------
// LLP 0367: revalidation against the current withholding policy.
// ---------------------------------------------------------------------------

/**
 * Evidence-partition fake honoring `since` continuations, with a mutable
 * policy fingerprint and a per-policy withholding rule, so the tests can flip
 * the policy and watch the sidecar contract.
 *
 * @param {{ partitions: () => Array<{ path: string, epoch: number, rowCount: number, rows: Array<{ seq: number, remote: string }> }>, policy: () => string, withheld?: (remote: string) => boolean }} args
 */
function evidenceStorage({ partitions, policy, withheld }) {
  /** @type {Array<{ tablePath: string, since: unknown, includeLegacy: boolean | undefined }>} */
  const reads = []
  let yielded = 0
  const storage = /** @type {QueryStorageService} */ (/** @type {unknown} */ ({
    exportPolicyFingerprint() { return policy() },
    async discoverCachePartitions() {
      return partitions().map((p) => ({ dataset: 'ai_gateway_messages', path: p.path, epoch: p.epoch, rowCount: p.rowCount, partition: {} }))
    },
    async *readRowsSince(tablePath, opts) {
      reads.push({ tablePath, since: opts.since, includeLegacy: opts.includeLegacy })
      const since = opts.since ? Number(/** @type {{ seq: string }} */ (opts.since).seq) : 0
      const part = partitions().find((p) => p.path === tablePath)
      for (const row of part?.rows ?? []) {
        if (row.seq <= since) continue
        yielded += 1
        const after = { v: 1, seq: String(row.seq) }
        if (withheld?.(row.remote)) yield { dropped: true, after }
        else yield { row: { git_remote: row.remote }, after }
      }
    },
  }))
  return { storage, reads, yieldedCount: () => yielded }
}

/** @returns {{ log: any, events: Array<{ name: string, fields: Record<string, unknown> }> }} */
function captureLog() {
  /** @type {Array<{ name: string, fields: Record<string, unknown> }>} */
  const events = []
  return { log: { info(/** @type {string} */ name, /** @type {Record<string, unknown>} */ fields) { events.push({ name, fields }) } }, events }
}

test('a policy change revalidates under a bounded resumable budget, conservatively, and retires the unevidenced repo', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-revalidate-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  let policy = 'policy-a'
  const partitions = () => [
    { path: '/cache/messages/a', epoch: 0, rowCount: 3, rows: [
      { seq: 1, remote: 'https://github.com/acme/widgets.git' },
      { seq: 2, remote: 'https://github.com/acme/widgets.git' },
      { seq: 3, remote: 'https://github.com/acme/widgets.git' },
    ] },
    { path: '/cache/messages/b', epoch: 0, rowCount: 2, rows: [
      { seq: 4, remote: 'https://github.com/beta/tool.git' },
      { seq: 5, remote: 'https://github.com/beta/tool.git' },
    ] },
  ]
  const { storage, reads } = evidenceStorage({
    partitions,
    policy: () => policy,
    withheld: (remote) => policy === 'policy-b' && remote.includes('acme'),
  })
  const { log, events } = captureLog()
  const make = () => createLocalObservedReposIndex({ storage, stateDir, log, revalidationRowBudget: 2 })

  // Admission under policy-a: both repos evidenced.
  assert.deepEqual(await make().list(), ['acme/widgets', 'beta/tool'])

  // The user's withholding policy changes: acme evidence is now withheld.
  policy = 'policy-b'

  // Slice 1: exactly the 2-row budget, nothing confirmed yet, so the
  // conservative inventory is empty and bounded work remains.
  reads.length = 0
  const during = make()
  assert.deepEqual(await during.list(), [])
  assert.equal(during.revalidationPending(), true)
  const started = events.find((e) => e.name === 'github.observed_repos_revalidation_started')
  assert.equal(started?.fields.trigger, 'policy_changed')
  assert.equal(started?.fields.repos, 2)
  const progress = events.find((e) => e.name === 'github.observed_repos_revalidation_progress')
  assert.deepEqual(
    { rows_read: progress?.fields.rows_read, row_budget: progress?.fields.row_budget, partitions_done: progress?.fields.partitions_done, partitions_total: progress?.fields.partitions_total },
    { rows_read: 2, row_budget: 2, partitions_done: 0, partitions_total: 2 },
  )

  // Slice 2 resumes from the persisted mid-partition continuation (a fresh
  // instance, as after a daemon restart), finishes partition a, starts b.
  reads.length = 0
  const resumed = make()
  assert.deepEqual(await resumed.list(), ['beta/tool'])
  assert.equal(resumed.revalidationPending(), true)
  assert.deepEqual(reads[0], { tablePath: '/cache/messages/a', since: { v: 1, seq: '2' }, includeLegacy: false })

  // Slice 3 completes the pass and swaps: the repo with no remaining
  // permitted evidence is retired; the evidenced one stays.
  const finished = make()
  assert.deepEqual(await finished.list(), ['beta/tool'])
  assert.equal(finished.revalidationPending(), false)
  const completed = events.find((e) => e.name === 'github.observed_repos_revalidation_completed')
  assert.deepEqual(
    { repos_confirmed: completed?.fields.repos_confirmed, repos_retired: completed?.fields.repos_retired, status: completed?.fields.status },
    { repos_confirmed: 1, repos_retired: 1, status: 'ok' },
  )
  for (const event of events) {
    assert.doesNotMatch(JSON.stringify(event.fields), /acme|beta|widgets|tool/, 'telemetry carries counts, never repository names')
  }

  // The tick after: fingerprint and versions match, zero history reads.
  reads.length = 0
  assert.deepEqual(await make().list(), ['beta/tool'])
  assert.equal(reads.length, 0)
})

test('a purged evidence partition (row-count regression) revalidates and retires the purged repo', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-purge-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  let purged = false
  const partitions = () => [
    { path: '/cache/messages/a', epoch: 0, rowCount: purged ? 1 : 2, rows: purged
      ? [{ seq: 2, remote: 'https://github.com/beta/tool.git' }]
      : [
        { seq: 1, remote: 'https://github.com/acme/widgets.git' },
        { seq: 2, remote: 'https://github.com/beta/tool.git' },
      ] },
  ]
  const { storage } = evidenceStorage({ partitions, policy: () => 'policy-a' })
  const { log, events } = captureLog()
  const make = () => createLocalObservedReposIndex({ storage, stateDir, log })

  assert.deepEqual(await make().list(), ['acme/widgets', 'beta/tool'])
  purged = true
  assert.deepEqual(await make().list(), ['beta/tool'])
  const started = events.find((e) => e.name === 'github.observed_repos_revalidation_started')
  assert.equal(started?.fields.trigger, 'partition_regressed')
})

test('the age backstop revalidates old derivations and a fresh one stays incremental', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-stale-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  const t0 = Date.parse('2026-09-03T00:00:00Z')
  const day = 24 * 60 * 60_000
  const partitions = () => [
    { path: '/cache/messages/a', epoch: 0, rowCount: 1, rows: [{ seq: 1, remote: 'https://github.com/acme/widgets.git' }] },
  ]
  const { storage, reads } = evidenceStorage({ partitions, policy: () => 'policy-a' })
  const { log, events } = captureLog()

  await createLocalObservedReposIndex({ storage, stateDir, log, now: () => t0 }).list()

  // One day later: fresh, incremental, no history reads.
  reads.length = 0
  await createLocalObservedReposIndex({ storage, stateDir, log, now: () => t0 + day }).list()
  assert.equal(reads.length, 0)
  assert.equal(events.filter((e) => e.name === 'github.observed_repos_revalidation_started').length, 0)

  // Eight days later: the backstop fires and re-derives (nothing retired).
  const late = createLocalObservedReposIndex({ storage, stateDir, log, now: () => t0 + 8 * day })
  assert.deepEqual(await late.list(), ['acme/widgets'])
  assert.equal(late.revalidationPending(), false)
  const started = events.find((e) => e.name === 'github.observed_repos_revalidation_started')
  assert.equal(started?.fields.trigger, 'stale')
  const completed = events.find((e) => e.name === 'github.observed_repos_revalidation_completed')
  assert.equal(completed?.fields.repos_retired, 0)
})

test('retained state is bounded by the distinct inventory, not transcript-row count, and the default budget binds', async (t) => {
  const remotes = ['https://github.com/acme/widgets.git', 'https://github.com/beta/tool.git', 'https://github.com/gamma/lib.git']
  /** @param {number} rowCount @returns {() => Array<{ path: string, epoch: number, rowCount: number, rows: Iterable<{ seq: number, remote: string }> }>} */
  const bigPartitions = (rowCount) => () => [
    { path: '/cache/messages/a', epoch: 0, rowCount, rows: (function* () {
      for (let i = 1; i <= rowCount; i += 1) yield { seq: i, remote: remotes[i % remotes.length] }
    })() },
  ]

  /** @param {number} rowCount */
  async function buildState(rowCount) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-bounded-'))
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
    const { storage } = evidenceStorage({ partitions: /** @type {any} */ (bigPartitions(rowCount)), policy: () => 'policy-a' })
    const repos = await createLocalObservedReposIndex({ storage, stateDir }).list()
    return { stateDir, storage, repos, size: fs.statSync(path.join(stateDir, 'github-observed-repos.json')).size }
  }

  const small = await buildState(1_000)
  const large = await buildState(100_000)
  assert.deepEqual(large.repos, ['acme/widgets', 'beta/tool', 'gamma/lib'])
  assert.ok(large.size < 2048, `sidecar stays small (${large.size} bytes)`)
  assert.ok(Math.abs(large.size - small.size) < 32, '100x the transcript rows adds no retained state beyond cursor digits')

  // A revalidation over the 100k-row history respects the default 50k-row
  // budget: one slice leaves bounded work pending, the next completes, and
  // the mid-pass record still scales with the inventory, not the rows.
  const { storage } = evidenceStorage({ partitions: /** @type {any} */ (bigPartitions(100_000)), policy: () => 'policy-b' })
  const make = () => createLocalObservedReposIndex({ storage, stateDir: large.stateDir })
  let index = make()
  await index.list()
  assert.equal(index.revalidationPending(), true, 'the 50,000-row default budget leaves a 100,000-row pass pending')
  assert.ok(fs.statSync(path.join(large.stateDir, 'github-observed-repos.json')).size < 2048, 'the mid-pass record scales with the inventory, not the rows')
  let slices = 1
  while (index.revalidationPending() && slices < 5) {
    index = make()
    await index.list()
    slices += 1
  }
  assert.deepEqual(await index.list(), ['acme/widgets', 'beta/tool', 'gamma/lib'])
  assert.equal(index.revalidationPending(), false)
  assert.ok(slices >= 2 && slices < 5, `resumable across ticks (${slices} slices)`)
  const final = fs.readFileSync(path.join(large.stateDir, 'github-observed-repos.json'), 'utf8')
  assert.doesNotMatch(final, /revalidation/)
  assert.ok(final.length < 2048)
})

test('lastKnown() serves the last persisted inventory when a derivation throws part-way through', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-last-known-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  // The failure path in `tick.js` reads `lastKnown()` precisely because the
  // read it would rather have made just threw, so the whole fix rests on
  // `update()` swapping state on success alone. Assert that against the real
  // index rather than a stub: here the first partition of the failing pass
  // completes and observes a new repository before the second one dies, so a
  // derivation that committed its progress partition by partition would
  // publish `gamma/lib` and be caught here.
  let failing = false
  const storage = /** @type {QueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      return [
        { dataset: 'ai_gateway_messages', path: '/cache/messages/a', epoch: 0, rowCount: failing ? 9 : 3, partition: {} },
        { dataset: 'ai_gateway_messages', path: '/cache/messages/b', epoch: 0, rowCount: failing ? 7 : 2, partition: {} },
      ]
    },
    async *readRowsSince(/** @type {string} */ tablePath) {
      if (!failing) {
        if (tablePath.endsWith('/a')) yield { row: { git_remote: 'https://github.com/Acme/Widgets.git' }, after: { v: 1, seq: '1' } }
        return
      }
      if (tablePath.endsWith('/a')) {
        yield { row: { git_remote: 'https://github.com/gamma/lib.git' }, after: { v: 1, seq: '2' } }
        return
      }
      throw new Error('cache partition unreadable')
    },
  }))

  const index = createLocalObservedReposIndex({ storage, stateDir })
  assert.deepEqual(await index.list(), ['acme/widgets'])

  failing = true
  await assert.rejects(index.list(), /cache partition unreadable/)

  assert.deepEqual(
    index.lastKnown(),
    ['acme/widgets'],
    'a thrown derivation leaves the inventory the last successful one derived, not a partial or empty set',
  )
  const persisted = fs.readFileSync(path.join(stateDir, 'github-observed-repos.json'), 'utf8')
  assert.doesNotMatch(persisted, /gamma\/lib/, 'a derivation that threw persists nothing the pass had already read')
  assert.deepEqual(
    createLocalObservedReposIndex({ storage, stateDir }).lastKnown(),
    ['acme/widgets'],
    'lastKnown() reads persisted state without deriving, so it never triggers the read that failed',
  )
})

test('an incomplete revalidation surfaces as bounded pending work on the capture tick', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-pending-tick-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  const report = await runCaptureTick(
    /** @type {any} */ ({
      stateDir,
      config: { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '24h', inventory: 'session_repos' },
      observedRepos: {
        async list() { return [] },
        revalidationPending() { return true },
      },
      clientFactory: () => ({
        async listViewerRepos() { throw new Error('conservative inventory must not enumerate') },
      }),
      storage: {
        cacheTablePath() { return '/cache/github_events' },
        async appendRows() { throw new Error('empty confirmed inventory must not append') },
      },
      log: { error() {}, info() {} },
    }),
    { mode: 'poll' },
  )
  assert.equal(report.pending, true, 'revalidation work remaining rides the backlog cadence')
  assert.equal(report.repos, 0)
})

/**
 * A `session_repos` runtime whose local inventory read fails. Nothing past
 * that read may run: an unresolved inventory must neither enumerate GitHub nor
 * append rows.
 *
 * @param {string} stateDir
 * @param {unknown} err
 * @param {(name: string, attrs: any) => void} [onError]
 */
function failingInventoryRuntime(stateDir, err, onError = () => {}) {
  return /** @type {any} */ ({
    stateDir,
    config: { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '24h', inventory: 'session_repos' },
    observedRepos: {
      async list() { throw err },
      lastKnown() { return ['acme/widgets'] },
      revalidationPending() { return false },
    },
    clientFactory: () => ({
      async listViewerRepos() { throw new Error('conservative inventory must not enumerate') },
    }),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() { throw new Error('an unresolved inventory must not append') },
    },
    log: { error: onError, info() {} },
  })
}

test('a failed session_repos inventory read is recorded, not thrown out of the tick', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-failed-tick-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const err = Object.assign(new Error('cache partition unreadable'), { hypErrorKind: 'github_observed_repos_failed' })
  /** @type {Array<{ name: string, attrs: any }>} */
  const logged = []

  const report = await runCaptureTick(
    failingInventoryRuntime(stateDir, err, (name, attrs) => logged.push({ name, attrs })),
    { mode: 'poll' },
  )

  assert.equal(report.repos, 0)
  assert.equal(report.events, 0)
  assert.equal(report.errors.length, 1, 'the inventory failure is reported as a tick error')
  assert.match(report.errors[0].error, /cache partition unreadable/)
  assert.equal(logged[0].name, 'github.inventory_resolve_failed')
  assert.equal(logged[0].attrs.error_kind, 'github_observed_repos_failed')
  assert.equal(
    report.pending,
    false,
    'an error is not bounded backlog: pending drives the poll cadence (LLP 0360#cadence)',
  )
})

test('a failed session_repos inventory read does not retire backlog the cursors still hold', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-failed-tick-backlog-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  // A prior tick ran out of budget mid-repository and saved its continuation.
  writeCursors(stateDir, { schema_version: 1, repos: { 'acme/widgets': { work: { mode: 'poll', phase: 'issues' } } } })

  const report = await runCaptureTick(
    failingInventoryRuntime(stateDir, new Error('cache partition unreadable')),
    { mode: 'poll' },
  )

  assert.equal(report.errors.length, 1)
  assert.equal(
    report.pending,
    true,
    'clearing pending here would push a saved continuation from the backlog cadence back to a full poll interval',
  )
})

test('a failed session_repos inventory read counts only continuations the live inventory still holds', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-failed-tick-stale-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  // Nothing prunes the cursor sidecar, so a repository that left the inventory
  // keeps the continuation its last tick saved: `acme/retired` contracted out
  // of the session evidence, `acme/ignored` was added to `ignore[]`. Neither
  // can be captured again, so neither is backlog a later tick could retire.
  writeCursors(stateDir, {
    schema_version: 1,
    repos: {
      'acme/retired': { work: { mode: 'poll', phase: 'issues' } },
      'acme/ignored': { work: { mode: 'poll', phase: 'pulls' } },
    },
  })
  const runtime = failingInventoryRuntime(stateDir, new Error('cache partition unreadable'))
  runtime.config.ignore = ['Acme/Ignored']
  runtime.observedRepos.lastKnown = () => ['acme/ignored', 'acme/widgets']

  const report = await runCaptureTick(runtime, { mode: 'poll' })

  assert.equal(report.errors.length, 1)
  assert.equal(
    report.pending,
    false,
    'a continuation no selectable repository holds would pin a failing 24h source to the backlog cadence forever',
  )
})

test('a failed session_repos inventory read reports no backlog when the inventory is empty', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-failed-tick-empty-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  // A missing, unreadable, or older-schema observed-repos sidecar derives an
  // empty inventory. Reporting the cursors anyway is the pin issue #1316
  // removed: no repository the next tick could select holds that continuation,
  // so nothing would ever retire the backlog it claims.
  writeCursors(stateDir, { schema_version: 1, repos: { 'acme/widgets': { work: { mode: 'poll', phase: 'issues' } } } })
  const runtime = failingInventoryRuntime(stateDir, new Error('cache partition unreadable'))
  runtime.observedRepos.lastKnown = () => []

  const report = await runCaptureTick(runtime, { mode: 'poll' })

  assert.equal(report.errors.length, 1)
  assert.equal(
    report.pending,
    false,
    'an empty inventory selects no repository, so no saved continuation is backlog this source can retire',
  )
})

test('a failed session_repos inventory read keeps an unfinished revalidation on the backlog cadence', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-failed-tick-reval-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  // A revalidation an earlier tick persisted is still reported after this
  // tick's `list()` throws: `update()` swaps its state on success alone, so the
  // failed call leaves that earlier pass exactly as it found it. (A pass this
  // call started is discarded instead, and reports nothing.) No cursor holds
  // work, so `revalidationPending()` is the only thing keeping this pending.
  const runtime = failingInventoryRuntime(stateDir, new Error('cache partition unreadable'))
  runtime.observedRepos.revalidationPending = () => true

  const report = await runCaptureTick(runtime, { mode: 'poll' })

  assert.equal(report.errors.length, 1)
  assert.equal(
    report.pending,
    true,
    'an unfinished revalidation is bounded work the failed tick did not retire (LLP 0361#budget)',
  )
})

test('hyp github backfill reports the inventory failure without contradicting it', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-backfill-cli-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  setGithubRuntime(failingInventoryRuntime(stateDir, new Error('cache partition unreadable')))
  let out = ''
  let err = ''
  const ctx = /** @type {any} */ ({
    stdout: { write(/** @type {string} */ s) { out += s } },
    stderr: { write(/** @type {string} */ s) { err += s } },
  })

  const code = await runGithubBackfill(['acme/widgets'], ctx)

  assert.equal(code, 1, 'an unresolved inventory is a failed backfill')
  assert.match(err, /! \(inventory\): cache partition unreadable/, 'the real cause is reported')
  assert.doesNotMatch(
    err,
    /active repository inventory/,
    'the inventory never resolved, so blaming the configured selection would be a false claim',
  )
  assert.doesNotMatch(
    out,
    /hyp graph project/,
    'nothing was captured, so the next-step advice would dress a failure up as progress',
  )
})
