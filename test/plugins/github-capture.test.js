// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { captureRepos, resolveRepos } from '../../hypaware-core/plugins-workspace/github/src/capture.js'
import { readCursors, writeCursors } from '../../hypaware-core/plugins-workspace/github/src/cursors.js'
import { fakeClient, silentLog } from './github-fake-client.js'

/** @import { CursorState, GithubClient, GithubConfig } from '../../hypaware-core/plugins-workspace/github/src/types.d.ts' */

/** @returns {CursorState} */
const freshCursors = () => ({ schema_version: 1, repos: {} })

/**
 * Run a capture and collect every appended row.
 *
 * @param {object} a
 * @param {GithubConfig} a.config
 * @param {GithubClient} a.client
 * @param {'backfill' | 'poll'} [a.mode]
 * @param {string[]} [a.only]
 * @param {string[]} [a.observedRepos]
 */
async function capture({ config, client, mode = 'backfill', only, observedRepos = [] }) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  const cursors = freshCursors()
  const result = await captureRepos({
    client,
    config,
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode,
    only,
    observedRepos: config.inventory === 'session_repos' ? observedRepos : undefined,
  })
  return { rows, result, cursors }
}

/** @param {Partial<GithubConfig>} [over] @returns {GithubConfig} */
function cfg(over) {
  return {
    ignore: [],
    token_env: 'GITHUB_TOKEN',
    poll_interval: '24h',
    inventory: 'session_repos',
    ...over,
  }
}

test('session inventory normalizes evidence, drops ignore[] case-insensitively, dedups and sorts', async () => {
  const calls = []
  const client = fakeClient({ calls })
  const repos = await resolveRepos(
    cfg({ ignore: ['MY-ORG/SECRET', 'owner/b'] }),
    client,
    silentLog,
    ['Owner/A', 'owner/b', 'my-org/x', 'my-org/secret', 'OWNER/A'],
  )
  assert.deepEqual(repos, ['my-org/x', 'owner/a'])
  assert.ok(!calls.includes('listViewerRepos'))
})

test('all_visible enumerates the authenticated identity and applies ignore[]', async () => {
  const calls = []
  const client = fakeClient({ calls, viewerRepos: ['Owner/A', 'owner/a', 'Owner/B'] })
  const repos = await resolveRepos(cfg({ inventory: 'all_visible', ignore: ['owner/b'] }), client, silentLog)
  assert.deepEqual(repos, ['owner/a'])
  assert.deepEqual(calls, ['listViewerRepos'])
})

test('an ignored repo is never fetched and produces no events (capture-time enforcement)', async () => {
  /** @type {string[]} */
  const calls = []
  const client = fakeClient({
    calls,
    repos: { 'o/r': { issues: [{ number: 1, state: 'open', created_at: '2026-01-01T00:00:00Z', user: { login: 'a' } }] } },
  })
  const { rows, result } = await capture({ config: cfg({ ignore: ['O/R'] }), client, observedRepos: ['o/r'] })
  assert.equal(result.repos, 0)
  assert.equal(rows.length, 0)
  assert.ok(!calls.some((c) => c.startsWith('listIssues')), 'ignored repo is not even fetched')
})

