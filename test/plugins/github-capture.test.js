// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { captureRepos, resolveRepos } from '../../hypaware-core/plugins-workspace/github/src/capture.js'
import { runGithubSync } from '../../hypaware-core/plugins-workspace/github/src/commands.js'
import { readCursors, writeCursors } from '../../hypaware-core/plugins-workspace/github/src/cursors.js'
import { setGithubRuntime } from '../../hypaware-core/plugins-workspace/github/src/runtime.js'
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
  const err = Object.assign(new Error('404 for GET /repos/o/r/issues'), { hypErrorKind: 'github_api_error' })
  client.listIssuesPage = async () => { throw err }
  const cursors = freshCursors()
  /** @type {Array<{ name: string, attrs: any }>} */
  const errors = []
  const result = await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async () => {},
    log: { ...silentLog, error(name, attrs) { errors.push({ name, attrs }) } },
    mode: 'poll',
    observedRepos: ['o/r'],
  })
  assert.equal(result.errors.length, 1)
  // The per-repo handler is where a refused continuation lands, and the
  // whole-tick handler in source.js never sees it, so the kind has to be on
  // this log line to be filterable at all.
  assert.equal(errors[0].name, 'github.repo_capture_failed')
  assert.equal(errors[0].attrs.error_kind, 'github_api_error')
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

test('a budget-stopped tick reports the repositories it visited, not the whole inventory', async () => {
  const result = await captureRepos({
    client: fakeClient({}),
    config: cfg(),
    cursors: freshCursors(),
    append: async () => {},
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/a', 'o/b', 'o/c'],
    requestLimit: 1,
  })

  assert.equal(result.pending, true, 'the budget stopped the tick with repositories left')
  assert.equal(result.visited, 1, 'the tick reached exactly one repository before the budget ran out')
  assert.equal(result.repos, 3, 'the inventory size stays available for the selection checks')
})

test('hyp github sync counts the repositories the budget let it visit', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-sync-budget-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    config: cfg(),
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
  let out = ''
  const ctx = /** @type {any} */ ({
    stdout: { write(/** @type {string} */ chunk) { out += chunk } },
    stderr: { write() {} },
  })

  const code = await runGithubSync([], ctx)

  assert.equal(code, 0)
  assert.match(out, /github sync: 1 event\(s\) across 1 repo\(s\)\n/)
  assert.match(out, /bounded work remains/)
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

test('a PR the same tick discovers on the issues page is captured when it ties the pulls high-water', async () => {
  const TIE = '2026-02-01T00:00:00Z'
  const client = fakeClient({
    repos: {
      'o/r': {
        // `/issues` returns PRs too, so this tick learns #12 is a PR before the pulls pass runs.
        issues: [{ number: 12, pull_request: {}, state: 'open', created_at: TIE, updated_at: TIE, user: { login: 'Bob' } }],
        pulls: [{ number: 12, state: 'open', created_at: TIE, updated_at: TIE, merged_at: null, user: { login: 'Bob', type: 'User' } }],
        comments: [{ id: 21, created_at: TIE, user: { login: 'Eve' }, issue_url: 'https://api.github.com/repos/o/r/issues/12' }],
      },
    },
  })
  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { issues: '2026-01-01T00:00:00Z', pulls: TIE }, pull_numbers: [7] }
  const rows = []
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.deepEqual(
    rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number),
    [12],
    'the unseen tied pull is captured, not swallowed by its own issues-page sighting',
  )
  assert.deepEqual(
    rows.filter((row) => row.event_type === 'pull_request_comment').map((row) => row.number),
    [12],
    'its comment projects onto a pull node the same tick minted',
  )
  assert.deepEqual(cursors.repos['o/r'].pulls_high_numbers, [12], 'the captured tie is remembered as captured, apart from pull_numbers')
})

