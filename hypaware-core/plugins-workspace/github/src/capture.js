// @ts-check

import { commitKey, repoKey, str } from './keys.js'
import { cursorFor } from './cursors.js'

/**
 * Capture orchestration: turn the active local inventory into appended
 * `github_events` rows. Storage-agnostic: `append` and the GitHub `client` are
 * injected, so tests drive the whole pipeline without a network or cache.
 *
 * Three `ignore[]` invariants are enforced **here, at capture** (LLP 0360):
 * rows for an ignored repo never enter `github_events`, so they never reach the
 * graph; ignore is forward-only (it filters the *fetch*, it does not retract
 * already-captured rows); and it is exact `owner/repo` match (case-insensitive,
 * since GitHub is). There is no projection-time repo filter.
 *
 * @ref LLP 0360#three-invariants [implements]: ignore is enforced at capture, forward-only, exact-match
 *
 * @import { CursorState, GithubActor, GithubClient, GithubComment, GithubCommit, GithubConfig, GithubIssue, GithubPull, GithubReview, PluginLogger, RepoCursor } from './types.js'
 */

/**
 * Resolve the repository set to capture. `session_repos` consumes only the
 * export-eligible local session evidence supplied by the caller. `all_visible`
 * enumerates the authenticated identity. `ignore[]` wins in both modes.
 *
 * @param {GithubConfig} config
 * @param {GithubClient} client
 * @param {PluginLogger} log
 * @param {string[]} [observedRepos]
 * @returns {Promise<string[]>}
 */
// @ref LLP 0360#inventory [implements]: session evidence is the default complete inventory; all-visible is explicit
export async function resolveRepos(config, client, log, observedRepos) {
  const ignore = new Set(config.ignore.map((r) => r.toLowerCase()))
  /** @type {Set<string>} */
  const selected = new Set()
  const inventory = config.inventory ?? 'session_repos'

  if (inventory === 'session_repos') {
    for (const full of observedRepos ?? []) {
      const key = repoKey(full)
      if (key) selected.add(key)
    }
  } else {
    const visible = await client.listViewerRepos()
    for (const full of visible) {
      const key = repoKey(full)
      if (key) selected.add(key)
    }
  }

  const repos = [...selected].filter((repo) => !ignore.has(repo)).sort()
  log.info('github.inventory_resolved', {
    mode: inventory,
    candidates: selected.size,
    selected_repos: repos.length,
    ignored_repos: ignore.size,
  })
  return repos
}

/**
 * Capture every selected repo. `mode` controls the starting cursor:
 *   - `backfill` resets each repo's cursor to empty (fetch full history) but
 *     still persists the advanced cursor, seeding the poller so it resumes past
 *     history rather than re-fetching it;
 *   - `poll` starts from the persisted cursor (incremental).
 *
 * Per-repo errors are caught and recorded, not thrown, so one bad repo never
 * kills a whole tick. The caller persists `cursors` after this resolves.
 *
 * @param {object} args
 * @param {GithubClient} args.client
 * @param {GithubConfig} args.config
 * @param {CursorState} args.cursors
 * @param {(rows: Record<string, unknown>[]) => Promise<void>} args.append
 * @param {PluginLogger} args.log
 * @param {'backfill' | 'poll'} args.mode
 * @param {string[]} [args.only]  restrict to these repos (e.g. `hyp github backfill owner/repo`)
 * @param {string[]} [args.observedRepos] repositories evidenced by export-eligible local agent activity
 * @returns {Promise<{ repos: number, events: number, errors: Array<{ repo: string, error: string }> }>}
 */
export async function captureRepos({ client, config, cursors, append, log, mode, only, observedRepos }) {
  let repos = await resolveRepos(config, client, log, observedRepos)
  if (only && only.length > 0) {
    const onlySet = new Set(only.map((r) => r.toLowerCase()))
    repos = repos.filter((r) => onlySet.has(r))
  }

  let events = 0
  /** @type {Array<{ repo: string, error: string }>} */
  const errors = []

  for (const repo of repos) {
    if (mode === 'backfill') cursors.repos[repo] = {}
    const cursor = cursors.repos[repo] ?? (cursors.repos[repo] = {})
    let repoEvents = 0
    try {
      await captureRepo({
        client,
        repo,
        cursor,
        mode,
        append: async (rows) => {
          await append(rows)
          repoEvents += rows.length
        },
        log,
      })
    } catch (err) {
      const message = errMessage(err)
      errors.push({ repo, error: message })
      log.error('github.repo_capture_failed', { repo, error: message })
    }
    events += repoEvents
    // Persist the advanced cursor onto the shared state after each repo.
    cursors.repos[repo] = cursor
  }

  return { repos: repos.length, events, errors }
}

/**
 * Capture one repo through every pass, appending `github_events` rows. Returns
 * the number of event rows written.
 *
 * @param {object} args
 * @param {GithubClient} args.client
 * @param {string} args.repo  canonical `owner/repo`
 * @param {RepoCursor} args.cursor
 * @param {'backfill' | 'poll'} args.mode
 * @param {(rows: Record<string, unknown>[]) => Promise<void>} args.append
 * @param {PluginLogger} args.log
 * @returns {Promise<number>}
 */
