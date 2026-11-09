// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runLinearCaptureTick, readLinearCursor, cursorPath } from '../../hypaware-core/plugins-workspace/linear/src/capture.js'
import { validateLinearConfig } from '../../hypaware-core/plugins-workspace/linear/src/config.js'
import { ISSUE, ATTACHMENT, IDENTITY, ISSUE_ID } from '../../hypaware-core/smoke/lib/linear_fixture.js'

/** @import { LinearRuntime, LinearClient, LinearIssue, LinearAttachment } from '../../hypaware-core/plugins-workspace/linear/src/types.js' */

/** @param {Array<LinearIssue | LinearAttachment>} nodes @param {string | null} [next] */
const page = (nodes, next = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } })

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-linear-capture-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const rows = []
  const calls = []
  const logs = []
  let projects = 0
  const config = validateLinearConfig({ teams: ['HYP'] }).config
  assert.ok(config)
  /** @type {LinearClient} */
  const client = { async identity() { return IDENTITY }, async page(stream, work) {
    calls.push({ ...work, stream })
    return page(stream === 'issues' ? [ISSUE] : [ATTACHMENT])
  } }
  /** @type {LinearRuntime} */
  const rt = /** @type {any} */ ({ config, stateDir, env: {},
    log: { info: (body, attributes) => logs.push({ body, attributes }), warn: (body, attributes) => logs.push({ body, attributes }) },
    storage: { cacheTablePath: () => 'test-table', async appendRows(_table, _columns, values) { rows.push(...values) } },
    graph: { async project(dataset) { projects++
      assert.equal(dataset, 'linear_events')
      return { nodesWritten: 1, edgesWritten: 1 } } },
    clientFactory: () => client,
  })
  return { rt, client, rows, calls, logs, projects: () => projects }
}

const NOW = Date.parse('2026-11-06T00:00:00.000Z')
const options = { now: () => NOW }

test('bounded capture resumes the attachment stream after restart and appends before persisting progress', async t => {
  const f = fixture(t)
  const first = await runLinearCaptureTick(f.rt, { ...options, requestLimit: 2 })
  assert.equal(first.pending, true)
  assert.equal(first.events, 1)
  assert.equal(readLinearCursor(f.rt.stateDir)?.work?.stream, 'attachments')
  const resumed = await runLinearCaptureTick({ ...f.rt }, options)
  assert.equal(resumed.pending, false)
  assert.equal(resumed.events, 1)
  assert.deepEqual(f.rows.map(r => r.event_type), ['issue', 'pr_attachment'])
  assert.equal(f.rows[1].repo, 'acme/widgets')
  assert.equal(f.rows[1].pr_number, 42)
  assert.equal(readLinearCursor(f.rt.stateDir)?.since, new Date(NOW - 1000).toISOString())
  assert.equal(f.projects(), 2)
})

test('multiple pages stay inside the frozen time window and preserve an independent opaque continuation', async t => {
  const f = fixture(t)
  f.client.page = async (stream, work) => {
    f.calls.push({ ...work, stream })
    return page(stream === 'issues' ? [ISSUE] : [ATTACHMENT], !work.after ? `${stream}-next` : null)
  }
  await runLinearCaptureTick(f.rt, { ...options, requestLimit: 2 })
  await runLinearCaptureTick(f.rt, { now: () => NOW + 60000 })
  assert.deepEqual(f.calls.map(c => c.after), [null, 'issues-next', null, 'attachments-next'])
  assert.equal(new Set(f.calls.map(c => c.until)).size, 1)
  assert.equal(f.calls[0].until, new Date(NOW).toISOString())
})

test('team boundaries reject unrelated attachments and malformed PR links without retaining content', async t => {
  const f = fixture(t)
  f.client.page = async stream => page(stream === 'issues' ? [ISSUE] : [
    { ...ATTACHMENT, issue: { ...ISSUE, team: { ...ISSUE.team, key: 'OTHER', id: ISSUE_ID } } },
    { ...ATTACHMENT, url: 'https://github.com/acme/widgets/issues/42' },
    ATTACHMENT,
  ])
  assert.equal((await runLinearCaptureTick(f.rt, options)).events, 2)
  assert.equal(f.rows.length, 2)
  assert.doesNotMatch(JSON.stringify(f.rows), /hermetic-access|description|title|metadata/)
  f.rt.config.teams = []
  f.client.identity = async () => { throw new Error('empty scope must not call API') }
  assert.equal((await runLinearCaptureTick(f.rt)).events, 0)
})