test('an older sidecar with no captured-pull set still suppresses a tie it already captured', async () => {
  const TIE = '2026-02-01T00:00:00Z'
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-cursors-old-'))
  // The pre-`pulls_high_numbers` sidecar shape, written by hand: what an
  // installed release leaves behind.
  fs.writeFileSync(
    path.join(stateDir, 'github-cursors.json'),
    JSON.stringify({ schema_version: 1, repos: { 'o/r': { since: { issues: '2026-01-01T00:00:00Z', pulls: TIE }, pull_numbers: [10] } } }, null, 2),
    'utf8',
  )
  const cursors = readCursors(stateDir)
  fs.rmSync(stateDir, { recursive: true, force: true })
  assert.equal(cursors.repos['o/r'].pulls_high_numbers, undefined)
  assert.deepEqual(cursors.repos['o/r'].pull_numbers, [10])

  const client = fakeClient({
    repos: {
      'o/r': {
        pulls: [
          { number: 10, state: 'open', created_at: TIE, updated_at: TIE, merged_at: null, user: { login: 'Bob' } },
          { number: 11, state: 'open', created_at: TIE, updated_at: TIE, merged_at: null, user: { login: 'Ada' } },
        ],
      },
    },
  })
  const rows = []
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.deepEqual(
    rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number),
    [11],
    'the absent set falls back to pull_numbers, so an already-captured tie is not re-emitted',
  )
  assert.deepEqual(cursors.repos['o/r'].pulls_high_numbers, [10, 11], 'the tick publishes the dedicated set the next tick reads')
})

