// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runCaptureTick } from '../../hypaware-core/plugins-workspace/github/src/tick.js'
import { readCursors } from '../../hypaware-core/plugins-workspace/github/src/cursors.js'
import { fakeClient, silentLog } from './github-fake-client.js'

/** @import { TestContext } from 'node:test' */
/** @import { GithubRuntime } from '../../hypaware-core/plugins-workspace/github/src/types.js' */

/** @param {TestContext} t */
function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-github-import-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  /** @type {string[]} */
  const calls = []
  const rows = []
  /** @type {string[]} */
  const evidence = []
  let projects = 0
  const client = fakeClient({ calls, viewerRepos: ['o/unrequested'], repos: {
    'o/one': { issues: [{ number: 1, created_at: '2026-09-01T00:00:00Z' }] },
    'o/two': { issues: [{ number: 2, created_at: '2026-09-01T00:00:00Z' }] },
  } })
  const runtime = /** @type {GithubRuntime} */ (/** @type {unknown} */ ({
    stateDir, log: silentLog,
    config: { ignore: [], inventory: 'session_repos', token_env: 'GITHUB_TOKEN', poll_interval: '24h' },
    env: {}, observedRepos: { async list() { return [...evidence] }, lastKnown() { return [...evidence] } },
    clientFactory: () => client, captureRequestLimit: 1,
    storage: { cacheTablePath() { return '/cache/github_events' }, async appendRows(_path, _columns, batch) { rows.push(...batch) } },
    graph: { async project() { projects++
      return { nodes: 1, edges: 1, nodesWritten: 1, edgesWritten: 1 } } },
  }))
  return { runtime, stateDir, calls, rows, evidence, projects: () => projects }
}

test('a multi-repository import persists unvisited work, resumes after restart and stops on completion', async (t) => {
  const f = fixture(t)
  const first = await runCaptureTick(f.runtime, { mode: 'backfill', only: ['O/ONE', 'o/two'] })
  assert.equal(first.pending, true)
  assert.equal(first.visited, 1)
  assert.equal(readCursors(f.stateDir).repos['o/two'].one_time_import, true)
  assert.equal(f.evidence.length, 0)
  let pending = true
  for (let i = 0; i < 12 && pending; i++) {
    const result = await runCaptureTick({ ...f.runtime, projectionNeeded: undefined }, { mode: 'poll' })
    assert.deepEqual(result.errors, [])
    pending = result.pending
  }
  assert.equal(pending, false)
  assert.equal(f.rows.length, 2)
  assert.ok(f.projects() > 0)
  for (const cursor of Object.values(readCursors(f.stateDir).repos)) {
    assert.equal(cursor.one_time_import, undefined)
    assert.equal(cursor.work, undefined)
  }
  f.calls.length = 0
  assert.equal((await runCaptureTick(f.runtime, { mode: 'poll' })).repos, 0)
  assert.equal(f.calls.length, 0, 'neither OAuth visibility nor completed explicit imports expands automatic inventory')
  f.evidence.push('o/one')
  assert.equal((await runCaptureTick(f.runtime, { mode: 'poll' })).repos, 1)
  assert.ok(f.calls.every((call) => call.endsWith('o/one')))
})

test('exclusions prevent an import and cancel exceptional eligibility during resumed work', async (t) => {
  const f = fixture(t)
  f.runtime.config.ignore = ['O/TWO']
  await runCaptureTick(f.runtime, { mode: 'backfill', only: ['o/one', 'o/two'] })
  assert.equal(readCursors(f.stateDir).repos['o/two'], undefined)
  f.runtime.config.ignore.push('o/one')
  f.calls.length = 0
  assert.equal((await runCaptureTick(f.runtime, { mode: 'poll' })).repos, 0)
  assert.equal(readCursors(f.stateDir).repos['o/one'].one_time_import, undefined)
  f.runtime.config.ignore = []
  assert.equal((await runCaptureTick(f.runtime, { mode: 'poll' })).repos, 0)
  assert.deepEqual(f.calls, [], 'removing an exclusion does not resurrect a cancelled import')
})

test('explicit imports need no session lookup or all-visible enumeration; repeating completed import re-appends', async (t) => {
  const f = fixture(t)
  f.runtime.captureRequestLimit = 400
  f.runtime.config.inventory = 'all_visible'
  f.runtime.observedRepos.list = async () => { throw new Error('must not read session inventory') }
  for (let i = 0; i < 2; i++) {
    const result = await runCaptureTick(f.runtime, { mode: 'backfill', only: ['o/one'] })
    assert.deepEqual(result.errors, [])
    assert.equal(result.events, 1)
  }
  assert.equal(f.rows.length, 2)
  assert.equal(f.calls.includes('listViewerRepos'), false)
})

test('authorization exists before the first request and append failure resumes its saved backfill', async (t) => {
  const f = fixture(t)
  const client = f.runtime.clientFactory?.()
  assert.ok(client)
  const issues = client.listIssuesPage
  client.listIssuesPage = async (...args) => {
    assert.equal(readCursors(f.stateDir).repos['o/one'].one_time_import, true)
    return issues(...args)
  }
  f.runtime.clientFactory = () => client
  const append = f.runtime.storage.appendRows
  f.runtime.storage.appendRows = async () => { throw new Error('disk full') }
  const failed = await runCaptureTick(f.runtime, { mode: 'backfill', only: ['o/one'] })
  assert.match(failed.errors[0].error, /disk full/)
  assert.equal(readCursors(f.stateDir).repos['o/one'].work?.mode, 'backfill')
  f.runtime.storage.appendRows = append
  const resumed = await runCaptureTick(f.runtime, { mode: 'poll' })
  assert.equal(resumed.events, 1)
  assert.equal(f.rows.length, 1)
})