test('captures the full taxonomy with correct discrimination + linkage', async () => {
  const TS = '2026-01-01T00:00:00Z'
  const client = fakeClient({
    repos: {
      'o/r': {
        issues: [
          { number: 1, state: 'open', created_at: TS, user: { login: 'Alice', type: 'User' } },
          { number: 2, pull_request: {}, state: 'open', created_at: TS, user: { login: 'Bob' } }, // a PR, filtered from the issue pass
        ],
        pulls: [{ number: 2, state: 'open', created_at: TS, updated_at: TS, draft: false, merged_at: null, user: { login: 'Bob', type: 'User' } }],
        prFiles: { 2: ['src/a.js'] },
        prReviews: { 2: [{ id: 80, state: 'APPROVED', submitted_at: TS, user: { login: 'Carol' } }] },
        prCommits: { 2: [{ sha: 'deadbeef', author: { login: 'Bob' }, commit: { author: { date: TS } } }] },
        commits: [{ sha: 'cafef00d', author: { login: 'Alice' }, commit: { author: { date: TS } } }],
        commitFiles: { cafef00d: ['README.md'] },
        comments: [
          { id: 10, created_at: TS, user: { login: 'Dave' }, issue_url: 'https://api.github.com/repos/o/r/issues/1' },
          { id: 11, created_at: TS, user: { login: 'Eve' }, issue_url: 'https://api.github.com/repos/o/r/issues/2' },
        ],
      },
    },
  })

  const { rows } = await capture({ config: cfg(), client, observedRepos: ['o/r'] })
  const byType = groupBy(rows, 'event_type')

  // The PR is not double-counted as an issue.
  assert.equal(byType.issue?.length, 1)
  assert.equal(byType.issue[0].number, 1)
  assert.equal(byType.issue[0].actor_login, 'Alice')

  assert.equal(byType.pull_request?.length, 1)
  assert.equal(byType.pull_request[0].state, 'open')
  assert.deepEqual(byType.pull_request[0].payload, { merged: false, draft: false })

  assert.equal(byType.pull_request_file?.length, 1)
  assert.equal(byType.pull_request_file[0].path, 'src/a.js')
  assert.equal(byType.pull_request_file[0].number, 2)

  assert.equal(byType.review?.length, 1)
  assert.equal(byType.review[0].review_id, 80)
  assert.equal(byType.review[0].pr_number, 2, 'review carries the PR it is on')

  // Two commit rows: one under the PR (pr_number set → references edge), one repo-level.
  assert.equal(byType.commit?.length, 2)
  const prCommit = byType.commit.find((/** @type {any} */ r) => r.sha === 'deadbeef')
  const repoCommit = byType.commit.find((/** @type {any} */ r) => r.sha === 'cafef00d')
  assert.equal(prCommit.pr_number, 2)
  assert.equal(repoCommit.pr_number, null)

  assert.equal(byType.commit_file?.length, 1)
  assert.equal(byType.commit_file[0].path, 'README.md')

  // Comment discrimination: #1 is an issue, #2 is a PR.
  assert.equal(byType.issue_comment?.length, 1)
  assert.equal(byType.issue_comment[0].number, 1)
  assert.equal(byType.pull_request_comment?.length, 1)
  assert.equal(byType.pull_request_comment[0].number, 2)
})

test('every captured row carries the full column shape and an event_id', async () => {
  const client = fakeClient({
    repos: { 'o/r': { issues: [{ number: 1, state: 'open', created_at: '2026-01-01T00:00:00Z', user: { login: 'a' } }] } },
  })
  const { rows } = await capture({ config: cfg(), client, observedRepos: ['o/r'] })
  const row = rows[0]
  for (const col of ['event_id', 'event_type', 'repo', 'actor_login', 'actor_type', 'number', 'sha', 'path', 'review_id', 'review_state', 'state', 'pr_number', 'created_at', 'payload']) {
    assert.ok(col in row, `column ${col} present`)
  }
  assert.equal(row.event_id, 'issue:o/r#1')
})

test('duplicate ids within one API batch are emitted once', async () => {
  const issue = { number: 1, state: 'open', created_at: '2026-01-01T00:00:00Z', user: { login: 'a' } }
  const client = fakeClient({ repos: { 'o/r': { issues: [issue, issue] } } })
  const { rows, result } = await capture({ config: cfg(), client, observedRepos: ['o/r'] })
  assert.equal(result.events, 1)
  assert.deepEqual(rows.map((row) => row.event_id), ['issue:o/r#1'])
})

test('only-filter restricts to the named repo within the configured selection', async () => {
  const client = fakeClient({
    repos: {
      'o/a': { issues: [{ number: 1, state: 'open', created_at: '2026-01-01T00:00:00Z', user: { login: 'a' } }] },
      'o/b': { issues: [{ number: 9, state: 'open', created_at: '2026-01-01T00:00:00Z', user: { login: 'b' } }] },
    },
  })
  const { rows, result } = await capture({
    config: cfg(),
    client,
    observedRepos: ['o/a', 'o/b'],
    only: ['o/a'],
  })
  assert.equal(result.repos, 1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].repo, 'o/a')
})

test('only-filter never expands beyond the active inventory', async () => {
  const calls = []
  const client = fakeClient({
    calls,
    repos: { 'o/outside': { issues: [{ number: 1 }] } },
  })
  const { rows, result } = await capture({
    config: cfg(),
    client,
    observedRepos: ['o/observed'],
    only: ['o/outside'],
  })
  assert.equal(result.repos, 0)
  assert.equal(rows.length, 0)
  assert.ok(!calls.some((call) => call.includes('o/outside')))
})

