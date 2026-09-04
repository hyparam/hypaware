// @ts-check

import { execFile } from 'node:child_process'
import path from 'node:path'

/**
 * Thin GitHub REST client. Three things it guarantees, all from the credential
 * posture (LLP 0360 / LLP 0028):
 *
 *   1. The token comes from the configured env var, or from the local `gh`
 *      credential store when that env var is absent. It is never logged.
 *   2. Error paths never copy the response **body** (which can echo a token or
 *      sensitive content) into the thrown error or logs - only status + the
 *      query-less path.
 *   3. Polling is **cheap**: time-windowed endpoints carry `since`, listing
 *      endpoints carry `If-None-Match`, and every call returns one normalized
 *      page so capture owns the durable work cursor (LLP 0361).
 *
 * `fetchImpl` is injectable so tests drive the client without a network.
 *
 * @import { GithubActor, GithubClient, GithubCommit, GithubComment, GithubIssue, GithubPage, GithubPull, GithubReview, HypError, PluginLogger } from './types.js'
 */

const API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const PER_PAGE = 100
/** The explicit all-visible inventory is normalized into small strings. */
const MAX_PAGES = 50
/** GitHub embeds at most this many entries in a single commit's `files`. */
const COMMIT_FILES_CAP = 300

/**
 * @param {object} opts
 * @param {string} opts.tokenEnv  the env-var NAME the token is read from
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {PluginLogger} opts.log
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.baseUrl]
 * @param {() => Promise<string>} [opts.ghToken] test seam for `gh auth token`
 * @param {(file: string, args: string[], options: Record<string, unknown>, callback: (err: NodeJS.ErrnoException | null, stdout: string) => void) => void} [opts.execFileImpl]
 * @returns {GithubClient}
 */
