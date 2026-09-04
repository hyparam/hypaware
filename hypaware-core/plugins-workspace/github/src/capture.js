// @ts-check

import { MAX_BOUNDARY_IDS } from './cursors.js'
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
 * @returns {Promise<{ repos: number, visited: number, events: number, requests: number, pending: boolean, errors: Array<{ repo: string, error: string }> }>} `repos` is the inventory this tick selected (after
 *   `ignore[]` and any `only` narrowing); `visited` is how many of them the request
 *   budget let it reach. It is fewer only when the budget ran out before a repository
 *   the tick had not started: a budget spent inside the last one still reaches them
 *   all, so `pending` - not the gap between the two - is what reports bounded work
 *   remaining (LLP 0361#budget).
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
      // Carry the error kind, not only the message. This is where a refused
      // continuation lands (the tampered-sidecar vector), and the whole-tick
      // handler in `source.js` never sees it, so without this the kind is not
      // filterable exactly where it matters.
      const kind = /** @type {{ hypErrorKind?: string }} */ (err)?.hypErrorKind
      // A refused continuation is the one failure retrying cannot clear: the
      // URL the client refused IS the durable work, so keeping it replays the
      // same refusal every tick and the repository never captures again until
      // `github-cursors.json` is hand-edited. Dropping it restarts from the
      // last completed phase, which is what a lost work descriptor already
      // means here (LLP 0360#cursoring).
      const cleared = kind === 'github_foreign_origin' && cursor.work !== undefined
      if (cleared) delete cursor.work
      log.error('github.repo_capture_failed', {
        repo,
        error: message,
        ...(kind ? { error_kind: kind } : {}),
        ...(cleared ? { work_cleared: true } : {}),
      })
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
  return { repos: repos.length, visited, events, requests: budget.used, pending, errors }
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
  // `prNumbers` answers "is this number a PR?" for comment discrimination, so
  // the issues pass adds the PRs `/issues` returns. The tie guard asks "has the
  // pulls listing already captured it?", and answering that from `prNumbers`
  // drops a genuinely new pull tied at the high-water second the moment the
  // same tick's issues pass has sighted it. A sidecar predating the dedicated
  // set falls back to `pull_numbers` read here, before the issues pass mutates
  // it, which is the pre-fix answer rather than a re-capture of every tie.
  const capturedAtHigh = new Set(cursor.pulls_high_numbers ?? cursor.pull_numbers ?? [])

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
      const gate = openGate(work.issues_high, work.issues_high_ids, cursor.since?.issues, cursor.boundary?.issues)
      const page = await client.listIssuesPage(owner, name, cursor.since?.issues, pageUrl(work.page))
      for (const issue of page.items) if (issue.pull_request) prNumbers.add(issue.number)
      // A pull carried by the issues feed still raises the watermark, but it
      // emits no row here, so it takes no place in the boundary set.
      const fresh = page.items.filter((it) => gate.admit(itemTime(it), it.pull_request ? null : issueEventId(repo, it)))
      await flush(fresh.filter((it) => !it.pull_request).map((it) => issueRow(repo, it)))
      cursor.pull_numbers = sortedNumbers(prNumbers)
      work.issues_high = gate.high
      work.issues_high_ids = gate.ids
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
      const changed = work.mode === 'backfill' ? page.items : page.items.filter((pr) => pullChangedSince(pr, baseline, capturedAtHigh))
      for (const pr of page.items) {
        prNumbers.add(pr.number)
        // The guard's set has to grow across the phase's pages, not only across
        // ticks. `sort=updated&direction=desc` reshuffles under pagination, so a
        // pull this page just captured at the boundary second can be listed
        // again on a later page of the same traversal, and `flush` deduplicates
        // one batch, not a phase. Reading the number back off this page is what
        // "the pulls listing captured it" means.
        if (updatedAt(pr) === baseline) capturedAtHigh.add(pr.number)
      }
      await flush(changed.map((pr) => pullRow(repo, pr)))
      cursor.pull_numbers = sortedNumbers(prNumbers)
      work.pull_tasks = changed.map((pr) => ({ number: pr.number, created_at: pr.created_at, phase: 'files' }))
      advancePullsHigh(work, page.items)
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
        finishCommits(work, cursor)
        continue
      }
      if (!budget.take()) return false
      const gate = openGate(work.commits_high, work.commits_high_ids, cursor.since?.commits, cursor.boundary?.commits)
      const page = await client.listCommitsPage(owner, name, cursor.since?.commits, pageUrl(work.page))
      const fresh = page.items.filter((c) => gate.admit(commitTime(c), commitEventId(c, null)))
      await flush(fresh.map((c) => commitRow(repo, c, null)))
      work.commits_high = gate.high
      work.commits_high_ids = gate.ids
      // Only the appended commits queue their file sub-resource: re-queueing a
      // boundary commit re-appends its `commit_file` rows and re-spends a
      // request, every tick.
      work.commit_tasks = fresh.map((c) => ({ sha: c.sha, created_at: commitDate(c) ?? undefined }))
      work.page = page.next
      continue
    }

    if (!budget.take()) return false
    const gate = openGate(work.comments_high, work.comments_high_ids, cursor.since?.comments, cursor.boundary?.comments)
    const page = await client.listIssueCommentsPage(owner, name, cursor.since?.comments, pageUrl(work.page))
    const fresh = page.items.filter((c) => gate.admit(itemTime(c), commentEventId(c)))
    await flush(fresh.map((c) => commentRow(repo, c, prNumbers)).filter((r) => r !== null))
    work.comments_high = gate.high
    work.comments_high_ids = gate.ids
    work.page = page.next
    if (page.next === null) {
      cursor.pull_numbers = sortedNumbers(prNumbers)
      if (work.comments_high) {
        setSince(cursor, 'comments', work.comments_high)
        setBoundary(cursor, 'comments', work.comments_high_ids)
      }
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

/**
 * Publish the issues watermark and open the pulls phase.
 *
 * A phase stages its high-water on `work` and publishes to `cursor.since`
 * only here, at the phase boundary, once every page of the phase has appended.
 * Publishing per page would advance the durable watermark past pages 2..N that
 * have not been fetched yet, so any later loss of `work` (a sidecar rewritten
 * by a concurrent process, a downgrade whose `readWork` rejects an unknown
 * phase) skips that range permanently and silently. Staging trades that for a
 * re-fetch, which LLP 0360#cursoring chooses explicitly: "retries from the last
 * completed phase rather than skipping the missing range", and "rows appended
 * by an earlier attempt remain valid snapshots". The pulls phase always worked
 * this way (`pulls_high`); issues, commits, and comments now do too.
 *
 * @ref LLP 0360#cursoring [implements]: publish a phase's cursor only after its rows and sub-resources append
 *
 * @param {GithubRepoWork} work @param {RepoCursor} cursor
 */
function beginPulls(work, cursor) {
  if (work.issues_high) {
    setSince(cursor, 'issues', work.issues_high)
    setBoundary(cursor, 'issues', work.issues_high_ids)
  }
  delete work.issues_high
  delete work.issues_high_ids
  work.phase = 'pulls'
  delete work.page
  work.baseline_pulls = cursor.since?.pulls
  work.pulls_high = cursor.since?.pulls
  // Carried, not restarted: a phase that ends on a 304 observes no pulls and
  // must still republish what the previous one captured at that same second.
  work.pulls_high_numbers = cursor.pulls_high_numbers ?? []
  work.pull_tasks = []
}

/** @param {GithubRepoWork} work @param {RepoCursor} cursor */
function finishPulls(work, cursor) {
  if (work.pulls_high) {
    // Published with the watermark it describes; the two only mean anything together.
    setSince(cursor, 'pulls', work.pulls_high)
    // An empty staged set is not the claim "nothing was captured at that
    // second", it is the absence of evidence: a phase that ends on a 304 sees
    // no page at all, and a phase that does raise the watermark always observes
    // the pull that raised it. Publishing empty would retire an old sidecar's
    // `pull_numbers` fallback for good and re-capture every tie on the next
    // poll, so leave whatever answer the cursor already carries.
    if (work.pulls_high_numbers?.length) cursor.pulls_high_numbers = work.pulls_high_numbers
  }
  if (work.pulls_etag) {
    if (!cursor.etag) cursor.etag = {}
    cursor.etag.pulls = work.pulls_etag
  }
  work.phase = 'commits'
  delete work.page
  delete work.baseline_pulls
  delete work.pulls_high
  delete work.pulls_high_numbers
  delete work.pulls_etag
  delete work.pull_tasks
  work.commit_tasks = []
}

/**
 * Publish the commits watermark and open the comments phase. Reached only with
 * `commit_tasks` drained, so the commit-file sub-resources of every commit the
 * watermark covers have appended (LLP 0360#cursoring).
 *
 * @param {GithubRepoWork} work @param {RepoCursor} cursor
 */
function finishCommits(work, cursor) {
  if (work.commits_high) {
    setSince(cursor, 'commits', work.commits_high)
    setBoundary(cursor, 'commits', work.commits_high_ids)
  }
  delete work.commits_high
  delete work.commits_high_ids
  work.phase = 'comments'
  delete work.page
}

/* ---------------------------------------------------------------- row builders */

/**
 * @param {string} repo
 * @param {GithubIssue} it
 * @returns {Record<string, unknown>}
 */
function issueRow(repo, it) {
  return base('issue', issueEventId(repo, it), repo, {
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
  return base('commit', commitEventId(c, prNumber), repo, {
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
  return base(onPr ? 'pull_request_comment' : 'issue_comment', commentEventId(c), repo, {
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
 * saved high-water is new work; a pull the previous phase already captured at
 * that second is not. Page traversal still continues through the whole
 * equal-time boundary and stops only after reaching an older pull.
 *
 * @param {string | undefined} high
 * @param {Set<number>} capturedAtHigh  pulls already captured at exactly `high`
 * @returns {boolean}
 */
function pullChangedSince(pr, high, capturedAtHigh) {
  if (!high) return true
  const updated = updatedAt(pr)
  return updated == null || updated > high || (updated === high && !capturedAtHigh.has(pr.number))
}

/** @param {GithubPull} pr @param {string} high */
function olderThan(pr, high) {
  const updated = updatedAt(pr)
  return updated !== null && updated < high
}

/**
 * Advance the staged pull high-water over one page, and with it the numbers
 * observed at exactly that second. A page that raises the high water replaces
 * them; one that ties extends them. Only the boundary second is retained: it is
 * the only one the next poll's tie guard can ask about, so this stays bounded
 * by the pulls sharing one second rather than growing with repository history.
 *
 * @param {GithubRepoWork} work
 * @param {GithubPull[]} pulls
 */
// @ref LLP 0361#page-work [implements]: equal-timestamp unseen pulls are still captured, so the boundary second's numbers are what the next poll needs
function advancePullsHigh(work, pulls) {
  const high = newestPullTime(work.pulls_high, pulls)
  // A pulls phase resumed from a work descriptor written before this field
  // existed has no staged set, and the boundary pulls its earlier pages already
  // captured are unrecoverable. Extending nothing would publish the remaining
  // pages' numbers as if they were the whole answer, so the next poll would
  // re-capture the rest. Stay silent instead and let `finishPulls` keep the
  // cursor's `pull_numbers` fallback, until a page raises the high water and
  // opens a second this phase has observed whole.
  if (high === work.pulls_high && !work.pulls_high_numbers) return
  const numbers = new Set(high === work.pulls_high ? work.pulls_high_numbers ?? [] : [])
  for (const pr of pulls) if (updatedAt(pr) === high) numbers.add(pr.number)
  work.pulls_high = high
  work.pulls_high_numbers = sortedNumbers(numbers)
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

/** The field GitHub windows the issues-family `since` on.
 *
 * @param {GithubIssue | GithubComment} item @returns {string | undefined}
 */
function itemTime(item) {
  return item.updated_at ?? item.created_at
}

/** @param {GithubCommit} commit @returns {string | undefined} */
function commitTime(commit) {
  return commit.commit?.committer?.date ?? commit.commit?.author?.date
}

/** @param {string} repo @param {GithubIssue} it */
function issueEventId(repo, it) {
  return `issue:${repoKey(repo)}#${it.number}`
}

/** @param {GithubCommit} c @param {number | null} prNumber */
function commitEventId(c, prNumber) {
  return prNumber == null ? `commit:${commitKey(c.sha)}` : `commit:${commitKey(c.sha)}:pr${prNumber}`
}

/** @param {GithubComment} c */
function commentEventId(c) {
  return `comment:${c.id}`
}

/**
 * The high-water gate for one `since`-windowed pass (issues, commits,
 * comments): it raises the watermark and answers what has not been appended.
 *
 * GitHub's `since` is INCLUSIVE ("at or after") and the watermark is the
 * newest captured item's own second-granularity timestamp, so every tick
 * re-fetches whatever sits exactly on it. Pushing the watermark past that
 * second instead would lose an item stamped in the same second but published
 * after our request. The pulls pass already refuses that trade
 * (`pullChangedSince`); this is the same guard for the other three passes.
 * Carrying the ids ON the watermark costs one timestamp's worth of identity,
 * never a repository's history.
 *
 * Two sets, not one. `published`/`publishedIds` is the **floor**: the request
 * carries the published watermark for every page of the pass (`setSince` runs
 * at the phase boundary, not per page), so the floor's items come back on each
 * of those pages and must be refused throughout. `staged`/`stagedIds` is the
 * running maximum on `work`, which is what gets published next. Collapsing the
 * two loses the floor the moment anything newer arrives, and one new item is
 * routinely enough to reach the boundary rows behind it (`/commits` is
 * reverse-chronological, `/issues` defaults to `sort=created` descending).
 * The floor is a static set for the whole pass, so `admit` does not depend on
 * the order a listing arrives in, which is what makes it right even though
 * none of these endpoints orders on `updated_at`, the field the gate windows
 * on. Below the floor nothing is refused: an inclusive `since` cannot return
 * those. Keeping both means the gate resumes correctly from whichever of the
 * pair survived a partial tick (LLP 0360#cursoring).
 *
 * What the gate does drop: an item re-updated inside the same second it was
 * captured keeps its `updated_at`, so the floor refuses it by identity and the
 * newer snapshot never lands. That is the trade `pullChangedSince` already
 * makes; curing it needs a content fingerprint, not a bare event id.
 *
 * @ref LLP 0360#resource-bounds [constrained-by]: identity carried across ticks is one watermark second's worth, not a repository's history
 *
 * @param {string | undefined} staged
 * @param {string[] | undefined} stagedIds
 * @param {string | undefined} published
 * @param {string[] | undefined} publishedIds
 */
function openGate(staged, stagedIds, published, publishedIds) {
  let high = staged ?? published
  let ids = new Set(staged === undefined ? publishedIds : stagedIds)
  const floorIds = new Set(publishedIds)
  return {
    get high() {
      return high
    },
    get ids() {
      return ids.size > 0 ? [...ids].slice(0, MAX_BOUNDARY_IDS) : undefined
    },
    /**
     * A null `id` raises the watermark only: the caller emits no row for that
     * item, so it must not claim a place in the boundary set.
     *
     * @param {string | undefined} at
     * @param {string | null} id
     * @returns {boolean} whether the pass should append this item
     */
    admit(at, id) {
      if (at && (!high || at > high)) {
        high = at
        ids = new Set()
      }
      if (id === null) return true
      if (published !== undefined && at === published && floorIds.has(id)) return false
      if (!at || at !== high) return true
      if (ids.has(id)) return false
      ids.add(id)
      return true
    },
  }
}

/** @param {RepoCursor} cursor @param {'issues' | 'pulls' | 'commits' | 'comments'} key @param {string} value */
function setSince(cursor, key, value) {
  if (!cursor.since) cursor.since = {}
  cursor.since[key] = value
}

/**
 * Publish (or clear) the identities sitting exactly on a phase's watermark.
 * Bounded by `MAX_BOUNDARY_IDS` on the way out as well as on the way back in,
 * so the sidecar cannot grow without limit and a written set always survives
 * its own read.
 *
 * @param {RepoCursor} cursor
 * @param {'issues' | 'commits' | 'comments'} key
 * @param {string[] | undefined} ids
 */
function setBoundary(cursor, key, ids) {
  if (!ids || ids.length === 0) {
    if (cursor.boundary) delete cursor.boundary[key]
    return
  }
  if (!cursor.boundary) cursor.boundary = {}
  cursor.boundary[key] = ids
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