test('workspace, user or team changes reset cursors instead of skipping newly eligible history', async t => {
  const f = fixture(t)
  await runLinearCaptureTick(f.rt, options)
  f.rt.config.teams = ['hyp', 'other']
  await runLinearCaptureTick(f.rt, options)
  assert.equal(f.calls[2].since, null)
  f.client.identity = async () => ({ ...IDENTITY, workspace_id: ISSUE_ID })
  await runLinearCaptureTick(f.rt, options)
  assert.equal(f.calls[4].since, null)
  f.client.identity = async () => ({ ...IDENTITY, workspace_id: ISSUE_ID, user_id: ISSUE_ID })
  await runLinearCaptureTick(f.rt, options)
  assert.equal(f.calls[6].since, null)
})

test('append and cursor-write failures retain replayable progress and emit the failing step', async t => {
  const f = fixture(t)
  const append = f.rt.storage.appendRows
  f.rt.storage.appendRows = async () => { throw new Error('private-provider-text') }
  const failed = await runLinearCaptureTick(f.rt, options)
  assert.equal(failed.events, 0)
  assert.equal(readLinearCursor(f.rt.stateDir)?.work?.stream, 'issues')
  assert.ok(f.logs.some(r => r.body === 'linear.capture_failed' && r.attributes.smoke_step === 'append'))
  assert.doesNotMatch(JSON.stringify(f.logs), /private-provider-text/)
  f.rt.storage.appendRows = append
  assert.equal((await runLinearCaptureTick(f.rt, options)).events, 2)
  await runLinearCaptureTick(f.rt, { ...options, backfill: true, requestLimit: 2 })
  f.rt.storage.appendRows = async (...args) => {
    await append(...args)
    fs.renameSync(cursorPath(f.rt.stateDir), `${cursorPath(f.rt.stateDir)}.saved`)
    fs.mkdirSync(cursorPath(f.rt.stateDir))
  }
  const writeFailed = await runLinearCaptureTick(f.rt, options)
  assert.deepEqual(writeFailed.errors, ['Linear: failed to persist capture progress; the next tick will replay the uncommitted page'])
  fs.rmdirSync(cursorPath(f.rt.stateDir))
  fs.renameSync(`${cursorPath(f.rt.stateDir)}.saved`, cursorPath(f.rt.stateDir))
  assert.equal(readLinearCursor(f.rt.stateDir)?.work?.stream, 'attachments')
})

test('projection failure retries after durable cursor advancement, including an idle tick', async t => {
  const f = fixture(t)
  const project = f.rt.graph.project
  f.rt.graph.project = async () => { throw new Error('projection failed') }
  assert.deepEqual((await runLinearCaptureTick(f.rt, options)).errors, ['Linear: graph projection failed; it retries on the next sync'])
  assert.equal(readLinearCursor(f.rt.stateDir)?.work, null)
  f.client.page = async () => page([])
  f.rt.graph.project = project
  await runLinearCaptureTick(f.rt, options)
  assert.equal(f.projects(), 1)
  await runLinearCaptureTick(f.rt, options)
  assert.equal(f.projects(), 1, 'idle success skips expensive projection')
})

test('a cancelled page starts no append/projection and concurrent capture cannot overwrite newer progress', async t => {
  const f = fixture(t)
  const abort = new AbortController()
  f.client.page = async () => { abort.abort()
    return page([ISSUE]) }
  assert.equal((await runLinearCaptureTick(f.rt, { ...options, signal: abort.signal })).cancelled, true)
  assert.equal(f.rows.length, 0)
  assert.equal(f.projects(), 0)
  f.client.page = async () => {
    const prior = readLinearCursor(f.rt.stateDir)
    assert.ok(prior)
    fs.writeFileSync(cursorPath(f.rt.stateDir), JSON.stringify({ ...prior, generation: ISSUE_ID }))
    return page([ISSUE])
  }
  assert.deepEqual((await runLinearCaptureTick(f.rt, options)).errors, ['Linear: another capture changed the cursor; retry'])
  assert.equal(f.rows.length, 0)
})