async function captureRepo({ client, repo, cursor, mode, append }) {
  const [owner, name] = repo.split('/')
  /** @type {Set<number>} */
  const prNumbers = new Set()
  let written = 0

  /** @param {Record<string, unknown>[]} rows */
  async function flush(rows) {
    // Event-id namespaces are disjoint between capture passes. Deduplicate the
    // current API batch without retaining every commit-file id for an entire
    // repository backfill, where the set could otherwise dominate memory.
    const emitted = new Set()
    const fresh = rows.filter((r) => {
      const id = String(r.event_id)
      if (emitted.has(id)) return false
      emitted.add(id)
      return true
    })
    if (fresh.length === 0) return
    await append(fresh)
    written += fresh.length
  }

  // --- issues (non-PR; PRs come from the pulls pass) ---
  const issueCursor = cloneCursor(cursor)
  const issues = await client.listIssues(owner, name, issueCursor)
  await flush(
    issues
      .filter((it) => !it.pull_request)
      .map((it) => issueRow(repo, it)),
  )
  commitCursor(cursor, issueCursor)

  // --- pull requests + their sub-resources ---
  const pullCursor = cloneCursor(cursor)
  const pulls = await client.listPullRequests(owner, name, pullCursor)
  for (const pr of pulls) prNumbers.add(pr.number)
  await flush(pulls.map((pr) => pullRow(repo, pr)))

  // Only descend into a PR's sub-resources when the PR is new/changed since the
  // last run (backfill processes all). Bounds the per-tick N+1 over PRs.
  const pullsHigh = cursor.since?.pulls
  const toDescend = mode === 'backfill' ? pulls : pulls.filter((pr) => changedSince(pr, pullsHigh))
  for (const pr of toDescend) {
    const files = await client.listPullRequestFiles(owner, name, pr.number)
    await flush(files.map((path) => prFileRow(repo, pr, path)))

    const reviews = await client.listPullRequestReviews(owner, name, pr.number)
    await flush(reviews.map((rv) => reviewRow(repo, pr, rv)))

    const prCommits = await client.listPullRequestCommits(owner, name, pr.number)
    await flush(prCommits.map((c) => commitRow(repo, c, pr.number)))
  }
  advancePullsHigh(pullCursor, pulls)
  commitCursor(cursor, pullCursor)

  // --- repo-level commits + their files ---
  const commitsCursor = cloneCursor(cursor)
  const commits = await client.listCommits(owner, name, commitsCursor)
  await flush(commits.map((c) => commitRow(repo, c, null)))
  for (const c of commits) {
    const files = await client.listCommitFiles(owner, name, c.sha)
    await flush(files.map((path) => commitFileRow(repo, c, path)))
  }
  commitCursor(cursor, commitsCursor)

  // --- conversation comments (on issues AND PRs) ---
  const commentCursor = cloneCursor(cursor)
  const comments = await client.listIssueComments(owner, name, commentCursor)
  await flush(
    comments
      .map((c) => commentRow(repo, c, prNumbers))
      .filter((r) => r !== null),
  )
  commitCursor(cursor, commentCursor)

  return written
}

/* ---------------------------------------------------------------- row builders */

/**
 * @param {string} repo
 * @param {GithubIssue} it
 * @returns {Record<string, unknown>}
 */
function issueRow(repo, it) {
  return base('issue', `issue:${repoKey(repo)}#${it.number}`, repo, {
    actor_login: loginOf(it.user),
    actor_type: typeOf(it.user),
    number: it.number,
    state: str(it.state),
    created_at: str(it.created_at),
  })
}

/**
 * @param {string} repo
 * @param {GithubPull} pr
 * @returns {Record<string, unknown>}
 */
function pullRow(repo, pr) {
  const merged = pr.merged_at != null
  return base('pull_request', `pr:${repoKey(repo)}#${pr.number}`, repo, {
    actor_login: loginOf(pr.user),
    actor_type: typeOf(pr.user),
    number: pr.number,
    state: merged ? 'merged' : str(pr.state),
    created_at: str(pr.created_at),
    payload: { merged, draft: pr.draft === true },
  })
}

/**
 * @param {string} repo
 * @param {GithubPull} pr
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function prFileRow(repo, pr, path) {
  return base('pull_request_file', `prfile:${repoKey(repo)}#${pr.number}:${path}`, repo, {
    number: pr.number,
    path,
    created_at: str(pr.created_at),
  })
}

/**
 * @param {string} repo
 * @param {GithubPull} pr
 * @param {GithubReview} rv
 * @returns {Record<string, unknown>}
 */
function reviewRow(repo, pr, rv) {
  return base('review', `review:${rv.id}`, repo, {
    actor_login: loginOf(rv.user),
    actor_type: typeOf(rv.user),
    review_id: rv.id,
    review_state: str(rv.state),
    pr_number: pr.number,
    created_at: str(rv.submitted_at),
  })
}