test('a 304 pulls phase does not retire an older sidecar fallback by publishing an empty captured set', async () => {
  const TIE = '2026-02-01T00:00:00Z'
  const pull = { number: 10, state: 'open', created_at: TIE, updated_at: TIE, merged_at: null, user: { login: 'Bob' } }
  const client = fakeClient({ repos: { 'o/r': { pulls: [pull] } } })
  let notModified = true
  client.listPullRequestsPage = async () => (notModified
    ? { items: [], next: null, notModified: true }
    : { items: [pull], next: null, etag: 'etag-2' })

  // The pre-`pulls_high_numbers` shape, with the saved etag an installed
  // release leaves behind: the first tick after the upgrade sees a 304 and so
  // observes no pull at the boundary second at all.
  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { issues: '2026-01-01T00:00:00Z', pulls: TIE }, etag: { pulls: 'etag-1' }, pull_numbers: [10] }
  /** @param {Record<string, unknown>[]} into */
  const tick = (into) => captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { into.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  await tick([])
  assert.equal(cursors.repos['o/r'].pulls_high_numbers, undefined, 'no evidence about the boundary second is not evidence of none')

  notModified = false
  const rows = []
  await tick(rows)
  assert.deepEqual(
    rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number),
    [],
    'the fallback survived the 304, so the already-captured tie is still suppressed',
  )
  assert.deepEqual(cursors.repos['o/r'].pulls_high_numbers, [10], 'and the listing tick publishes the dedicated set')
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
          pulls_emitted: [9],
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

test('a second tick over unchanged upstream state appends nothing', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-boundary-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const client = fakeClient({
    repos: {
      'o/r': {
        issues: [
          { number: 1, state: 'open', created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z' },
          { number: 4, state: 'open', created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z' },
        ],
        pulls: [{ number: 2, state: 'open', created_at: '2026-05-02T00:00:00Z', updated_at: '2026-05-02T00:00:00Z' }],
        prFiles: { 2: ['src/a.js'] },
        commits: [{ sha: 'b'.repeat(40), commit: { author: { date: '2026-05-03T00:00:00Z' } } }],
        commitFiles: { ['b'.repeat(40)]: ['README.md'] },
        comments: [
          { id: 3, issue_url: 'https://api.github.com/repos/o/r/issues/1', created_at: '2026-05-04T00:00:00Z', updated_at: '2026-05-04T00:00:00Z' },
          { id: 5, issue_url: 'https://api.github.com/repos/o/r/issues/1', created_at: '2026-05-04T00:00:00Z', updated_at: '2026-05-04T00:00:00Z' },
        ],
      },
    },
  })
  // Through the sidecar, the way the daemon runs it: a boundary guard the
  // cursor reader drops would re-append on every restart.
  /** @param {Record<string, unknown>[]} into */
  const tick = async (into) => {
    const cursors = readCursors(stateDir)
    try {
      return await captureRepos({
        client,
        config: cfg(),
        cursors,
        append: async (batch) => { into.push(...batch) },
        log: silentLog,
        mode: 'poll',
        observedRepos: ['o/r'],
      })
    } finally {
      writeCursors(stateDir, cursors)
    }
  }

  /** @type {Record<string, unknown>[]} */
  const first = []
  await tick(first)
  assert.ok(first.length > 0, 'the first tick captures the repository')

  /** @type {Record<string, unknown>[]} */
  const second = []
  const result = await tick(second)
  assert.deepEqual(second, [], 'no new activity means no new rows')
  assert.equal(result.events, 0)

  /** @type {Record<string, unknown>[]} */
  const third = []
  await tick(third)
  assert.deepEqual(third, [], 'and the tick after that appends nothing either')
})

test('an item tied at the watermark but not yet captured is still captured next tick', async () => {
  const AT = '2026-05-01T00:00:00Z'
  const repo = {
    /** @type {any[]} */
    issues: [{ number: 1, state: 'open', created_at: AT, updated_at: AT }],
    /** @type {any[]} */
    commits: [{ sha: 'a'.repeat(40), commit: { author: { date: AT } } }],
    /** @type {any[]} */
    comments: [{ id: 3, issue_url: 'https://api.github.com/repos/o/r/issues/1', created_at: AT, updated_at: AT }],
  }
  const client = fakeClient({ repos: { 'o/r': repo } })
  const cursors = freshCursors()
  /** @param {Record<string, unknown>[]} into */
  const tick = (into) => captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { into.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  await tick([])
  // Same second as the watermark, but published after the first tick read it:
  // an exclusive boundary would lose these forever.
  repo.issues.push({ number: 2, state: 'open', created_at: AT, updated_at: AT })
  repo.commits.push({ sha: 'c'.repeat(40), commit: { author: { date: AT } } })
  repo.comments.push({ id: 4, issue_url: 'https://api.github.com/repos/o/r/issues/1', created_at: AT, updated_at: AT })

  /** @type {Record<string, unknown>[]} */
  const second = []
  await tick(second)
  assert.deepEqual(second.map((row) => row.event_id).sort(), [
    'comment:4',
    `commit:${'c'.repeat(40)}`,
    'issue:o/r#2',
  ])
})

test('new activity does not drag the already-captured boundary rows back in', async () => {
  const AT = '2026-05-01T00:00:00Z'
  const LATER = '2026-05-02T00:00:00Z'
  const repo = {
    /** @type {any[]} */
    issues: [{ number: 1, state: 'open', created_at: AT, updated_at: AT }],
    /** @type {any[]} */
    commits: [{ sha: 'a'.repeat(40), commit: { author: { date: AT } } }],
    /** @type {any[]} */
    comments: [{ id: 3, issue_url: 'https://api.github.com/repos/o/r/issues/1', created_at: AT, updated_at: AT }],
  }
  const client = fakeClient({ repos: { 'o/r': repo } })
  const cursors = freshCursors()
  /** @param {Record<string, unknown>[]} into */
  const tick = (into) => captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { into.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  await tick([])
  // Something newer arrives. The real listings put it AHEAD of the boundary
  // rows, so a gate that forgets the boundary the moment it raises its
  // watermark re-appends everything behind the new item.
  repo.issues.push({ number: 2, state: 'open', created_at: LATER, updated_at: LATER })
  repo.commits.push({ sha: 'c'.repeat(40), commit: { author: { date: LATER } } })
  repo.comments.push({ id: 4, issue_url: 'https://api.github.com/repos/o/r/issues/1', created_at: LATER, updated_at: LATER })

  /** @type {Record<string, unknown>[]} */
  const second = []
  await tick(second)
  assert.deepEqual(second.map((row) => row.event_id).sort(), [
    'comment:4',
    `commit:${'c'.repeat(40)}`,
    'issue:o/r#2',
  ], 'only the new items, never the boundary rows behind them')

  /** @type {Record<string, unknown>[]} */
  const third = []
  await tick(third)
  assert.deepEqual(third, [], 'and the new boundary is carried in turn')
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

test('a refused continuation clears the poisoned work so the next tick captures the repo again', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-foreign-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  // A hand-tampered sidecar: the persisted continuation addresses an origin the
  // client refuses. A live `Link` header cannot get here any more, because the
  // client pins `next` on the response that carried it.
  writeCursors(stateDir, /** @type {any} */ ({
    schema_version: 1,
    repos: {
      'o/r': {
        since: { issues: '2026-01-01T00:00:00Z' },
        work: { mode: 'poll', phase: 'issues', page: 'https://evil.test/repos/o/r/issues?page=2' },
      },
    },
  }))

  const issues = [{ number: 1, state: 'open', created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', user: { login: 'a', type: 'User' } }]
  const client = fakeClient({})
  // The real client pins every URL to the configured API origin before it
  // spends the token, so a continuation is refused rather than fetched.
  client.listIssuesPage = async (_owner, _repo, since, page) => {
    if (page !== undefined) {
      throw Object.assign(new Error('GitHub continuation URL refused: it does not address the configured API base (origin https://evil.test)'), { hypErrorKind: 'github_foreign_origin' })
    }
    return { items: issues.filter((it) => !since || it.updated_at > since), next: null }
  }

  /** One tick: read the sidecar, capture, persist - the `tick.js` sequence. */
  async function tick() {
    /** @type {Record<string, unknown>[]} */
    const rows = []
    const cursors = readCursors(stateDir)
    const result = await captureRepos({
      client,
      config: cfg(),
      cursors,
      append: async (batch) => { rows.push(...batch) },
      log: silentLog,
      mode: 'poll',
      observedRepos: ['o/r'],
    })
    writeCursors(stateDir, cursors)
    return { rows, result }
  }

  const refused = await tick()
  assert.equal(refused.rows.length, 0, 'the refused tick captures nothing')
  assert.equal(refused.result.errors.length, 1)
  assert.equal(readCursors(stateDir).repos['o/r'].work, undefined, 'the poisoned work is gone from the sidecar')

  const recovered = await tick()
  assert.deepEqual(recovered.rows.map((row) => row.event_id), ['issue:o/r#1'], 'the repo produces rows again on the following tick')
  assert.equal(readCursors(stateDir).repos['o/r'].since?.issues, '2026-02-01T00:00:00Z')

  // The restart is the last-completed-phase retry LLP 0360#cursoring settles.
  // Here the poison sits at the head of the phase, so there is nothing already
  // appended to replay and a third tick adds nothing. Poison a phase that had
  // part-appended and the restart re-appends that prefix instead, which the
  // same decision accepts ("rows appended by an earlier attempt remain valid
  // snapshots"): the staged high-water is deliberately NOT published on the
  // clear, because publishing it would skip the pages the phase never fetched.
  const settled = await tick()
  assert.deepEqual(settled.rows, [])
  const ids = [...refused.rows, ...recovered.rows, ...settled.rows].map((row) => row.event_id)
  assert.equal(new Set(ids).size, ids.length, 'no duplicate event ids across the three ticks')
})

test('a boundary pull re-listed on a later page of the same phase is captured once', async () => {
  const TIE = '2026-02-01T00:00:00Z'
  const older = '2026-01-31T00:00:00Z'
  const tied = { number: 12, state: 'open', created_at: TIE, updated_at: TIE, merged_at: null, user: { login: 'Bob' } }
  const stale = { number: 9, state: 'open', created_at: older, updated_at: older, merged_at: null, user: { login: 'Ada' } }
  const client = fakeClient({ repos: { 'o/r': { pulls: [] } } })
  // `sort=updated&direction=desc` reshuffles under pagination: a pull updated
  // mid-traversal pushes an item back across the page boundary, so one phase
  // can list #12 twice.
  client.listPullRequestsPage = async (owner, name, etag, page) => (page === undefined
    ? { items: [tied], next: 'p2' }
    : { items: [tied, stale], next: null })

  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { issues: '2026-01-01T00:00:00Z', pulls: TIE }, pull_numbers: [] }
  const rows = []
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.deepEqual(
    rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number),
    [12],
    'the second sighting is suppressed by the page that captured it, not re-emitted',
  )
})

test('a pull newer than the baseline re-listed on a later page of the same phase is captured once', async () => {
  const baseline = '2026-01-31T00:00:00Z'
  const newer = '2026-02-01T00:00:00Z'
  const older = '2026-01-30T00:00:00Z'
  const bumped = { number: 12, state: 'open', created_at: older, updated_at: newer, merged_at: null, user: { login: 'Bob' } }
  const stale = { number: 9, state: 'open', created_at: older, updated_at: older, merged_at: null, user: { login: 'Ada' } }
  // #12 carries sub-resources, so a second fan-out would show up as a repeated
  // event id: an empty fixture makes the id assertion below agree with itself.
  const client = fakeClient({ repos: { 'o/r': { pulls: [], prFiles: { 12: ['a.js'] }, prReviews: { 12: [{ id: 5, user: { login: 'Ada' }, state: 'APPROVED', submitted_at: newer }] }, prCommits: { 12: [{ sha: 'c1', commit: { message: 'm', author: { date: newer } } }] } } } })
  // The same reshuffle, one second above the boundary: `sort=updated&direction=desc`
  // pushes an item back across the page boundary mid-traversal, so one phase lists
  // #12 twice with `updated_at` strictly newer than the baseline, where the tie
  // guard has nothing to say.
  client.listPullRequestsPage = async (owner, name, etag, page) => (page === undefined
    ? { items: [bumped], next: 'p2' }
    : { items: [bumped, stale], next: null })

  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { issues: '2026-01-01T00:00:00Z', pulls: baseline }, pull_numbers: [] }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.deepEqual(
    rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number),
    [12],
    'one update, one row, however many pages listed it',
  )
  const ids = rows.map((row) => row.event_id)
  assert.equal(new Set(ids).size, ids.length, 'and the second sighting fans out no duplicate sub-resources either')
})

test('backfill takes the same cross-page guard: a re-listed pull is captured once', async () => {
  const at = '2026-02-01T00:00:00Z'
  const bumped = { number: 12, state: 'open', created_at: at, updated_at: at, merged_at: null, user: { login: 'Bob' } }
  const client = fakeClient({ repos: { 'o/r': { pulls: [] } } })
  // Backfill has no baseline to filter on, so every re-listing the reshuffle
  // produces used to be emitted verbatim, and a backfill traversal is the long one.
  client.listPullRequestsPage = async (owner, name, etag, page) => (page === undefined
    ? { items: [bumped], next: 'p2' }
    : { items: [bumped], next: null })

  const { rows } = await capture({ config: cfg(), client, mode: 'backfill', observedRepos: ['o/r'] })
  assert.deepEqual(
    rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number),
    [12],
    'one pull, one row',
  )
})

test('the cross-page guard survives a pulls phase the request budget splits across ticks', async () => {
  const baseline = '2026-01-31T00:00:00Z'
  const newer = '2026-02-01T00:00:00Z'
  const older = '2026-01-30T00:00:00Z'
  const bumped = { number: 12, state: 'open', created_at: older, updated_at: newer, merged_at: null, user: { login: 'Bob' } }
  const stale = { number: 9, state: 'open', created_at: older, updated_at: older, merged_at: null, user: { login: 'Ada' } }
  const client = fakeClient({ repos: { 'o/r': { pulls: [], prFiles: { 12: ['a.js'] } } } })
  client.listPullRequestsPage = async (owner, name, etag, page) => (page === undefined
    ? { items: [bumped], next: 'p2' }
    : { items: [bumped, stale], next: null })

  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { issues: '2026-01-01T00:00:00Z', pulls: baseline }, pull_numbers: [] }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  const base = {
    client,
    config: cfg(),
    cursors,
    append: async (/** @type {Record<string, unknown>[]} */ batch) => { rows.push(...batch) },
    log: silentLog,
    mode: /** @type {const} */ ('poll'),
    observedRepos: ['o/r'],
  }
  // Two requests reach page one and no further, so the reshuffled page two is
  // read on the next tick, from a fresh `captureRepo` call.
  const first = await captureRepos({ ...base, requestLimit: 2 })
  assert.equal(first.pending, true)
  assert.deepEqual(cursors.repos['o/r'].work?.pulls_emitted, [12], 'the guard is staged on the work descriptor, not left in memory')
  await captureRepos({ ...base, requestLimit: 50 })

  assert.deepEqual(
    rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number),
    [12],
    'one update, one row, however many ticks the phase took',
  )
  const ids = rows.map((row) => row.event_id)
  assert.equal(new Set(ids).size, ids.length, 'and the resumed page fans out no duplicate sub-resources either')
})

