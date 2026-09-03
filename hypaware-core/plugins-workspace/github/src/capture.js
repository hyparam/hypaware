// @ts-check

import { commitKey, repoKey, str } from './keys.js'

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
 * @import { CursorState, GithubActor, GithubClient, GithubComment, GithubCommit, GithubCommitTask, GithubConfig, GithubIssue, GithubPull, GithubPullTask, GithubReview, GithubRepoWork, PluginLogger, RepoCursor } from './types.js'
 */

// @ref LLP 0361#budget [implements]: one fixed request allowance bounds the whole repository-capture tick
export const CAPTURE_REQUEST_LIMIT = 400

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
 * @param {number} [args.requestLimit] test seam; production uses CAPTURE_REQUEST_LIMIT
 * @returns {Promise<{ repos: number, events: number, requests: number, pending: boolean, errors: Array<{ repo: string, error: string }> }>}
 */
export async function captureRepos({ client, config, cursors, append, log, mode, only, observedRepos, requestLimit = CAPTURE_REQUEST_LIMIT }) {
  let repos = await resolveRepos(config, client, log, observedRepos)
  // A positional `hyp github backfill owner/repo` narrows this one invocation.
  // The round-robin continuation is a property of the WHOLE inventory, so a
  // narrowed run must not publish a `next_repo` drawn from its subset: doing so
  // rewinds the repositories that were genuinely next in line by a full
  // rotation (LLP 0361#budget - the continuation exists so one repository
  // cannot starve the rest).
  const narrowed = Boolean(only && only.length > 0)
  if (narrowed) {
    const onlySet = new Set(/** @type {string[]} */ (only).map((r) => r.toLowerCase()))
    repos = repos.filter((r) => onlySet.has(r))
  }

  let events = 0
  const budget = requestBudget(requestLimit)
  /** @type {Array<{ repo: string, error: string }>} */
  const errors = []
  let pending = false
  let visited = 0

  repos = rotateTo(repos, cursors.next_repo)

  for (let i = 0; i < repos.length; i++) {
    if (budget.remaining === 0) {
      pending = true
      break
    }
    const repo = repos[i]
    visited += 1
    let cursor = cursors.repos[repo] ?? (cursors.repos[repo] = {})
    if (mode === 'backfill' && cursor.work?.mode !== 'backfill') {
      cursor = {}
      cursors.repos[repo] = cursor
    }
    let repoEvents = 0
    try {
      const complete = await captureRepo({
        client,
        repo,
        cursor,
        requestedMode: mode,
        budget,
        append: async (rows) => {
          await append(rows)
          repoEvents += rows.length
        },
      })
      if (!complete) pending = true
    } catch (err) {
      // A failed repo leaves durable work behind, but a failure is NOT bounded
      // backlog: `pending` drives the source's cadence, and treating an error
      // as pending pins a daily source at the 15-minute backlog cadence for as
      // long as one repository keeps failing (a rename, an archive, a scope
      // the token lost). Failures retry on the ordinary cadence instead
      // (LLP 0360#cadence); the error itself is reported by `errors`.
      const message = errMessage(err)
      errors.push({ repo, error: message })
      log.error('github.repo_capture_failed', { repo, error: message })
    }
    events += repoEvents
    // Persist the advanced cursor onto the shared state after each repo.
    cursors.repos[repo] = cursor
    if (!narrowed) cursors.next_repo = repos[(i + 1) % repos.length]
  }

  if (visited < repos.length) pending = true
  if (budget.remaining === 0 && pending) {
    log.info('github.capture_budget_exhausted', {
      request_limit: budget.limit,
      requests: budget.used,
      pending_repos: repos.filter((repo) => cursors.repos[repo]?.work).length,
    })
  }
  return { repos: repos.length, events, requests: budget.used, pending, errors }
}

/**
 * Capture one repo through every pass, appending `github_events` rows. Returns
 * true when the repository has no continuation work left.
 *
 * @param {object} args
 * @param {GithubClient} args.client
 * @param {string} args.repo  canonical `owner/repo`
 * @param {RepoCursor} args.cursor
 * @param {'backfill' | 'poll'} args.requestedMode
 * @param {{ limit: number, remaining: number, used: number, take: () => boolean }} args.budget
 * @param {(rows: Record<string, unknown>[]) => Promise<void>} args.append
 * @returns {Promise<boolean>}
 */