/**
 * A commit row. `pr_number` is set when the commit was captured under a PR
 * (enabling `PullRequest -references-> Commit`); the repo-level pass passes null.
 *
 * @param {string} repo
 * @param {GithubCommit} c
 * @param {number | null} prNumber
 * @returns {Record<string, unknown>}
 */
function commitRow(repo, c, prNumber) {
  const id = prNumber == null ? `commit:${commitKey(c.sha)}` : `commit:${commitKey(c.sha)}:pr${prNumber}`
  return base('commit', id, repo, {
    actor_login: loginOf(c.author),
    actor_type: typeOf(c.author),
    sha: str(c.sha),
    pr_number: prNumber,
    created_at: commitDate(c),
  })
}

/**
 * @param {string} repo
 * @param {GithubCommit} c
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function commitFileRow(repo, c, path) {
  return base('commit_file', `commitfile:${commitKey(c.sha)}:${path}`, repo, {
    sha: str(c.sha),
    path,
    created_at: commitDate(c),
  })
}

/**
 * A conversation comment. Discriminated into `pull_request_comment` vs
 * `issue_comment` by whether its subject number was seen as a PR this run.
 *
 * @param {string} repo
 * @param {GithubComment} c
 * @param {Set<number>} prNumbers
 * @returns {Record<string, unknown> | null}
 */
function commentRow(repo, c, prNumbers) {
  const number = numberFromIssueUrl(c.issue_url)
  if (number == null) return null
  const onPr = prNumbers.has(number)
  return base(onPr ? 'pull_request_comment' : 'issue_comment', `comment:${c.id}`, repo, {
    actor_login: loginOf(c.user),
    actor_type: typeOf(c.user),
    number,
    created_at: str(c.created_at),
  })
}

/**
 * Build a row with every `github_events` column present (the cache writer wants
 * a stable shape); unset columns are null. `extra` overrides the nulls.
 *
 * @param {string} eventType
 * @param {string} eventId
 * @param {string} repo
 * @param {Record<string, unknown>} extra
 * @returns {Record<string, unknown>}
 */
function base(eventType, eventId, repo, extra) {
  return {
    event_id: eventId,
    event_type: eventType,
    repo,
    actor_login: null,
    actor_type: null,
    number: null,
    sha: null,
    path: null,
    review_id: null,
    review_state: null,
    state: null,
    pr_number: null,
    created_at: null,
    payload: null,
    ...extra,
  }
}

/* ---------------------------------------------------------------- helpers */

/** @param {GithubActor | null | undefined} actor */
function loginOf(actor) {
  return actor && typeof actor.login === 'string' ? actor.login : null
}

/** @param {GithubActor | null | undefined} actor */
function typeOf(actor) {
  return actor && typeof actor.type === 'string' ? actor.type : null
}

/** @param {GithubCommit} c @returns {string | null} */
function commitDate(c) {
  const author = c.commit && typeof c.commit.author === 'object' ? c.commit.author : null
  return author && typeof author.date === 'string' ? author.date : null
}

/**
 * Extract the trailing issue/PR number from a comment's `issue_url`
 * (`.../issues/123`).
 *
 * @param {string | undefined} issueUrl
 * @returns {number | null}
 */
function numberFromIssueUrl(issueUrl) {
  if (!issueUrl) return null
  const m = /\/issues\/(\d+)(?:$|[?#])/.exec(issueUrl)
  return m ? Number(m[1]) : null
}

/**
 * @param {GithubPull} pr
 * @param {string | undefined} high
 * @returns {boolean}
 */
function changedSince(pr, high) {
  if (!high) return true
  const updated = updatedAt(pr)
  return updated == null || updated > high
}

/**
 * @param {CursorState['repos'][string]} cursor
 * @param {GithubPull[]} pulls
 */
function advancePullsHigh(cursor, pulls) {
  let max = cursor.since?.pulls
  for (const pr of pulls) {
    const t = updatedAt(pr)
    if (t && (!max || t > max)) max = t
  }
  if (max) {
    if (!cursor.since) cursor.since = {}
    cursor.since.pulls = max
  }
}

/**
 * Clone mutable API cursor state for one capture phase. A client is allowed to
 * advance the clone while listing, but the durable cursor is updated only
 * after that phase's rows and dependent sub-resources have landed.
 *
 * @param {RepoCursor} cursor
 * @returns {RepoCursor}
 */
function cloneCursor(cursor) {
  return {
    ...(cursor.since ? { since: { ...cursor.since } } : {}),
    ...(cursor.etag ? { etag: { ...cursor.etag } } : {}),
  }
}

/**
 * Replace a cursor in place so the object held by the repository state remains
 * stable while a successfully captured phase publishes its high-water marks.
 *
 * @param {RepoCursor} target
 * @param {RepoCursor} next
 */
function commitCursor(target, next) {
  delete target.since
  delete target.etag
  if (next.since) target.since = { ...next.since }
  if (next.etag) target.etag = { ...next.etag }
}

/** @param {GithubPull} pr @returns {string | null} */
function updatedAt(pr) {
  return typeof pr.updated_at === 'string' ? pr.updated_at : typeof pr.created_at === 'string' ? pr.created_at : null
}

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
}