export function createGithubClient({ tokenEnv, env, log, fetchImpl, baseUrl = API_BASE, ghToken, execFileImpl }) {
  const doFetch = fetchImpl ?? fetch
  /** @type {Promise<string> | null} */
  let resolvedToken = null

  async function token() {
    const fromEnv = env[tokenEnv]?.trim()
    if (fromEnv) return fromEnv
    if (!resolvedToken) {
      const resolveGhToken = ghToken ?? (() => tokenFromGh(env, execFileImpl))
      // Cache the resolved token, never the failure. `gh auth token` fails for
      // ordinary transient reasons (gh not yet on PATH under launchd, a
      // credential store still locked after login), and a retained rejected
      // promise poisons the client for the life of the daemon: every repo of
      // every later tick still spends a budget unit before the cached rejection
      // throws, and reports one error apiece. Dropping it retries on the next
      // call, which is the ordinary cadence (LLP 0360#cadence).
      resolvedToken = resolveGhToken().then((value) => {
        const clean = value.trim()
        if (!clean) throw authUnavailable()
        log.info('github.auth_resolved', { source: 'gh_cli' })
        return clean
      }).catch((err) => {
        resolvedToken = null
        throw err
      })
    }
    return resolvedToken
  }

  /**
   * One request. Resolves the token without logging it and never reads the
   * response body on a non-OK status.
   *
   * @param {string} pathAndQuery  e.g. `/repos/o/r/commits?since=...`
   * @param {{ etag?: string }} [opts]
   * @returns {Promise<{ notModified: true } | { notModified: false, data: unknown, next: string | null, etag: string | null }>}
   */
  async function request(pathAndQuery, opts = {}) {
    // Pin the origin before the credential exists. A refused continuation must
    // not materialize the token at all, which for an install with no token env
    // var means not spawning `gh auth token` (a subprocess with a 10s timeout)
    // on behalf of a URL we are about to throw away.
    const url = resolveUrl(baseUrl, pathAndQuery)
    const authToken = await token()
    /** @type {Record<string, string>} */
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': '@hypaware/github',
    }
    headers.Authorization = `Bearer ${authToken}`
    if (opts.etag) headers['If-None-Match'] = opts.etag

    const res = await doFetch(url, { headers })

    if (res.status === 304) return { notModified: true }
    if (!res.ok) {
      // No body, no token, no query string - just status + the path.
      const safePath = pathOf(url)
      const err = /** @type {HypError} */ (new Error(`GitHub API ${res.status} for GET ${safePath}`))
      err.hypErrorKind = 'github_api_error'
      err.status = res.status
      throw err
    }

    const etag = res.headers.get('etag')
    // Pin the continuation where it is produced, not only where it is spent.
    // The caller persists `next` into `github-cursors.json`, so a URL refused
    // only at fetch time is a refusal written into durable state: the phase
    // that already appended this page then restarts from its last PUBLISHED
    // watermark on every later tick, discarding the staged one, and re-appends
    // the same rows, because `github_events` dedupes within one batch and not
    // across ticks.
    const link = parseNextLink(res.headers.get('link'))
    const next = link === null ? null : resolveUrl(baseUrl, link)
    const data = await res.json()
    return { notModified: false, data, next, etag }
  }

  /**
   * Fetch and normalize one list page. Complete REST objects, including content
   * bodies, become unreachable before the next request.
   *
   * @template T
   * @param {string} url
   * @param {(row: Record<string, unknown>) => T | null} project
   * @param {string} [etag]
   * @returns {Promise<GithubPage<T>>}
   */
  async function listingPage(url, project, etag) {
    const result = await request(url, { etag })
    if (result.notModified) return { items: [], next: null, notModified: true }
    /** @type {T[]} */
    const items = []
    if (Array.isArray(result.data)) {
      for (const raw of /** @type {Record<string, unknown>[]} */ (result.data)) {
        const item = project(raw)
        if (item !== null) items.push(item)
      }
    }
    return { items, next: result.next, etag: result.etag }
  }

  return {
    async listViewerRepos() {
      const affiliations = encodeURIComponent('owner,collaborator,organization_member')
      /** @type {string[]} */
      const repos = []
      let url = `/user/repos?affiliation=${affiliations}&visibility=all&sort=full_name&per_page=${PER_PAGE}`
      for (let page = 0; page < MAX_PAGES && url; page++) {
        const result = await listingPage(url, fullName)
        repos.push(...result.items)
        url = result.next ?? ''
        if (page === MAX_PAGES - 1 && url) {
          log.warn('github.listing_truncated', { label: 'user/repos', max_pages: MAX_PAGES, per_page: PER_PAGE })
        }
      }
      return repos
    },

    async listIssuesPage(owner, repo, since, page) {
      const q = sinceQuery(since)
      const url = page ?? `/repos/${enc(owner)}/${enc(repo)}/issues?state=all&per_page=${PER_PAGE}${q}`
      return listingPage(url, issueOf)
    },

    async listPullRequestsPage(owner, repo, etag, page) {
      const url = page ?? `/repos/${enc(owner)}/${enc(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}`
      return listingPage(url, pullOf, page ? undefined : etag)
    },

    async listPullRequestFilesPage(owner, repo, number, page) {
      const url = page ?? `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/files?per_page=${PER_PAGE}`
      return listingPage(url, filename)
    },

    async listPullRequestReviewsPage(owner, repo, number, page) {
      const url = page ?? `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/reviews?per_page=${PER_PAGE}`
      return listingPage(url, reviewOf)
    },

    async listPullRequestCommitsPage(owner, repo, number, page) {
      const url = page ?? `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/commits?per_page=${PER_PAGE}`
      return listingPage(url, commitOf)
    },

    async listCommitsPage(owner, repo, since, page) {
      const q = sinceQuery(since)
      const url = page ?? `/repos/${enc(owner)}/${enc(repo)}/commits?per_page=${PER_PAGE}${q}`
      return listingPage(url, commitOf)
    },

    // Changed files come from the single-commit resource, which is not a
    // listing: it embeds at most `COMMIT_FILES_CAP` entries, sends no Link
    // header, and ignores `per_page`. So `next` is always null and a commit
    // touching more files silently loses the remainder. Say so in the log
    // rather than reporting a short list as complete, matching the
    // `github.listing_truncated` signal the all-visible enumeration emits.
    async listCommitFilesPage(owner, repo, sha, page) {
      const result = await request(page ?? `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}`)
      if (result.notModified) return { items: [], next: null, notModified: true }
      const data = /** @type {Record<string, unknown>} */ (result.data)
      const files = Array.isArray(data.files) ? /** @type {Record<string, unknown>[]} */ (data.files) : []
      if (files.length >= COMMIT_FILES_CAP) {
        log.warn('github.listing_truncated', { label: 'commits/files', max_files: COMMIT_FILES_CAP })
      }
      const items = files.map(filename).filter((x) => x !== null)
      return { items, next: result.next, etag: result.etag }
    },

    async listIssueCommentsPage(owner, repo, since, page) {
      const q = sinceQuery(since)
      const url = page ?? `/repos/${enc(owner)}/${enc(repo)}/issues/comments?per_page=${PER_PAGE}${q}`
      return listingPage(url, commentOf)
    },
  }
}