async function captureRepo({ client, repo, cursor, requestedMode, budget, append }) {
  const [owner, name] = repo.split('/')
  const prNumbers = new Set(cursor.pull_numbers ?? [])

  if (!cursor.work) cursor.work = { mode: requestedMode, phase: 'issues' }
  const work = cursor.work

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
  }

  // @ref LLP 0361#page-work [implements]: each successful page advances durable work only after its rows land
  while (true) {
    if (work.phase === 'issues') {
      if (!budget.take()) return false
      const page = await client.listIssuesPage(owner, name, cursor.since?.issues, pageUrl(work.page))
      for (const issue of page.items) if (issue.pull_request) prNumbers.add(issue.number)
      await flush(page.items.filter((it) => !it.pull_request).map((it) => issueRow(repo, it)))
      cursor.pull_numbers = sortedNumbers(prNumbers)
      advanceSince(cursor, 'issues', page.items)
      work.page = page.next
      if (page.next === null) beginPulls(work, cursor)
      continue
    }

    if (work.phase === 'pulls') {
      const tasks = work.pull_tasks ?? (work.pull_tasks = [])
      if (tasks.length > 0) {
        if (!await drainPullTask({ client, owner, name, repo, tasks, budget, flush })) return false
        continue
      }
      if (work.page === null) {
        finishPulls(work, cursor)
        continue
      }
      if (!budget.take()) return false
      const requestedPage = pageUrl(work.page)
      const page = await client.listPullRequestsPage(owner, name, cursor.etag?.pulls, requestedPage)
      if (page.notModified) {
        work.page = null
        continue
      }
      const baseline = work.baseline_pulls
      const changed = work.mode === 'backfill' ? page.items : page.items.filter((pr) => pullChangedSince(pr, baseline, prNumbers))
      for (const pr of page.items) prNumbers.add(pr.number)
      await flush(changed.map((pr) => pullRow(repo, pr)))
      cursor.pull_numbers = sortedNumbers(prNumbers)
      work.pull_tasks = changed.map((pr) => ({ number: pr.number, created_at: pr.created_at, phase: 'files' }))
      work.pulls_high = newestPullTime(work.pulls_high, page.items)
      // Only the first page's ETag is a usable `If-None-Match` for the next
      // poll: the client sends the saved etag on page one only, so recording a
      // later page's etag here would guarantee a miss and silently retire the
      // 304 shortcut.
      if (page.etag && requestedPage === undefined) work.pulls_etag = page.etag
      const reachedHighWater = work.mode === 'poll' && baseline !== undefined && page.items.some((pr) => olderThan(pr, baseline))
      work.page = reachedHighWater ? null : page.next
      continue
    }

    if (work.phase === 'commits') {
      const tasks = work.commit_tasks ?? (work.commit_tasks = [])
      if (tasks.length > 0) {
        if (!budget.take()) return false
        const task = tasks[0]
        const page = await client.listCommitFilesPage(owner, name, task.sha, pageUrl(task.page))
        const commit = commitFromTask(task)
        await flush(page.items.map((path) => commitFileRow(repo, commit, path)))
        task.page = page.next
        if (page.next === null) tasks.shift()
        continue
      }
      if (work.page === null) {
        work.phase = 'comments'
        delete work.page
        continue
      }
      if (!budget.take()) return false
      const page = await client.listCommitsPage(owner, name, cursor.since?.commits, pageUrl(work.page))
      await flush(page.items.map((c) => commitRow(repo, c, null)))
      advanceCommitSince(cursor, page.items)
      work.commit_tasks = page.items.map((c) => ({ sha: c.sha, created_at: commitDate(c) ?? undefined }))
      work.page = page.next
      continue
    }

    if (!budget.take()) return false
    const page = await client.listIssueCommentsPage(owner, name, cursor.since?.comments, pageUrl(work.page))
    await flush(page.items.map((c) => commentRow(repo, c, prNumbers)).filter((r) => r !== null))
    advanceSince(cursor, 'comments', page.items)
    work.page = page.next
    if (page.next === null) {
      cursor.pull_numbers = sortedNumbers(prNumbers)
      delete cursor.work
      return true
    }
  }
}

/**
 * Drain one page of the current pull subresource.
 * @param {object} args
 * @param {GithubClient} args.client
 * @param {string} args.owner
 * @param {string} args.name
 * @param {string} args.repo
 * @param {GithubPullTask[]} args.tasks
 * @param {{ take: () => boolean }} args.budget
 * @param {(rows: Record<string, unknown>[]) => Promise<void>} args.flush
 */
async function drainPullTask({ client, owner, name, repo, tasks, budget, flush }) {
  if (!budget.take()) return false
  const task = tasks[0]
  const pr = /** @type {GithubPull} */ ({ number: task.number, created_at: task.created_at })
  if (task.phase === 'files') {
    const page = await client.listPullRequestFilesPage(owner, name, task.number, pageUrl(task.page))
    await flush(page.items.map((path) => prFileRow(repo, pr, path)))
    task.page = page.next
    if (page.next === null) {
      task.phase = 'reviews'
      delete task.page
    }
    return true
  }
  if (task.phase === 'reviews') {
    const page = await client.listPullRequestReviewsPage(owner, name, task.number, pageUrl(task.page))
    await flush(page.items.map((rv) => reviewRow(repo, pr, rv)))
    task.page = page.next
    if (page.next === null) {
      task.phase = 'commits'
      delete task.page
    }
    return true
  }
  const page = await client.listPullRequestCommitsPage(owner, name, task.number, pageUrl(task.page))
  await flush(page.items.map((c) => commitRow(repo, c, task.number)))
  task.page = page.next
  if (page.next === null) tasks.shift()
  return true
}

