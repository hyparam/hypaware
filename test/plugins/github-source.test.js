// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { setGithubRuntime } from '../../hypaware-core/plugins-workspace/github/src/runtime.js'
import { BACKLOG_RETRY_MS, nextCaptureDelay, startGithubSource } from '../../hypaware-core/plugins-workspace/github/src/source.js'
import { emptyGraph, fakeClient } from './github-fake-client.js'
import { runCaptureTick } from '../../hypaware-core/plugins-workspace/github/src/tick.js'
import { readCursors } from '../../hypaware-core/plugins-workspace/github/src/cursors.js'
import { runGithubBackfill } from '../../hypaware-core/plugins-workspace/github/src/commands.js'

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

  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    graph: emptyGraph,
    config: {
      ignore: [],
      token_env: 'GITHUB_TOKEN',
      poll_interval: '10ms',
      inventory: 'session_repos',
    },
    observedRepos: { async list() { return [] } },
    clientFactory: () => fakeClient({}),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() { throw new Error('empty inventory must not append') },
    },
    log: {
      info(name, attrs) { logs.push({ name, attrs }) },
      error(name, attrs) { logs.push({ name, attrs }) },
    },
  }))

  const source = await startGithubSource()
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.ok(source.status)
  const status = await source.status()
  await source.stop()

  assert.ok(logs.some((entry) => entry.name === 'github.poll_tick_started'))
  assert.ok(logs.some((entry) => entry.name === 'github.poll_tick_completed'))
  assert.equal(status.state, 'ready')
  assert.equal(status.details?.cadence, '10ms')
  assert.equal(status.details?.inventory, 'session_repos')
  assert.equal(typeof status.details?.next_tick_at, 'string')
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