/**
 * Resolve a token through the user's existing GitHub CLI credential store.
 * Neither stdout nor stderr is copied into an error because stdout is the
 * credential itself.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {(file: string, args: string[], options: Record<string, unknown>, callback: (err: NodeJS.ErrnoException | null, stdout: string) => void) => void} [execFileImpl]
 * @returns {Promise<string>}
 */
// @ref LLP 0360#authentication [implements]: reuse local gh credentials without persisting or logging them
function tokenFromGh(env, execFileImpl = /** @type {any} */ (execFile)) {
  return new Promise((resolve, reject) => {
    execFileImpl('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: {
        ...env,
        PATH: githubCliPath(env),
      },
    }, (err, stdout) => {
      if (err) return reject(authUnavailable())
      resolve(stdout)
    })
  })
}

/**
 * launchd commonly starts the daemon with only the system path, while a local
 * `gh` install may live under Homebrew, MacPorts, a user bin, or mise. Extend
 * only the child process lookup path and do not mutate the daemon environment.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function githubCliPath(env) {
  const userHome = env.HOME?.trim()
  const entries = [
    ...(env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    ...(userHome ? [path.join(userHome, '.local', 'bin'), path.join(userHome, '.local', 'share', 'mise', 'shims')] : []),
  ].filter(Boolean)
  return [...new Set(entries)].join(path.delimiter)
}

/**
 * Resolve one request URL against the configured API origin.
 *
 * A continuation URL is parsed out of a response `Link` header or read back as
 * a page cursor from `github-cursors.json`, and the request that follows
 * carries the bearer token. Neither source is trusted to choose the host, so
 * pin the origin to `baseUrl` and refuse the rest. Refusing beats dropping the
 * Authorization header: an origin nobody configured is not one to talk to at
 * all.
 *
 * The pin has to be applied to the **built** URL, not only to a continuation
 * that already parses as absolute. `@evil.test/repos/o/r/issues` is not an
 * absolute URL, so it joins onto the base, and the join reads back as
 * `https://api.github.com@evil.test/...`: everything before the `@` is
 * userinfo and the authority is `evil.test`. Pinning only the absolute case
 * would hand the token to exactly the origin this is here to refuse.
 *
 * @param {string} baseUrl
 * @param {string} pathAndQuery
 * @returns {string}
 */
function resolveUrl(baseUrl, pathAndQuery) {
  const base = new URL(baseUrl)
  const url = URL.parse(pathAndQuery) ?? URL.parse(`${baseUrl}${pathAndQuery}`)
  // A matching `origin` is not on its own a matching authority. `blob:` and
  // the other wrapper schemes report the origin of the URL they wrap, so
  // `blob:https://api.github.com/x` passes an origin-only check while
  // addressing something else entirely, and userinfo survives into `href`.
  // Pin the scheme and refuse credentials too: what was checked has to be the
  // whole of what gets fetched.
  const ok = url && url.origin === base.origin && url.protocol === base.protocol && !url.username && !url.password
  if (!ok) throw foreignOrigin(url)
  // The parsed href, not the input.
  return url.href
}

/** @param {URL | null} url @returns {HypError} */
function foreignOrigin(url) {
  // Origin only. The path and query of an untrusted URL stay out of the error,
  // for the same reason a failed response body does. An opaque or unparseable
  // authority reports as `null`, which is what `URL.origin` already calls it.
  const err = /** @type {HypError} */ (new Error(`GitHub continuation URL refused: it does not address the configured API base (origin ${url?.origin ?? 'null'})`))
  err.hypErrorKind = 'github_foreign_origin'
  return err
}

/** @returns {HypError} */
function authUnavailable() {
  const err = /** @type {HypError} */ (new Error('GitHub authentication unavailable: set the configured token env var or run `gh auth login`'))
  err.hypErrorKind = 'github_auth_unavailable'
  return err
}