test('a pulls phase begun this tick does not inherit a staged set from before it', async () => {
  // `beginPulls` resets `pulls_emitted` for the phase it opens. A guard read
  // once per tick would be seeded above that reset, so a descriptor carrying
  // the field on some other phase would suppress pulls this phase never
  // emitted, dropping the row and its fan-out with nothing to show for it.
  const newer = '2026-02-01T00:00:00Z'
  const bumped = { number: 12, state: 'open', created_at: '2026-01-30T00:00:00Z', updated_at: newer, merged_at: null, user: { login: 'Bob' } }
  const client = fakeClient({ repos: { 'o/r': { pulls: [], prFiles: { 12: ['a.js'] } } } })
  client.listIssuesPage = async () => ({ items: [], next: null })
  client.listPullRequestsPage = async () => ({ items: [bumped], next: null })

  const cursors = freshCursors()
  cursors.repos['o/r'] = {
    since: { issues: '2026-01-01T00:00:00Z', pulls: '2026-01-31T00:00:00Z' },
    pull_numbers: [],
    work: { mode: 'poll', phase: 'issues', pulls_emitted: [12] },
  }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.deepEqual(
    rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number),
    [12],
    'the phase this tick opened guards only what this tick emitted',
  )
})

test('a pulls phase resumed from a pre-field work descriptor publishes no partial captured set', async () => {
  const TIE = '2026-02-01T00:00:00Z'
  const older = '2026-01-31T00:00:00Z'
  const at = (number) => ({ number, state: 'open', created_at: TIE, updated_at: TIE, merged_at: null, user: { login: 'Bob' } })
  const stale = { number: 9, state: 'open', created_at: older, updated_at: older, merged_at: null, user: { login: 'Ada' } }
  const client = fakeClient({ repos: { 'o/r': { pulls: [] } } })
  client.listPullRequestsPage = async (owner, name, etag, page) => (page === 'p2'
    ? { items: [at(11), stale], next: null }
    : { items: [at(13), at(12), at(11), stale], next: null })

  // What the previous release leaves behind when its request budget runs out
  // mid-pulls-phase: `pulls_high` staged, no `pulls_high_numbers`. Pages 1..N-1
  // already captured #13 and #12 at the boundary second, and nothing on the
  // remaining pages can say so.
  const cursors = freshCursors()
  cursors.repos['o/r'] = {
    since: { issues: '2026-01-01T00:00:00Z', pulls: TIE },
    pull_numbers: [11, 12, 13],
    work: { mode: 'poll', phase: 'pulls', page: 'p2', baseline_pulls: TIE, pulls_high: TIE, pull_tasks: [] },
  }
  /** @param {Record<string, unknown>[]} into */
  const tick = (into) => captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { into.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  await tick([])
  assert.equal(cursors.repos['o/r'].pulls_high_numbers, undefined, 'half a phase is not an answer about the boundary second')

  const rows = []
  await tick(rows)
  assert.deepEqual(
    rows.filter((row) => row.event_type === 'pull_request').map((row) => row.number),
    [],
    'the pull_numbers fallback still covers the pulls the interrupted phase captured',
  )
  assert.deepEqual(cursors.repos['o/r'].pulls_high_numbers, [11, 12, 13], 'and a whole phase publishes the dedicated set')
})

test('an issue re-listed on a later page of the same phase, below its high water, is captured once', async () => {
  // `/issues?state=all` carries no `sort`, so GitHub's default `created`
  // descending applies. An issue created mid-traversal shifts every later
  // offset and pushes the page-one tail onto page two, at a timestamp above
  // `since` and below the page's own high water, where neither the boundary
  // floor nor the tie set has anything to say.
  const created = '2026-02-02T00:00:00Z'
  const below = '2026-02-01T00:00:00Z'
  const fresh = { number: 5, state: 'open', created_at: created, updated_at: created, user: { login: 'Bob' } }
  const shifted = { number: 3, state: 'open', created_at: below, updated_at: below, user: { login: 'Ada' } }
  const client = fakeClient({ repos: { 'o/r': {} } })
  client.listIssuesPage = async (_owner, _name, _since, page) => (page === undefined
    ? { items: [fresh, shifted], next: 'p2' }
    : { items: [shifted], next: null })

  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { issues: '2026-01-01T00:00:00Z' } }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.deepEqual(
    rows.filter((row) => row.event_type === 'issue').map((row) => row.number),
    [5, 3],
    'one issue, one row, however many pages listed it',
  )
})