test('a failed append does not advance past rows that never landed', async () => {
  const client = fakeClient({
    repos: { 'o/r': { issues: [{ number: 1, state: 'open' }] } },
  })
  client.listIssuesPage = async () => {
    return { items: [{ number: 1, state: 'open', updated_at: '2026-09-02T12:00:00.000Z' }], next: null }
  }
  const cursors = freshCursors()
  const result = await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async () => { throw new Error('disk unavailable') },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })
  assert.equal(result.errors.length, 1)
  assert.equal(result.events, 0)
  assert.equal(cursors.repos['o/r'].since, undefined)
  assert.deepEqual(cursors.repos['o/r'].work, { mode: 'poll', phase: 'issues' })
})

test('a failed PR subresource does not publish the pulls cursor', async () => {
  const client = fakeClient({})
  client.listPullRequestsPage = async () => {
    return { items: [{ number: 7, state: 'open', updated_at: '2026-09-02T12:00:00.000Z' }], next: null, etag: 'etag-new' }
  }
  client.listPullRequestFilesPage = async () => { throw new Error('rate limited') }
  const cursors = freshCursors()
  const result = await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async () => {},
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })
  assert.equal(result.errors.length, 1)
  assert.equal(result.events, 1, 'the successfully appended pull snapshot is still reported')
  assert.equal(cursors.repos['o/r'].etag, undefined, 'etag is not published before subresources finish')
  assert.equal(cursors.repos['o/r'].since?.pulls, undefined)
  assert.equal(cursors.repos['o/r'].work?.phase, 'pulls')
  assert.equal(cursors.repos['o/r'].work?.pull_tasks?.[0].number, 7)
})

test('a repo failure retries on the ordinary cadence, not the backlog cadence', async () => {
  const client = fakeClient({})
  client.listIssuesPage = async () => { throw new Error('404 for GET /repos/o/r/issues') }
  const cursors = freshCursors()
  const result = await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async () => {},
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })
  assert.equal(result.errors.length, 1)
  assert.equal(
    result.pending,
    false,
    'an error is not bounded backlog: pending drives the poll cadence (LLP 0360#cadence)'
  )
  assert.equal(cursors.repos['o/r'].work?.phase, 'issues', 'the durable work is still there to resume')
})

test('only the first pull page publishes an etag for the next poll', async () => {
  /** @type {Array<string | undefined>} */
  const sentEtags = []
  const client = fakeClient({})
  client.listPullRequestsPage = async (_owner, _repo, etag, page) => {
    sentEtags.push(etag)
    return page
      ? { items: [], next: null, etag: 'etag-page-2' }
      : { items: [], next: 'https://api.github.test/repos/o/r/pulls?page=2', etag: 'etag-page-1' }
  }
  const cursors = freshCursors()
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async () => {},
    log: silentLog,
    mode: 'backfill',
    observedRepos: ['o/r'],
  })
  assert.deepEqual(sentEtags, [undefined, undefined])
  assert.equal(cursors.repos['o/r'].etag?.pulls, 'etag-page-1')
})

test('a narrowed backfill does not move the global round-robin position', async () => {
  const calls = []
  const client = fakeClient({ calls })
  const cursors = freshCursors()
  cursors.next_repo = 'o/b'
  const base = {
    client,
    config: cfg(),
    cursors,
    append: async () => {},
    log: silentLog,
    observedRepos: ['o/a', 'o/b', 'o/c'],
  }

  await captureRepos({ ...base, mode: 'backfill', only: ['o/a'] })
  assert.equal(
    cursors.next_repo,
    'o/b',
    'a one-repo backfill must not rewind the repositories that were next in line'
  )
  assert.deepEqual(calls.filter((call) => call.startsWith('listIssues')), ['listIssues:o/a'])

  // The guard suppresses the write only for a narrowed run: an ordinary tick
  // that stops early still hands the next repository to the tick after it.
  await captureRepos({ ...base, mode: 'poll', requestLimit: 1 })
  assert.equal(cursors.next_repo, 'o/c', 'an ordinary tick still advances the rotation')
})

