// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { captureRepos, resolveRepos } from '../../hypaware-core/plugins-workspace/github/src/capture.js'
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
  client.listIssues = async (_owner, _repo, cursor) => {
    cursor.since = { issues: '2026-09-02T12:00:00.000Z' }
    return [{ number: 1, state: 'open' }]
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
  assert.deepEqual(cursors.repos['o/r'], {})
})

test('a failed PR subresource does not publish the pulls cursor', async () => {
  const client = fakeClient({})
  client.listPullRequests = async (_owner, _repo, cursor) => {
    cursor.etag = { pulls: 'etag-new' }
    return [{ number: 7, state: 'open', updated_at: '2026-09-02T12:00:00.000Z' }]
  }
  client.listPullRequestFiles = async () => { throw new Error('rate limited') }
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
  assert.deepEqual(cursors.repos['o/r'], {})
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