test('a commit re-listed on a later page of the same phase is captured once, and fans out its files once', async () => {
  // `/commits` is reverse-chronological, so a push mid-traversal reshuffles it
  // the same way. The second sighting costs more than a row here: an admitted
  // commit re-enters `commit_tasks` and re-fetches its file list.
  const pushed = '2026-02-02T00:00:00Z'
  const below = '2026-02-01T00:00:00Z'
  /** @param {string} sha @param {string} at */
  const commit = (sha, at) => ({ sha, author: { login: 'Ada' }, commit: { author: { date: at } } })
  /** @type {string[]} */
  const calls = []
  const client = fakeClient({ calls, repos: { 'o/r': { commitFiles: { newsha: ['b.js'], shifted: ['a.js'] } } } })
  client.listCommitsPage = async (_owner, _name, _since, page) => (page === undefined
    ? { items: [commit('newsha', pushed), commit('shifted', below)], next: 'p2' }
    : { items: [commit('shifted', below)], next: null })

  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { commits: '2026-01-01T00:00:00Z' } }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.deepEqual(
    rows.filter((row) => row.event_type === 'commit').map((row) => row.sha),
    ['newsha', 'shifted'],
    'one commit, one row',
  )
  assert.deepEqual(
    rows.filter((row) => row.event_type === 'commit_file').map((row) => row.path),
    ['b.js', 'a.js'],
    'and one sub-resource fan-out',
  )
  assert.deepEqual(
    calls.filter((call) => call.startsWith('listCommitFiles')),
    ['listCommitFiles:o/r@newsha', 'listCommitFiles:o/r@shifted'],
    'the re-listing re-spends no request either',
  )
})