test('whole-tick budget resumes a backfill without replaying completed pages', async () => {
  const calls = []
  const client = fakeClient({
    calls,
    repos: {
      'o/r': {
        pulls: [{ number: 7, state: 'open', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }],
        prFiles: { 7: ['src/a.js'] },
        prReviews: { 7: [{ id: 80, state: 'APPROVED' }] },
        prCommits: { 7: [{ sha: 'deadbeef' }] },
      },
    },
  })
  const cursors = freshCursors()
  const rows = []
  const args = {
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: /** @type {const} */ ('backfill'),
    observedRepos: ['o/r'],
    requestLimit: 4,
  }

  const first = await captureRepos(args)
  assert.equal(first.requests, 4)
  assert.equal(first.pending, true)
  assert.equal(cursors.repos['o/r'].work?.phase, 'pulls')
  assert.equal(cursors.repos['o/r'].work?.pull_tasks?.[0].phase, 'commits')

  const second = await captureRepos(args)
  assert.equal(second.pending, false)
  assert.equal(cursors.repos['o/r'].work, undefined)
  assert.equal(calls.filter((call) => call.startsWith('listIssues')).length, 1)
  assert.equal(calls.filter((call) => call.startsWith('listPullRequests')).length, 1)
  assert.equal(new Set(rows.map((row) => row.event_id)).size, rows.length)
})

test('request exhaustion rotates the next tick to the next repository', async () => {
  const calls = []
  const client = fakeClient({ calls })
  const cursors = freshCursors()
  const args = {
    client,
    config: cfg(),
    cursors,
    append: async () => {},
    log: silentLog,
    mode: /** @type {const} */ ('backfill'),
    observedRepos: ['o/a', 'o/b'],
    requestLimit: 1,
  }

  await captureRepos(args)
  await captureRepos(args)
  assert.deepEqual(calls.filter((call) => call.startsWith('listIssues')), [
    'listIssues:o/a',
    'listIssues:o/b',
  ])
})

test('incremental pulls stop at the prior high-water page', async () => {
  const client = fakeClient({})
  let pullPages = 0
  client.listPullRequestsPage = async (_owner, _repo, _etag, page) => {
    pullPages += 1
    assert.equal(page, undefined)
    return {
      items: [
        { number: 9, updated_at: '2026-02-01T00:00:00Z' },
        { number: 8, updated_at: '2026-01-01T00:00:00Z' },
      ],
      next: 'https://api.github.test/repos/o/r/pulls?page=2',
    }
  }
  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { pulls: '2026-01-15T00:00:00Z' } }
  const rows = []
  const result = await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.equal(result.pending, false)
  assert.equal(pullPages, 1)
  assert.deepEqual(rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number), [9])
  assert.equal(cursors.repos['o/r'].since?.pulls, '2026-02-01T00:00:00Z')
})

test('incremental pulls include unseen PRs tied at the high-water timestamp', async () => {
  const client = fakeClient({})
  let pullPages = 0
  client.listPullRequestsPage = async (_owner, _repo, _etag, page) => {
    pullPages += 1
    if (page === undefined) {
      return {
        items: [{ number: 10, updated_at: '2026-02-01T00:00:00Z' }],
        next: 'https://api.github.test/repos/o/r/pulls?page=2',
      }
    }
    assert.match(page, /page=2$/)
    return {
      items: [
        { number: 11, updated_at: '2026-02-01T00:00:00Z' },
        { number: 9, updated_at: '2026-01-31T23:59:59Z' },
      ],
      next: 'https://api.github.test/repos/o/r/pulls?page=3',
    }
  }
  const cursors = freshCursors()
  cursors.repos['o/r'] = {
    since: { pulls: '2026-02-01T00:00:00Z' },
    pull_numbers: [10],
  }
  const rows = []
  const result = await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.equal(result.pending, false)
  assert.equal(pullPages, 2)
  assert.deepEqual(rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number), [11])
  assert.deepEqual(cursors.repos['o/r'].pull_numbers, [9, 10, 11])
})

test('page and task continuations survive the cursor sidecar round trip', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-cursors-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const state = {
    schema_version: 1,
    next_repo: 'o/b',
    repos: {
      'o/a': {
        pull_numbers: [7, 9],
        work: {
          mode: /** @type {const} */ ('backfill'),
          phase: /** @type {const} */ ('pulls'),
          page: 'https://api.github.test/repos/o/a/pulls?page=2',
          baseline_pulls: '2026-01-01T00:00:00Z',
          pulls_high: '2026-02-01T00:00:00Z',
          pulls_etag: 'etag-new',
          pull_tasks: [{ number: 9, created_at: '2026-02-01T00:00:00Z', phase: /** @type {const} */ ('reviews'), page: 'https://api.github.test/reviews?page=2' }],
        },
      },
    },
  }

  writeCursors(stateDir, state)
  assert.deepEqual(readCursors(stateDir), state)
})

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} key
 * @returns {Record<string, any[]>}
 */
