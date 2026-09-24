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
    log: silentLog,
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
    log: silentLog,
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
    log: silentLog,
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
    log: silentLog,
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

/**
 * A runtime whose inventory is empty and whose sidecar nothing but the test
 * writes: the first tick settles immediately, so everything after it reads a
 * daemon asleep on an armed timer rather than a tick in progress.
 *
 * @param {string} stateDir
 * @param {{ ignore: string[], token_env: string, poll_interval: string, inventory: string }} config
 */
function idleSourceRuntime(stateDir, config) {
  return /** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config,
    observedRepos: { async list() { return [] } },
    clientFactory: () => fakeClient({}),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() {},
    },
    log: silentLog,
  })
}

/**
 * Poll `source.status()` until `done` accepts its details, or give up. The
 * returned details are whatever the last poll read, so a caller that needed a
 * transition asserts on it rather than trusting the wait.
 *
 * @param {{ status?: () => Promise<{ details?: Record<string, unknown> | null }> }} source
 * @param {(details: any) => boolean} done
 * @param {number} deadlineMs
 * @returns {Promise<any>}
 */
async function waitForDetails(source, done, deadlineMs) {
  const until = Date.now() + deadlineMs
  /** @type {any} */
  let details = {}
  for (;;) {
    details = (await source.status?.())?.details ?? {}
    if (done(details) || Date.now() >= until) return details
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// @ref LLP 0409#one-time-imports [tests]: an authorization staged while the daemon sleeps reaches the backlog cadence without waiting out the armed timer
test('an authorization staged while the poll timer is armed re-arms it instead of waiting out the interval', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-armed-rearm-'))
  /** @type {Awaited<ReturnType<typeof startGithubSource>> | undefined} */
  let source
  // t.after runs hooks in registration order, so stop() must be registered
  // before the rmSync that deletes the directory the watcher holds open.
  t.after(() => source?.stop())
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const config = { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '10ms', inventory: 'session_repos' }
  setGithubRuntime(idleSourceRuntime(stateDir, config))

  source = await startGithubSource()
  // The first delay was already armed off the 10ms interval; widening it now
  // means the tick that fires settles on a 30-minute timer.
  config.poll_interval = '30m'

  const asleep = await waitForDetails(source, (d) => d.last_tick_at && d.next_tick_at && d.in_flight === false, 2000)
  // The fixture only proves anything if it really reached "asleep on a long
  // timer": a harness that never armed one would pass the re-arm assertion
  // below for free.
  assert.ok(asleep.next_tick_at, 'the first tick never settled, so no timer was ever armed')
  assert.equal(asleep.in_flight, false)
  assert.equal(asleep.backlog_pending, false)
  const armedMs = Date.parse(asleep.next_tick_at) - Date.now()
  assert.ok(armedMs > 25 * 60_000, `the armed delay is ${armedMs}ms, expected the full 30-minute poll interval`)

  // Another process (`hyp github backfill o/r`) commits its authorization.
  await writeCursors(stateDir, /** @type {any} */ ({
    schema_version: 1,
    repos: { 'o/r': { one_time_import: true, work: { mode: 'backfill', phase: 'issues' } } },
  }))

  const rearmed = await waitForDetails(source, (d) => d.next_tick_at !== asleep.next_tick_at, 2000)
  assert.notEqual(rearmed.next_tick_at, asleep.next_tick_at,
    `next_tick_at is unchanged at ${rearmed.next_tick_at}, so the armed timer never heard about the staged work`)
  assert.equal(rearmed.in_flight, false, 'the re-arm shortens the pending delay, it does not run a tick inline')
  assert.equal(rearmed.backlog_pending, true)
  const rearmedMs = Date.parse(rearmed.next_tick_at) - Date.now()
  assert.ok(rearmedMs <= BACKLOG_RETRY_MS, `the re-armed delay is ${rearmedMs}ms, not the backlog cadence`)
})

// @ref LLP 0409#one-time-imports [tests]: bare continuations stay outside the detection, so nothing reports backlog no tick can retire
test('a bare work continuation another process leaves does not re-arm the armed poll timer', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-armed-bare-work-'))
  /** @type {Awaited<ReturnType<typeof startGithubSource>> | undefined} */
  let source
  t.after(() => source?.stop())
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const config = { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '10ms', inventory: 'session_repos' }
  setGithubRuntime(idleSourceRuntime(stateDir, config))

  source = await startGithubSource()
  config.poll_interval = '30m'

  const asleep = await waitForDetails(source, (d) => d.last_tick_at && d.next_tick_at && d.in_flight === false, 2000)
  assert.ok(asleep.next_tick_at, 'the first tick never settled, so no timer was ever armed')
  const armedMs = Date.parse(asleep.next_tick_at) - Date.now()
  assert.ok(armedMs > 25 * 60_000, `the armed delay is ${armedMs}ms, expected the full 30-minute poll interval`)

  // What `hyp github sync` leaves behind: a continuation with no
  // authorization. Nothing prunes one whose repository has left the inventory
  // (LLP 0360#cursoring), so counting it would report backlog no tick retires.
  await writeCursors(stateDir, /** @type {any} */ ({
    schema_version: 1,
    repos: { 'o/r': { work: { mode: 'backfill', phase: 'issues' } } },
  }))
  const still = await waitForDetails(source, () => false, 300)
  assert.equal(still.next_tick_at, asleep.next_tick_at, 'a bare continuation must not shorten the armed delay')
  assert.equal(still.backlog_pending, false)

  // ...and the window above was not simply deaf: an authorization written the
  // same way, over the same watch, does re-arm.
  await writeCursors(stateDir, /** @type {any} */ ({
    schema_version: 1,
    repos: { 'o/r': { one_time_import: true, work: { mode: 'backfill', phase: 'issues' } } },
  }))
  const rearmed = await waitForDetails(source, (d) => d.next_tick_at !== asleep.next_tick_at, 2000)
  assert.notEqual(rearmed.next_tick_at, asleep.next_tick_at,
    'the negative window proves nothing unless an authorization written the same way is heard')
  assert.equal(rearmed.backlog_pending, true)
})

test('a staged authorization never pushes an armed delay that is already shorter than the backlog cadence further out', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-armed-short-'))
  /** @type {Awaited<ReturnType<typeof startGithubSource>> | undefined} */
  let source
  t.after(() => source?.stop())
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const config = { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '10ms', inventory: 'session_repos' }
  setGithubRuntime(idleSourceRuntime(stateDir, config))

  source = await startGithubSource()
  // Shorter than the backlog cadence, so re-arming to it would defer the tick
  // rather than bring it forward.
  config.poll_interval = '2m'

  const asleep = await waitForDetails(source, (d) => d.last_tick_at && d.next_tick_at && d.in_flight === false, 2000)
  assert.ok(asleep.next_tick_at, 'the first tick never settled, so no timer was ever armed')
  const armedMs = Date.parse(asleep.next_tick_at) - Date.now()
  assert.ok(armedMs > 60_000 && armedMs < BACKLOG_RETRY_MS,
    `the armed delay is ${armedMs}ms, expected the 2-minute poll interval this test needs`)

  await writeCursors(stateDir, /** @type {any} */ ({
    schema_version: 1,
    repos: { 'o/r': { one_time_import: true, work: { mode: 'backfill', phase: 'issues' } } },
  }))
  const still = await waitForDetails(source, () => false, 300)
  assert.equal(still.next_tick_at, asleep.next_tick_at, 'the re-arm only ever shortens a pending delay')
  assert.equal(still.backlog_pending, false)

  // ...and the window above was not simply deaf: the same watcher, once the
  // source settles on a delay past the backlog cadence, does re-arm. Replace
  // the staged authorization with a bare continuation first, so the settling
  // tick arms the full interval instead of latching backlog_pending.
  await writeCursors(stateDir, /** @type {any} */ ({
    schema_version: 1,
    repos: { 'o/r': { work: { mode: 'backfill', phase: 'issues' } } },
  }))
  config.poll_interval = '10ms'
  assert.ok(source.reload, 'the control below needs the source to support reload')
  // The github source's reload reads config from the runtime, not the ctx.
  await source.reload(/** @type {any} */ ({}))
  // The reload delay was armed off the 10ms interval; widening it now means
  // the tick that fires settles on a 30-minute timer.
  config.poll_interval = '30m'
  const rearmable = await waitForDetails(source,
    (d) => d.in_flight === false && d.next_tick_at && Date.parse(d.next_tick_at) - Date.now() > 25 * 60_000, 2000)
  assert.ok(rearmable.next_tick_at && Date.parse(rearmable.next_tick_at) - Date.now() > 25 * 60_000,
    'the control never reached a timer past the backlog cadence, so the negative window proves nothing')
  assert.equal(rearmable.backlog_pending, false)
  await writeCursors(stateDir, /** @type {any} */ ({
    schema_version: 1,
    repos: { 'o/r': { one_time_import: true, work: { mode: 'backfill', phase: 'issues' } } },
  }))
  const rearmed = await waitForDetails(source, (d) => d.next_tick_at !== rearmable.next_tick_at, 2000)
  assert.notEqual(rearmed.next_tick_at, rearmable.next_tick_at,
    'the short-delay window proves nothing unless the same watcher re-arms a delay past the cadence')
  assert.equal(rearmed.backlog_pending, true)
  const rearmedMs = Date.parse(rearmed.next_tick_at) - Date.now()
  assert.ok(rearmedMs <= BACKLOG_RETRY_MS, `the re-armed delay is ${rearmedMs}ms, not the backlog cadence`)
})