test('a comment re-listed on a later page of the same phase is captured once', async () => {
  const posted = '2026-02-02T00:00:00Z'
  const below = '2026-02-01T00:00:00Z'
  /** @param {number} id @param {string} at */
  const comment = (id, at) => ({ id, created_at: at, updated_at: at, user: { login: 'Ada' }, issue_url: 'https://api.github.com/repos/o/r/issues/1' })
  const client = fakeClient({ repos: { 'o/r': {} } })
  client.listIssueCommentsPage = async (_owner, _name, _since, page) => (page === undefined
    ? { items: [comment(22, posted), comment(21, below)], next: 'p2' }
    : { items: [comment(21, below)], next: null })

  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { comments: '2026-01-01T00:00:00Z' } }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  const ids = rows.filter((row) => String(row.event_type).endsWith('_comment')).map((row) => row.event_id)
  assert.deepEqual(ids, ['comment:22', 'comment:21'], 'one comment, one row')
})

test("the gate's cross-page guard survives a phase the request budget splits across ticks", async (t) => {
  // The half a tick-local guard cannot cover: `budget.take()` persists the page
  // and returns, and the descriptor round-trips through the sidecar reader
  // before the reshuffled page two is ever fetched.
  const created = '2026-02-02T00:00:00Z'
  const below = '2026-02-01T00:00:00Z'
  const fresh = { number: 5, state: 'open', created_at: created, updated_at: created, user: { login: 'Bob' } }
  const shifted = { number: 3, state: 'open', created_at: below, updated_at: below, user: { login: 'Ada' } }
  const client = fakeClient({ repos: { 'o/r': {} } })
  client.listIssuesPage = async (_owner, _name, _since, page) => (page === undefined
    ? { items: [fresh, shifted], next: 'p2' }
    : { items: [shifted], next: null })

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-gate-emitted-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { issues: '2026-01-01T00:00:00Z' } }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  /** @param {CursorState} state @param {number} requestLimit */
  const tick = (state, requestLimit) => captureRepos({
    client,
    config: cfg(),
    cursors: state,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
    requestLimit,
  })

  // One request reaches page one and no further.
  const first = await tick(cursors, 1)
  assert.equal(first.pending, true)
  assert.deepEqual(
    cursors.repos['o/r'].work?.gate_emitted,
    ['issue:o/r#5', 'issue:o/r#3'],
    'the guard is staged on the work descriptor, not left in memory',
  )

  writeCursors(stateDir, cursors)
  const resumed = readCursors(stateDir)
  assert.deepEqual(
    resumed.repos['o/r'].work?.gate_emitted,
    ['issue:o/r#5', 'issue:o/r#3'],
    'and the sidecar reader admits it, so the resumed page still has it',
  )
  await tick(resumed, 50)

  assert.deepEqual(
    rows.filter((row) => row.event_type === 'issue').map((row) => row.number),
    [5, 3],
    'one issue, one row, however many ticks the phase took',
  )
})