/** @param {GithubRepoWork} work @param {RepoCursor} cursor */
function beginPulls(work, cursor) {
  work.phase = 'pulls'
  delete work.page
  work.baseline_pulls = cursor.since?.pulls
  work.pulls_high = cursor.since?.pulls
  work.pull_tasks = []
}

/** @param {GithubRepoWork} work @param {RepoCursor} cursor */
function finishPulls(work, cursor) {
  if (work.pulls_high) setSince(cursor, 'pulls', work.pulls_high)
  if (work.pulls_etag) {
    if (!cursor.etag) cursor.etag = {}
    cursor.etag.pulls = work.pulls_etag
  }
  work.phase = 'commits'
  delete work.page
  delete work.baseline_pulls
  delete work.pulls_high
  delete work.pulls_etag
  delete work.pull_tasks
  work.commit_tasks = []
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

/** @param {GithubCommitTask} task @returns {GithubCommit} */
function commitFromTask(task) {
  return {
    sha: task.sha,
    commit: { author: task.created_at ? { date: task.created_at } : null },
  }
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
 * GitHub timestamps have second granularity. An unseen pull at exactly the
 * saved high-water is new work; a pull already in `seen` is not. Page traversal
 * still continues through the whole equal-time boundary and stops only after
 * reaching an older pull.
 *
 * @param {string | undefined} high
 * @param {Set<number>} seen
 * @returns {boolean}
 */
function pullChangedSince(pr, high, seen) {
  if (!high) return true
  const updated = updatedAt(pr)
  return updated == null || updated > high || (updated === high && !seen.has(pr.number))
}

/** @param {GithubPull} pr @param {string} high */
function olderThan(pr, high) {
  const updated = updatedAt(pr)
  return updated !== null && updated < high
}

/**
 * @param {string | undefined} high
 * @param {GithubPull[]} pulls
 * @returns {string | undefined}
 */
function newestPullTime(high, pulls) {
  let max = high
  for (const pr of pulls) {
    const value = updatedAt(pr)
    if (value && (!max || value > max)) max = value
  }
  return max
}

/**
 * @param {RepoCursor} cursor
 * @param {'issues' | 'comments'} key
 * @param {Array<GithubIssue | GithubComment>} rows
 */
function advanceSince(cursor, key, rows) {
  let max = cursor.since?.[key]
  for (const row of rows) {
    const value = row.updated_at ?? row.created_at
    if (value && (!max || value > max)) max = value
  }
  if (max) setSince(cursor, key, max)
}

/** @param {RepoCursor} cursor @param {GithubCommit[]} commits */
function advanceCommitSince(cursor, commits) {
  let max = cursor.since?.commits
  for (const commit of commits) {
    const value = commit.commit?.committer?.date ?? commit.commit?.author?.date
    if (value && (!max || value > max)) max = value
  }
  if (max) setSince(cursor, 'commits', max)
}

/** @param {RepoCursor} cursor @param {'issues' | 'pulls' | 'commits' | 'comments'} key @param {string} value */
function setSince(cursor, key, value) {
  if (!cursor.since) cursor.since = {}
  cursor.since[key] = value
}

/** @param {Set<number>} values */
function sortedNumbers(values) {
  return [...values].sort((a, b) => a - b)
}

/** @param {string[]} repos @param {string | undefined} nextRepo */
function rotateTo(repos, nextRepo) {
  if (!nextRepo) return repos
  const at = repos.indexOf(nextRepo)
  return at > 0 ? [...repos.slice(at), ...repos.slice(0, at)] : repos
}

/** @param {number} requested */
function requestBudget(requested) {
  const limit = Number.isSafeInteger(requested) && requested > 0 ? requested : CAPTURE_REQUEST_LIMIT
  const budget = {
    limit,
    remaining: limit,
    used: 0,
    take() {
      if (budget.remaining === 0) return false
      budget.remaining -= 1
      budget.used += 1
      return true
    },
  }
  return budget
}

/** @param {string | null | undefined} value */
function pageUrl(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** @param {GithubPull} pr @returns {string | null} */
function updatedAt(pr) {
  return typeof pr.updated_at === 'string' ? pr.updated_at : typeof pr.created_at === 'string' ? pr.created_at : null
}

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
}
