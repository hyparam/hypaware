// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { setGithubRuntime } from '../../hypaware-core/plugins-workspace/github/src/runtime.js'
import { BACKLOG_RETRY_MS, nextCaptureDelay, startGithubSource } from '../../hypaware-core/plugins-workspace/github/src/source.js'
import { emptyGraph, fakeClient, silentLog } from './github-fake-client.js'
import { CURSOR_ERROR_REPO, runCaptureTick } from '../../hypaware-core/plugins-workspace/github/src/tick.js'
import { readCursors, writeCursors } from '../../hypaware-core/plugins-workspace/github/src/cursors.js'
import { runGithubBackfill, runGithubSync } from '../../hypaware-core/plugins-workspace/github/src/commands.js'

/** @import { TestContext } from 'node:test' */
/** @import { StartedSource } from '../../hypaware-core/plugins-workspace/github/src/types.js' */

test('unfinished work resumes on the bounded backlog cadence', () => {
  assert.equal(nextCaptureDelay(24 * 60 * 60_000, true), BACKLOG_RETRY_MS)
  assert.equal(nextCaptureDelay(5 * 60_000, true), 5 * 60_000)
  assert.equal(nextCaptureDelay(24 * 60 * 60_000, false), 24 * 60 * 60_000)
})

test('source runs shortly after boot and reports structured completion-relative cadence', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-source-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  /** @type {Array<{ name: string, attrs: Record<string, unknown> }>} */
  const logs = []
  const cadenceMs = 10
  // Hold the tick open for several cadences, so a schedule taken from the tick's
  // start would land measurably earlier than one taken from its completion. The
  // hold is a lower bound: a slower machine only holds longer, and every
  // assertion below reads the timestamps the tick itself reported.
  const holdMs = cadenceMs * 5
  /** @type {() => void} */
  let noteTickStarted = () => {}
  const tickStarted = new Promise((resolve) => { noteTickStarted = () => resolve(undefined) })
  /** @type {() => void} */
  let noteTickCompleted = () => {}
  const tickCompleted = new Promise((resolve) => { noteTickCompleted = () => resolve(undefined) })
  let completedAt = 0
  // A backstop on the two waits below, never the margin the sampling reads: a
  // passing run settles both in a few milliseconds. Without it a source that
  // stops ticking wedges the runner instead of failing, because only the log
  // callback can settle those promises and the keep-alive holds the loop open
  // forever. It also keeps the `shortly after boot` half of this test's name
  // honest: the first tick is due after `min(interval, 5 minutes)`, 10ms here,
  // so a regression that defers it past this deadline reds.
  const waitDeadlineMs = 1000
  /** @param {Promise<unknown>} promise @param {string} what */
  function withDeadline(promise, what) {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${waitDeadlineMs}ms`)), waitDeadlineMs)
    })
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
  }

  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config: {
      ignore: [],
      token_env: 'GITHUB_TOKEN',
      poll_interval: `${cadenceMs}ms`,
      inventory: 'session_repos',
    },
    observedRepos: {
      async list() {
        await new Promise((resolve) => setTimeout(resolve, holdMs))
        return []
      },
    },
    clientFactory: () => fakeClient({}),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() { throw new Error('empty inventory must not append') },
    },
    log: {
      info(name, attrs) {
        logs.push({ name, attrs })
        if (name === 'github.poll_tick_started') noteTickStarted()
        if (name === 'github.poll_tick_completed') {
          completedAt = Date.now()
          noteTickCompleted()
        }
      },
      error(name, attrs) { logs.push({ name, attrs }) },
    },
  }))

  // The source unrefs its own timers, so nothing else keeps the event loop alive
  // while the test waits on a tick. This interval does; its period is a
  // keep-alive, never a deadline the sampling races.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))

  const source = await startGithubSource()
  assert.ok(source.status)

  // A tick in flight reports no next tick: the schedule is taken when the tick
  // completes, so until then there is nothing to report.
  await withDeadline(tickStarted, 'github.poll_tick_started')
  const duringTick = await source.status()
  assert.equal(duringTick.details?.in_flight, true)
  assert.equal(duringTick.details?.next_tick_at, null)

  await withDeadline(tickCompleted, 'github.poll_tick_completed')
  // The reschedule runs in the tick promise's `finally` and the next tick is a
  // timer, so `setImmediate` lands after every pending microtask and before the
  // next timers phase. That samples the gap between two ticks by event-loop
  // phase rather than on a wall-clock margin.
  await new Promise((resolve) => setImmediate(resolve))
  const sampledAt = Date.now()
  const status = await source.status()
  await source.stop()

  assert.ok(logs.some((entry) => entry.name === 'github.poll_tick_started'))
  assert.ok(logs.some((entry) => entry.name === 'github.poll_tick_completed'))
  assert.equal(status.state, 'ready')
  assert.equal(status.details?.cadence, `${cadenceMs}ms`)
  assert.equal(status.details?.inventory, 'session_repos')
  assert.equal(status.details?.in_flight, false)
  assert.equal(typeof status.details?.next_tick_at, 'string')

  const startedAt = Date.parse(String(status.details?.last_tick_at))
  const nextTickAt = Date.parse(String(status.details?.next_tick_at))
  const heldMs = completedAt - startedAt
  assert.ok(heldMs >= cadenceMs * 2, `the tick ran ${heldMs}ms, expected at least ${cadenceMs * 2}ms to tell the two schedules apart`)
  // Completion-relative: one cadence after the tick finished, which for a tick
  // held this long is well past one cadence after it started. Both bounds are
  // exact rather than tolerant, since the schedule was taken between the
  // completion and the sample: one cadence after each of those two instants
  // brackets it however slow the machine running this is.
  assert.ok(nextTickAt >= completedAt + cadenceMs,
    `next tick is ${nextTickAt - completedAt}ms after completion, expected at least ${cadenceMs}ms`)
  assert.ok(nextTickAt <= sampledAt + cadenceMs,
    `next tick is ${nextTickAt - sampledAt}ms after the sample, expected at most ${cadenceMs}ms`)

  assert.ok(logs.every((entry) => !JSON.stringify(entry).includes('GITHUB_TOKEN')))
  assert.ok(logs.some((entry) => entry.name === 'github.poll_tick_completed'
    && entry.attrs.operation === 'poll'
    && entry.attrs.repos === 0
    && entry.attrs.events === 0))
})

test('status reports the repositories the last tick reached, and the inventory it drew them from', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-status-budget-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  // A three-repo inventory with room for exactly one request: the tick reaches
  // the first repository and the budget stops it there.
  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config: {
      ignore: [],
      token_env: 'GITHUB_TOKEN',
      poll_interval: '10ms',
      inventory: 'session_repos',
    },
    captureRequestLimit: 1,
    observedRepos: { async list() { return ['o/a', 'o/b', 'o/c'] } },
    clientFactory: () => fakeClient({
      repos: { 'o/a': { issues: [{ number: 1, state: 'open', created_at: '2026-01-01T00:00:00Z', user: { login: 'a' } }] } },
    }),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() {},
    },
    log: { info() {}, error() {} },
  }))

  const source = await startGithubSource()
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.ok(source.status)
  const status = await source.status()
  await source.stop()

  assert.equal(status.details?.last_repo_count, 1, 'a budget-stopped tick reached one repository')
  assert.equal(status.details?.last_inventory_repos, 3, 'the inventory it was drawn from stays visible beside it')
  assert.equal(status.details?.backlog_pending, true)
})

test('source never overlaps slow ticks', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-no-overlap-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  let active = 0
  let maxActive = 0
  let scans = 0
  /** @type {() => void} */
  let noteSecondScan = () => {}
  const secondScanStarted = new Promise((resolve) => {
    noteSecondScan = () => resolve(undefined)
  })

  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config: {
      ignore: [],
      token_env: 'GITHUB_TOKEN',
      poll_interval: '5ms',
      inventory: 'session_repos',
    },
    observedRepos: {
      async list() {
        scans += 1
        if (scans === 2) noteSecondScan()
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 15))
        active -= 1
        return []
      },
    },
    clientFactory: () => fakeClient({}),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() {},
    },
    log: { info() {}, error() {} },
  }))

  const source = await startGithubSource()
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeout
  try {
    await Promise.race([
      secondScanStarted,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('second GitHub scan did not start')), 1000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  await source.stop()

  assert.ok(scans >= 2)
  assert.equal(maxActive, 1)
})

// @ref LLP 0392#retry [tests]: capture cursors survive projection failure; idle ticks retry without re-appending
test('automatic projection catches up, skips idle ticks, and retries failure without rolling back capture', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-project-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const issues = []
  const rows = []
  const projectedSources = []
  const logs = []
  let fail = false
  const runtime = /** @type {any} */ ({
    stateDir,
    config: { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '24h', inventory: 'session_repos' },
    observedRepos: { async list() { return ['o/r'] } },
    clientFactory: () => fakeClient({ repos: { 'o/r': { issues } } }),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows(_path, _columns, batch) { rows.push(...batch) },
    },
    graph: {
      async project(source) {
        projectedSources.push(source)
        if (fail) {
          assert.equal(readCursors(stateDir).repos['o/r'].since?.issues, '2026-09-08T00:00:00Z')
          throw new Error('graph storage unavailable')
        }
        return { nodes: 1, edges: 1, nodesWritten: 1, edgesWritten: 1 }
      },
    },
    log: {
      info(name, attrs) { logs.push({ name, attrs }) },
      error(name, attrs) { logs.push({ name, attrs }) },
    },
  })

  await runCaptureTick(runtime, { mode: 'poll' })
  assert.deepEqual(projectedSources, ['github_events'], 'startup catches up existing durable events, even with no new capture')
  await runCaptureTick(runtime, { mode: 'poll' })
  assert.equal(projectedSources.length, 1, 'an idle tick does not scan graph history again')

  issues.push({ number: 1, created_at: '2026-09-08T00:00:00Z', state: 'open' })
  fail = true
  const failed = await runCaptureTick(runtime, { mode: 'poll' })
  assert.equal(failed.events, 1)
  assert.deepEqual(failed.errors, [{ repo: '(graph)', error: 'graph storage unavailable' }])
  assert.equal(failed.pending, false, 'projection failure does not create a fast retry loop')
  assert.equal(rows.length, 1)
  assert.ok(logs.some((entry) => entry.name === 'github.projection_failed'
    && entry.attrs.error_kind === 'github_projection_failed'))

  fail = false
  const retried = await runCaptureTick(runtime, { mode: 'poll' })
  assert.equal(retried.events, 0)
  assert.deepEqual(retried.errors, [])
  assert.equal(projectedSources.length, 3, 'projection retries even though capture advanced its cursor')
  assert.equal(rows.length, 1, 'projection retry does not repeat captured rows')
  await runCaptureTick(runtime, { mode: 'poll' })
  assert.equal(projectedSources.length, 3, 'success clears the pending retry')

  // A fresh activation forgets only the idle optimization, so a crash between
  // capture and projection cannot strand durable events.
  const restarted = { ...runtime, projectionNeeded: undefined }
  await runCaptureTick(restarted, { mode: 'poll' })
  assert.equal(projectedSources.length, 4)

  fail = true
  setGithubRuntime(runtime)
  let stderr = ''
  const code = await runGithubBackfill([], /** @type {any} */ ({
    stdout: { write() {} },
    stderr: { write(text) { stderr += text } },
  }))
  assert.equal(code, 1, 'backfill reports projection failure as a nonzero exit')
  assert.match(stderr, /\(graph\): graph storage unavailable/)
})

test('daemon stop waits for projection and status reports its failure', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-project-stop-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  let release = () => {}
  let began = () => {}
  const started = new Promise((resolve) => { began = () => resolve(undefined) })
  const blocked = new Promise((resolve) => { release = () => resolve(undefined) })
  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    config: { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '5ms', inventory: 'session_repos' },
    observedRepos: { async list() { return [] } },
    clientFactory: () => fakeClient({}),
    storage: { cacheTablePath() { return '/cache/github_events' } },
    graph: {
      async project() {
        began()
        await blocked
        throw new Error('projection refused')
      },
    },
    log: { info() {}, error() {} },
  }))
  const source = await startGithubSource()
  const timeout = setTimeout(began, 1000)
  t.after(() => clearTimeout(timeout))
  await started
  assert.equal((await source.status?.())?.details?.in_flight, true)
  let stopped = false
  const stopping = source.stop().then(() => { stopped = true })
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(stopped, false)
  release()
  await stopping
  const status = await source.status?.()
  assert.equal(status?.lastError, 'projection refused')
  assert.equal(status?.details?.last_success_at, null)
})

// @ref LLP 0409#one-time-imports [tests]: an authorization another process staged reaches the daemon's own cadence
test('an authorization another process staged puts the next tick on the backlog cadence', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-staged-backlog-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const config = { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '10ms', inventory: 'session_repos' }
  let staged = false

  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config,
    observedRepos: {
      async list() {
        // `hyp github backfill o/r` commits its authorization after this tick
        // read the sidecar, so the tick's own result cannot carry it and the
        // closing write adopts it as durable work the daemon never attempted.
        if (!staged) {
          staged = true
          await writeCursors(stateDir, /** @type {any} */ ({
            schema_version: 1,
            repos: { 'o/r': { one_time_import: true, work: { mode: 'backfill', phase: 'issues' } } },
          }))
        }
        return []
      },
    },
    clientFactory: () => fakeClient({}),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() {},
    },
    log: { info() {}, error() {} },
  }))

  const source = await startGithubSource()
  // The first delay was already scheduled off the 10ms interval, so widening
  // the interval now leaves the next scheduling decision as the only thing
  // that can tell the backlog cadence from a full poll interval.
  config.poll_interval = '30m'
  assert.ok(source.status)
  /** @type {any} */
  let details = {}
  for (let i = 0; i < 200 && !(details.last_tick_at && details.next_tick_at && details.in_flight === false); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    details = (await source.status()).details ?? {}
  }
  await source.stop()

  assert.equal(readCursors(stateDir).repos['o/r']?.one_time_import, true, 'the authorization is durable on disk')
  assert.ok(details.next_tick_at, 'the tick never settled, so there is no scheduling decision to read')
  assert.equal(details.backlog_pending, true, 'staged work another process wrote is backlog the daemon knows about')
  const delayMs = Date.parse(/** @type {string} */ (details.next_tick_at)) - Date.parse(/** @type {string} */ (details.last_tick_at))
  assert.ok(Math.abs(delayMs - BACKLOG_RETRY_MS) < 30_000, `next tick scheduled in ${delayMs}ms, not the backlog cadence`)
})

/**
 * Point the plugin's state dir below a regular file, so every write to the
 * cursor sidecar fails with ENOTDIR while the capture itself is untouched.
 *
 * @param {TestContext} t
 * @returns {string}
 */
function unwritableStateDir(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-cursor-write-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const blocker = path.join(base, 'not-a-directory')
  fs.writeFileSync(blocker, '')
  return path.join(blocker, 'state')
}

test('a failing closing cursor write is reported without discarding the counts the tick captured', async (t) => {
  const stateDir = unwritableStateDir(t)
  const rows = []
  /** @type {Array<{ name: string, attrs: Record<string, unknown> }>} */
  const logs = []
  const runtime = /** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config: { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '24h', inventory: 'session_repos' },
    observedRepos: { async list() { return ['o/r'] } },
    clientFactory: () => fakeClient({ repos: { 'o/r': { issues: [{ number: 1, created_at: '2026-09-08T00:00:00Z', state: 'open' }] } } }),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows(_path, _columns, batch) { rows.push(...batch) },
    },
    log: {
      info(name, attrs) { logs.push({ name, attrs }) },
      error(name, attrs) { logs.push({ name, attrs }) },
    },
  })

  const result = await runCaptureTick(runtime, { mode: 'poll' })
  assert.equal(result.events, 1, 'the row this tick appended is still counted')
  assert.equal(rows.length, 1)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].repo, CURSOR_ERROR_REPO)
  assert.match(result.errors[0].error, /ENOTDIR/)
  assert.ok(logs.some((entry) => entry.name === 'github.cursor_write_failed'
    && entry.attrs.error_kind === 'github_cursor_write_failed'))

  setGithubRuntime(runtime)
  let stdout = ''
  let stderr = ''
  const code = await runGithubSync([], /** @type {any} */ ({
    stdout: { write(text) { stdout += text } },
    stderr: { write(text) { stderr += text } },
  }))
  assert.equal(code, 1, 'the persistence failure still fails the command')
  assert.match(stdout, /github sync: 1 event\(s\) across 1 repo\(s\)/)
  assert.match(stderr, /\(cursors\): .*ENOTDIR/)
})

test('a capture that throws keeps its own error, not the closing write failure', async (t) => {
  const stateDir = unwritableStateDir(t)
  const runtime = /** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config: { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '24h', inventory: 'all_visible' },
    observedRepos: { async list() { return [] } },
    clientFactory: () => ({
      ...fakeClient({}),
      async listViewerRepos() { throw new Error('inventory refused') },
    }),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() { throw new Error('nothing to append') },
    },
    log: silentLog,
  })

  await assert.rejects(runCaptureTick(runtime, { mode: 'poll' }), /inventory refused/)
})

// @ref LLP 0360#cadence [tests]: a source whose ticks keep throwing retries on the ordinary cadence, not the backlog one
test('a tick that throws gives up the backlog cadence instead of latching it', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-backlog-latch-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const config = { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '10ms', inventory: 'all_visible' }
  let inventoryCalls = 0
  /** Releases for the throwing ticks, so a failed assertion never leaves one hung. @type {Array<() => void>} */
  const held = []
  let released = 0
  t.after(() => { for (const release of held) release() })

  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config,
    observedRepos: { async list() { return [] } },
    clientFactory: () => ({
      ...fakeClient({}),
      async listViewerRepos() {
        inventoryCalls += 1
        if (inventoryCalls === 1) {
          // `hyp github backfill o/r` in another process, committed after this
          // tick read the sidecar: the closing write adopts the authorization
          // and the tick puts the source on the backlog cadence.
          await writeCursors(stateDir, /** @type {any} */ ({
            schema_version: 1,
            repos: { 'o/r': { one_time_import: true, work: { mode: 'backfill', phase: 'issues' } } },
          }))
          return []
        }
        // Then the network goes, held open so the interval can be widened
        // before this tick makes its own scheduling decision.
        await new Promise((resolve) => held.push(() => resolve(undefined)))
        throw new Error('ENETDOWN: inventory unreachable')
      },
    }),
    storage: { cacheTablePath() { return '/cache/github_events' }, async appendRows() {} },
    log: silentLog,
  }))

  const source = await startGithubSource()
  t.after(() => source.stop())

  /**
   * Release the throwing tick now in flight and report the delay it schedules.
   * The interval is widened while it runs, so that one scheduling decision is
   * the only thing that can tell the backlog cadence from a full poll interval.
   *
   * @returns {Promise<{ delayMs: number, details: Record<string, any>, lastError: string | undefined }>}
   */
  async function releaseAndMeasure() {
    released += 1
    for (let i = 0; i < 600 && held.length < released; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(held.length, released, 'the throwing tick never reached the inventory')
    config.poll_interval = '30m'
    held[released - 1]()
    assert.ok(source.status)
    /** @type {any} */
    let status = {}
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      status = await source.status()
      if (status.details?.in_flight === false && status.details?.next_tick_at) break
    }
    const details = status.details ?? {}
    assert.ok(details.next_tick_at, 'the throwing tick never settled on a next delay')
    return {
      delayMs: Date.parse(details.next_tick_at) - Date.parse(details.last_tick_at),
      details,
      lastError: status.lastError,
    }
  }

  const first = await releaseAndMeasure()
  assert.match(String(first.lastError), /ENETDOWN/, 'the tick under measurement is the one that threw')
  assert.ok(Math.abs(first.delayMs - 30 * 60_000) < 60_000, `next tick scheduled in ${first.delayMs}ms, not the poll interval`)
  assert.equal(first.details.backlog_pending, false, 'a tick that threw reports no backlog it can size')

  // And it stays there: a further throwing tick does not rediscover backlog.
  config.poll_interval = '10ms'
  await source.reload?.(/** @type {any} */ ({}))
  const second = await releaseAndMeasure()
  assert.equal(second.details.backlog_pending, false)
  assert.ok(Math.abs(second.delayMs - 30 * 60_000) < 60_000, `next tick scheduled in ${second.delayMs}ms, not the poll interval`)

  await source.stop()
  assert.equal(readCursors(stateDir).repos['o/r']?.one_time_import, true, 'the staged authorization is still durable on disk')
})

// @ref LLP 0361#cadence [tests]: budgeted work a returning tick sized still resumes on the backlog cadence after a failure
test('a tick that throws keeps the backlog cadence work an earlier tick sized', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-backlog-throw-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const config = { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '10ms', inventory: 'all_visible' }
  let inventoryCalls = 0
  /** Release for the throwing tick, so a failed assertion never leaves it hung. @type {Array<() => void>} */
  const held = []
  t.after(() => { for (const release of held) release() })

  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config,
    captureRequestLimit: 1,
    observedRepos: { async list() { return [] } },
    clientFactory: () => ({
      ...fakeClient({
        repos: {
          'o/a': { issues: [{ number: 1, updated_at: '2024-01-01T00:00:00Z', user: { login: 'x' }, title: 't' }] },
          'o/b': { issues: [{ number: 2, updated_at: '2024-01-01T00:00:00Z', user: { login: 'x' }, title: 't' }] },
          'o/c': { issues: [{ number: 3, updated_at: '2024-01-01T00:00:00Z', user: { login: 'x' }, title: 't' }] },
        },
      }),
      async listViewerRepos() {
        inventoryCalls += 1
        // A one-request budget stops the first tick partway through the
        // inventory, sizing and persisting real bounded work (LLP 0361#budget).
        if (inventoryCalls === 1) return ['o/a', 'o/b', 'o/c']
        // The next tick's own inventory call fails, held open so the interval
        // can be widened before it makes its own scheduling decision.
        await new Promise((resolve) => held.push(() => resolve(undefined)))
        throw new Error('ENETDOWN: inventory unreachable')
      },
    }),
    storage: { cacheTablePath() { return '/cache/github_events' }, async appendRows() {} },
    log: silentLog,
  }))

  const source = await startGithubSource()
  t.after(() => source.stop())

  for (let i = 0; i < 600 && held.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(held.length, 1, 'the throwing tick never reached the inventory')
  config.poll_interval = '30m'
  held[0]()

  assert.ok(source.status)
  /** @type {any} */
  let status = {}
  for (let i = 0; i < 600; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    status = await source.status()
    if (status.details?.in_flight === false && status.details?.next_tick_at) break
  }
  const details = status.details ?? {}
  assert.ok(details.next_tick_at, 'the throwing tick never settled on a next delay')
  assert.match(String(status.lastError), /ENETDOWN/, 'the tick under measurement is the one that threw')

  const delayMs = Date.parse(details.next_tick_at) - Date.parse(details.last_tick_at)
  assert.equal(details.backlog_pending, true,
    'work an earlier tick sized and persisted is still due, even though this tick threw before sizing anything of its own')
  assert.ok(Math.abs(delayMs - BACKLOG_RETRY_MS) < 60_000,
    `next tick scheduled in ${delayMs}ms, not the backlog cadence`)

  await source.stop()
  const cursors = readCursors(stateDir)
  assert.ok(
    Object.values(cursors.repos).some((repo) => repo.work !== undefined),
    'the budgeted continuation an earlier tick persisted is still durable on disk',
  )
})

/**
 * The three tiny repositories a one-request budget cannot finish in one tick,
 * shared by the two durable-backlog tests below.
 */
const budgetedRepos = {
  'o/a': { issues: [{ number: 1, updated_at: '2024-01-01T00:00:00Z', user: { login: 'x' }, title: 't' }] },
  'o/b': { issues: [{ number: 2, updated_at: '2024-01-01T00:00:00Z', user: { login: 'x' }, title: 't' }] },
  'o/c': { issues: [{ number: 3, updated_at: '2024-01-01T00:00:00Z', user: { login: 'x' }, title: 't' }] },
}

/**
 * Release the held tick now in flight and report the delay it scheduled. The
 * poll interval is widened while that tick runs, so the one scheduling
 * decision it makes is the only thing that can tell the backlog cadence from a
 * full poll interval.
 *
 * @param {StartedSource} source
 * @param {{ poll_interval: string }} config
 * @param {Array<() => void>} held
 * @param {number} expected how many holds have accumulated once this tick is in flight
 * @returns {Promise<{ delayMs: number, details: Record<string, any>, lastError: string | undefined }>}
 */
async function releaseHeldTick(source, config, held, expected) {
  for (let i = 0; i < 600 && held.length < expected; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(held.length, expected, 'the tick under measurement never reached the inventory')
  config.poll_interval = '30m'
  held[expected - 1]()
  assert.ok(source.status)
  /** @type {any} */
  let status = {}
  for (let i = 0; i < 600; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    status = await source.status()
    if (status.details?.in_flight === false && status.details?.next_tick_at) break
  }
  const details = status.details ?? {}
  assert.ok(details.next_tick_at, 'the tick under measurement never settled on a next delay')
  return {
    delayMs: Date.parse(details.next_tick_at) - Date.parse(details.last_tick_at),
    details,
    lastError: status.lastError,
  }
}

// @ref LLP 0438#readers [tests]: a restarted daemon reads the verdict off the sidecar instead of starting from a blank closure
test('a restarted source keeps the backlog cadence for work the process before it sized', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-backlog-restart-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  // The process before the restart: one tick, a one-request budget, three
  // repositories. It sizes real bounded work and persists it (LLP 0361#budget).
  const before = await runCaptureTick(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config: { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '30m', inventory: 'all_visible' },
    captureRequestLimit: 1,
    observedRepos: { async list() { return [] } },
    clientFactory: () => fakeClient({ viewerRepos: ['o/a', 'o/b', 'o/c'], repos: budgetedRepos }),
    storage: { cacheTablePath() { return '/cache/github_events' }, async appendRows() {} },
    log: silentLog,
  }), { mode: 'poll' })
  assert.equal(before.pending, true, 'the pre-restart tick sized bounded work')
  assert.ok(
    Object.values(readCursors(stateDir).repos).some((repo) => repo.work !== undefined),
    'the continuation the pre-restart tick saved is durable on disk',
  )

  // The restart: a fresh closure with no memory of that tick, whose boot tick
  // throws before it can size anything of its own.
  const config = { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '10ms', inventory: 'all_visible' }
  /** @type {Array<() => void>} */
  const held = []
  t.after(() => { for (const release of held) release() })
  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config,
    captureRequestLimit: 1,
    observedRepos: { async list() { return [] } },
    clientFactory: () => ({
      ...fakeClient({ repos: budgetedRepos }),
      async listViewerRepos() {
        await new Promise((resolve) => held.push(() => resolve(undefined)))
        throw new Error('ENETDOWN: inventory unreachable')
      },
    }),
    storage: { cacheTablePath() { return '/cache/github_events' }, async appendRows() {} },
    log: silentLog,
  }))

  const source = await startGithubSource()
  t.after(() => source.stop())
  const boot = await releaseHeldTick(source, config, held, 1)
  await source.stop()

  assert.match(String(boot.lastError), /ENETDOWN/, 'the tick under measurement is the one that threw')
  assert.equal(boot.details.backlog_pending, true,
    'work the previous process sized and persisted is still due, whatever this process remembers')
  assert.ok(Math.abs(boot.delayMs - BACKLOG_RETRY_MS) < 60_000,
    `next tick scheduled in ${boot.delayMs}ms, not the backlog cadence`)
})

// @ref LLP 0438#writers [tests]: a retirement another process recorded reaches this daemon's cadence without a returning tick of its own
test('a continuation another process retired returns the source to the configured interval', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-backlog-retired-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const config = { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '10ms', inventory: 'all_visible' }
  let inventoryCalls = 0
  /** @type {Array<() => void>} */
  const held = []
  t.after(() => { for (const release of held) release() })

  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config,
    captureRequestLimit: 1,
    observedRepos: { async list() { return [] } },
    clientFactory: () => ({
      ...fakeClient({ repos: budgetedRepos }),
      async listViewerRepos() {
        inventoryCalls += 1
        // Both ticks are held so the interval can be widened before either
        // makes its own scheduling decision.
        await new Promise((resolve) => held.push(() => resolve(undefined)))
        // A one-request budget stops the first tick partway through the
        // inventory, sizing and persisting real bounded work.
        if (inventoryCalls === 1) return ['o/a', 'o/b', 'o/c']
        throw new Error('ENETDOWN: inventory unreachable')
      },
    }),
    storage: { cacheTablePath() { return '/cache/github_events' }, async appendRows() {} },
    log: silentLog,
  }))

  const source = await startGithubSource()
  t.after(() => source.stop())
  const sized = await releaseHeldTick(source, config, held, 1)
  assert.equal(sized.details.backlog_pending, true, 'the budgeted tick put the source on the backlog cadence')

  // `hyp github sync` in its own process against the shared sidecar, while the
  // daemon is idle between ticks. It has the whole budget, so it retires the
  // only outstanding continuation.
  const sidecar = await runCaptureTick(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config: { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '30m', inventory: 'all_visible' },
    observedRepos: { async list() { return [] } },
    clientFactory: () => fakeClient({ viewerRepos: ['o/a', 'o/b', 'o/c'], repos: budgetedRepos }),
    storage: { cacheTablePath() { return '/cache/github_events' }, async appendRows() {} },
    log: silentLog,
  }), { mode: 'poll' })
  assert.equal(sidecar.pending, false, 'the sidecar process finished the rotation')
  assert.ok(
    Object.values(readCursors(stateDir).repos).every((repo) => repo.work === undefined),
    'no continuation is left on disk for the daemon to resume',
  )

  // The daemon's next tick throws, so nothing it sizes itself can tell it the
  // backlog is gone.
  config.poll_interval = '10ms'
  await source.reload?.(/** @type {any} */ ({}))
  const after = await releaseHeldTick(source, config, held, 2)
  await source.stop()

  assert.match(String(after.lastError), /ENETDOWN/, 'the tick under measurement is the one that threw')
  assert.equal(after.details.backlog_pending, false,
    'a continuation another process retired is not backlog this source can still claim')
  assert.ok(Math.abs(after.delayMs - 30 * 60_000) < 60_000,
    `next tick scheduled in ${after.delayMs}ms, not the configured poll interval`)
})