test('a gate phase begun this tick does not inherit the staged set of the phase before it', async () => {
  // The seeding-point hazard, in the direction that loses rows rather than
  // duplicating them: the field is shared by the three gate phases, so a set
  // still on the descriptor when the next one opens would suppress items that
  // phase never appended.
  const at = '2026-02-02T00:00:00Z'
  const client = fakeClient({
    repos: { 'o/r': { commits: [{ sha: 'c1', author: { login: 'Ada' }, commit: { author: { date: at } } }] } },
  })

  const cursors = freshCursors()
  cursors.repos['o/r'] = {
    since: { commits: '2026-01-01T00:00:00Z' },
    work: { mode: 'poll', phase: 'issues', gate_emitted: ['commit:c1'] },
  }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  await captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  assert.deepEqual(
    rows.filter((row) => row.event_type === 'commit').map((row) => row.sha),
    ['c1'],
    'the phase this tick opened guards only what this tick appended',
  )
})

test('an item re-listed at the phase watermark second still claims its place in the published boundary', async () => {
  // The half the phase-scoped set cannot answer for on its own. An issue edited
  // mid-traversal is re-listed at a NEWER `updated_at` than the sighting that
  // appended it, and that timestamp is the watermark the phase publishes. The
  // guard refuses the second sighting, so if the refusal also skipped the
  // boundary claim the cursor would publish a watermark whose floor set omits
  // the one item sitting on it, and the next tick's inclusive `since` would
  // append exactly the row the refusal saved.
  const older = '2026-02-01T00:00:00Z'
  const newer = '2026-02-03T00:00:00Z'
  /** @param {string} at */
  const issue = (at) => ({ number: 3, state: 'open', created_at: older, updated_at: at, user: { login: 'Ada' } })
  const client = fakeClient({ repos: { 'o/r': {} } })
  let reshuffled = false
  client.listIssuesPage = async (_owner, _name, _since, page) => {
    if (reshuffled) return { items: [issue(newer)], next: null }
    return page === undefined ? { items: [issue(older)], next: 'p2' } : { items: [issue(newer)], next: null }
  }

  const cursors = freshCursors()
  cursors.repos['o/r'] = { since: { issues: '2026-01-01T00:00:00Z' } }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  const tick = () => captureRepos({
    client,
    config: cfg(),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r'],
  })

  await tick()
  assert.deepEqual(
    cursors.repos['o/r'].boundary?.issues,
    ['issue:o/r#3'],
    'the watermark second publishes the identity that sits on it',
  )

  // The next poll asks from that watermark, which is inclusive, so the issue
  // comes back and only the floor set can refuse it.
  reshuffled = true
  await tick()
  assert.deepEqual(
    rows.filter((row) => row.event_type === 'issue').map((row) => row.number),
    [3],
    'one issue, one row, across both ticks',
  )
})