/**
 * @param {string | undefined} since
 * @returns {string}
 */
function sinceQuery(since) {
  return since ? `&since=${encodeURIComponent(since)}` : ''
}

/** @param {Record<string, unknown>} row @returns {GithubIssue | null} */
function issueOf(row) {
  const number = positiveInt(row.number)
  if (number === null) return null
  const state = text(row.state)
  const createdAt = text(row.created_at)
  const updatedAt = text(row.updated_at)
  return {
    number,
    ...(state ? { state } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(row.pull_request != null ? { pull_request: true } : {}),
    user: actorOf(row.user),
  }
}

/** @param {Record<string, unknown>} row @returns {GithubPull | null} */
function pullOf(row) {
  const number = positiveInt(row.number)
  if (number === null) return null
  const state = text(row.state)
  const createdAt = text(row.created_at)
  const updatedAt = text(row.updated_at)
  return {
    number,
    ...(state ? { state } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    merged_at: text(row.merged_at),
    draft: row.draft === true,
    user: actorOf(row.user),
  }
}

/** @param {Record<string, unknown>} row @returns {GithubReview | null} */
function reviewOf(row) {
  const id = positiveInt(row.id)
  if (id === null) return null
  const state = text(row.state)
  const submittedAt = text(row.submitted_at)
  return {
    id,
    ...(state ? { state } : {}),
    ...(submittedAt ? { submitted_at: submittedAt } : {}),
    user: actorOf(row.user),
  }
}

/** @param {Record<string, unknown>} row @returns {GithubCommit | null} */
function commitOf(row) {
  const sha = text(row.sha)
  if (!sha) return null
  const detail = row.commit && typeof row.commit === 'object' ? /** @type {Record<string, unknown>} */ (row.commit) : null
  const author = detail?.author && typeof detail.author === 'object' ? /** @type {Record<string, unknown>} */ (detail.author) : null
  const committer = detail?.committer && typeof detail.committer === 'object' ? /** @type {Record<string, unknown>} */ (detail.committer) : null
  return {
    sha,
    author: actorOf(row.author),
    commit: {
      author: author ? { date: text(author.date) ?? undefined } : null,
      committer: committer ? { date: text(committer.date) ?? undefined } : null,
    },
  }
}

/** @param {Record<string, unknown>} row @returns {GithubComment | null} */
function commentOf(row) {
  const id = positiveInt(row.id)
  if (id === null) return null
  const createdAt = text(row.created_at)
  const updatedAt = text(row.updated_at)
  const issueUrl = text(row.issue_url)
  return {
    id,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(issueUrl ? { issue_url: issueUrl } : {}),
    user: actorOf(row.user),
  }
}

/** @param {Record<string, unknown>} row @returns {string | null} */
function filename(row) {
  return text(row.filename)
}

/** @param {Record<string, unknown>} row @returns {string | null} */
function fullName(row) {
  return text(row.full_name)
}

/** @param {unknown} value @returns {GithubActor | null} */
function actorOf(value) {
  if (!value || typeof value !== 'object') return null
  const row = /** @type {Record<string, unknown>} */ (value)
  const login = text(row.login)
  if (!login) return null
  const type = text(row.type)
  return { login, ...(type ? { type } : {}) }
}

/** @param {unknown} value @returns {string | null} */
function text(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/** @param {unknown} value @returns {number | null} */
function positiveInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Parse the `rel="next"` URL from a GitHub `Link` header.
 *
 * @param {string | null} link
 * @returns {string | null}
 */
function parseNextLink(link) {
  if (!link) return null
  // Match over the whole header. Splitting on "," first assumed no URL in it
  // contains one, which the all-visible enumeration's
  // `affiliation=owner,collaborator,organization_member` does: it holds only
  // while GitHub echoes that query percent-encoded, and a decoded echo would
  // make `next` null and truncate the enumeration at page one, silently. The
  // angle brackets already delimit the URL, so no split is needed.
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(link)
  return m ? m[1] : null
}

/**
 * The path (no query string) of a URL, for safe error messages.
 *
 * @param {string} url
 * @returns {string}
 */
function pathOf(url) {
  try {
    return new URL(url).pathname
  } catch {
    return url.split('?')[0]
  }
}

/** @param {string} segment @returns {string} */
function enc(segment) {
  return encodeURIComponent(segment)
}