function groupBy(rows, key) {
  /** @type {Record<string, any[]>} */
  const out = {}
  for (const r of rows) {
    const k = String(r[key])
    ;(out[k] ??= []).push(r)
  }
  return out
}

test('a phase publishes its since watermark only once every page has appended', async () => {
  // An issues list that never ends: the phase can never complete, so its
  // watermark must stay staged on `work` and out of the durable cursor.
  const client = fakeClient({})
  let issuePages = 0
  client.listIssuesPage = async () => {
    issuePages += 1
    return {
      items: [{ number: issuePages, state: 'open', updated_at: `2026-03-0${issuePages}T00:00:00Z` }],
      next: 'https://api.github.test/repos/o/r/issues?page=next',
    }
  }
  const cursors = freshCursors()
  const result = await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async () => {},
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
    requestLimit: 3,
  })

  assert.equal(result.pending, true)
  assert.equal(issuePages, 3)
  const cursor = cursors.repos['o/r']
  assert.equal(cursor.since?.issues, undefined, 'an unfinished phase must not publish its watermark')
  assert.equal(cursor.work?.phase, 'issues')
  assert.equal(cursor.work?.issues_high, '2026-03-03T00:00:00Z', 'the high-water is staged on the work descriptor')
})

test('a failed commit subresource does not publish the commits cursor', async () => {
  const client = fakeClient({})
  client.listCommitsPage = async () => ({
    items: [{ sha: 'a'.repeat(40), commit: { author: { date: '2026-04-01T00:00:00Z' } } }],
    next: null,
  })
  client.listCommitFilesPage = async () => { throw new Error('rate limited') }
  const cursors = freshCursors()
  const result = await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async () => {},
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.equal(result.errors.length, 1)
  const cursor = cursors.repos['o/r']
  assert.equal(cursor.since?.commits, undefined, 'the commit-file sub-resource had not appended yet')
  assert.equal(cursor.work?.phase, 'commits')
  assert.equal(cursor.work?.commits_high, '2026-04-01T00:00:00Z')
})

test('a completed repo publishes every phase watermark and drops its work descriptor', async () => {
  const client = fakeClient({
    repos: {
      'o/r': {
        issues: [{ number: 1, state: 'open', updated_at: '2026-05-01T00:00:00Z' }],
        pulls: [{ number: 2, state: 'open', updated_at: '2026-05-02T00:00:00Z' }],
        commits: [{ sha: 'b'.repeat(40), commit: { author: { date: '2026-05-03T00:00:00Z' } } }],
        comments: [{ id: 3, issue_url: 'https://api.github.com/repos/o/r/issues/1', updated_at: '2026-05-04T00:00:00Z' }],
      },
    },
  })
  const cursors = freshCursors()
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async () => {},
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  const cursor = cursors.repos['o/r']
  assert.equal(cursor.work, undefined)
  assert.deepEqual(cursor.since, {
    issues: '2026-05-01T00:00:00Z',
    pulls: '2026-05-02T00:00:00Z',
    commits: '2026-05-03T00:00:00Z',
    comments: '2026-05-04T00:00:00Z',
  })
})

test('staged phase watermarks survive the cursor sidecar round trip', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-staged-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  writeCursors(stateDir, /** @type {any} */ ({
    schema_version: 1,
    repos: {
      'o/r': {
        work: {
          mode: 'poll',
          phase: 'commits',
          issues_high: '2026-06-01T00:00:00Z',
          commits_high: '2026-06-02T00:00:00Z',
          comments_high: '2026-06-03T00:00:00Z',
        },
      },
    },
  }))
  const work = readCursors(stateDir).repos['o/r'].work
  assert.equal(work?.issues_high, '2026-06-01T00:00:00Z')
  assert.equal(work?.commits_high, '2026-06-02T00:00:00Z')
  assert.equal(work?.comments_high, '2026-06-03T00:00:00Z')
})
