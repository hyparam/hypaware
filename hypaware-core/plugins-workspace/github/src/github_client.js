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
 *      endpoints carry `If-None-Match` (a `304` costs no rate budget). All
 *      cursor mechanics live here; capture just passes the per-repo cursor and
 *      persists it afterward (LLP 0360 §cursoring).
 *
 * `fetchImpl` is injectable so tests drive the client without a network.
 *
 * @import { GithubClient, GithubCommit, GithubComment, GithubIssue, GithubPull, GithubReview, HypError, PluginLogger, RepoCursor } from './types.js'
 */

const API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const PER_PAGE = 100
/** Hard page cap per endpoint per run, so a runaway listing can't hang a tick. */
const MAX_PAGES = 50

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
      resolvedToken = resolveGhToken().then((value) => {
        const clean = value.trim()
        if (!clean) throw authUnavailable()
        log.info('github.auth_resolved', { source: 'gh_cli' })
        return clean
      })
    }
    return resolvedToken
  }

  /**
   * One request. Resolves the token without logging it and never reads the
   * response body on a non-OK status.
   *
   * @param {string} pathAndQuery  e.g. `/repos/o/r/commits?since=...`
   * @param {{ etagKey?: string, cursor?: RepoCursor }} [opts]
   * @returns {Promise<{ notModified: true } | { notModified: false, data: unknown, next: string | null, etag: string | null }>}
   */
  async function request(pathAndQuery, opts = {}) {
    const authToken = await token()
    /** @type {Record<string, string>} */
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': '@hypaware/github',
    }
    headers.Authorization = `Bearer ${authToken}`
    const priorEtag = opts.etagKey && opts.cursor?.etag ? opts.cursor.etag[opts.etagKey] : undefined
    if (priorEtag) headers['If-None-Match'] = priorEtag

    const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${baseUrl}${pathAndQuery}`
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
    if (opts.etagKey && opts.cursor && etag) {
      if (!opts.cursor.etag) opts.cursor.etag = {}
      opts.cursor.etag[opts.etagKey] = etag
    }
    const next = parseNextLink(res.headers.get('link'))
    const data = await res.json()
    return { notModified: false, data, next, etag }
  }

  /**
   * Fetch all pages of a listing. The first page is conditional (If-None-Match)
   * when an `etagKey` is given; a `304` there means "unchanged" → `[]`.
   *
   * @param {string} firstPathAndQuery
   * @param {{ etagKey?: string, cursor?: RepoCursor, label: string }} opts
   * @returns {Promise<any[]>}  raw JSON objects (untyped at the API boundary)
   */
  async function paginate(firstPathAndQuery, opts) {
    /** @type {any[]} */
    const out = []
    let url = firstPathAndQuery
    let first = true
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const result = await request(url, { etagKey: first ? opts.etagKey : undefined, cursor: opts.cursor })
      if (result.notModified) return []
      if (Array.isArray(result.data)) out.push(.../** @type {Record<string, unknown>[]} */ (result.data))
      url = result.next ?? ''
      first = false
      if (page === MAX_PAGES - 1 && url) {
        log.warn('github.listing_truncated', { label: opts.label, max_pages: MAX_PAGES, per_page: PER_PAGE })
      }
    }
    return out
  }

  return {
    async listViewerRepos() {
      const affiliations = encodeURIComponent('owner,collaborator,organization_member')
      const rows = await paginate(`/user/repos?affiliation=${affiliations}&visibility=all&sort=full_name&per_page=${PER_PAGE}`, { label: 'user/repos' })
      return fullNames(rows)
    },

    async listIssues(owner, repo, cursor) {
      const q = sinceQuery(cursor.since?.issues)
      const rows = await paginate(`/repos/${enc(owner)}/${enc(repo)}/issues?state=all&per_page=${PER_PAGE}${q}`, { label: `${owner}/${repo}/issues`, cursor })
      advanceSince(cursor, 'issues', rows)
      return /** @type {GithubIssue[]} */ (rows)
    },

    async listPullRequests(owner, repo, cursor) {
      const rows = await paginate(`/repos/${enc(owner)}/${enc(repo)}/pulls?state=all&per_page=${PER_PAGE}`, { label: `${owner}/${repo}/pulls`, etagKey: 'pulls', cursor })
      return /** @type {GithubPull[]} */ (rows)
    },

    async listPullRequestFiles(owner, repo, number) {
      const rows = await paginate(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/files?per_page=${PER_PAGE}`, { label: `${owner}/${repo}/pulls/${number}/files` })
      return filenames(rows)
    },

    async listPullRequestReviews(owner, repo, number) {
      const rows = await paginate(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/reviews?per_page=${PER_PAGE}`, { label: `${owner}/${repo}/pulls/${number}/reviews` })
      return /** @type {GithubReview[]} */ (rows)
    },

    async listPullRequestCommits(owner, repo, number) {
      const rows = await paginate(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/commits?per_page=${PER_PAGE}`, { label: `${owner}/${repo}/pulls/${number}/commits` })
      return /** @type {GithubCommit[]} */ (rows)
    },

    async listCommits(owner, repo, cursor) {
      const q = sinceQuery(cursor.since?.commits)
      const rows = await paginate(`/repos/${enc(owner)}/${enc(repo)}/commits?per_page=${PER_PAGE}${q}`, { label: `${owner}/${repo}/commits`, cursor })
      advanceSinceCommit(cursor, rows)
      return /** @type {GithubCommit[]} */ (rows)
    },

    async listCommitFiles(owner, repo, sha) {
      const result = await request(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}`)
      if (result.notModified) return []
      const data = /** @type {Record<string, unknown>} */ (result.data)
      return filenames(Array.isArray(data.files) ? /** @type {Record<string, unknown>[]} */ (data.files) : [])
    },

    async listIssueComments(owner, repo, cursor) {
      const q = sinceQuery(cursor.since?.comments)
      const rows = await paginate(`/repos/${enc(owner)}/${enc(repo)}/issues/comments?per_page=${PER_PAGE}${q}`, { label: `${owner}/${repo}/issues/comments`, cursor })
      advanceSince(cursor, 'comments', rows)
      return /** @type {GithubComment[]} */ (rows)
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

/**
 * Advance a `since` high-water to the newest `updated_at`/`created_at` in the
 * fetched rows. Using `updated_at` means an edited item re-qualifies next poll.
 *
 * @param {RepoCursor} cursor
 * @param {'issues' | 'comments'} key
 * @param {Record<string, unknown>[]} rows
 */
function advanceSince(cursor, key, rows) {
  let max = cursor.since?.[key]
  for (const r of rows) {
    const t = typeof r.updated_at === 'string' ? r.updated_at : typeof r.created_at === 'string' ? r.created_at : null
    if (t && (!max || t > max)) max = t
  }
  if (max) {
    if (!cursor.since) cursor.since = {}
    cursor.since[key] = max
  }
}

/**
 * Advance the commit `since` to the newest committer date seen.
 *
 * @param {RepoCursor} cursor
 * @param {Record<string, unknown>[]} rows
 */
function advanceSinceCommit(cursor, rows) {
  let max = cursor.since?.commits
  for (const r of rows) {
    const commit = /** @type {Record<string, unknown> | undefined} */ (r.commit)
    const committer = commit && typeof commit.committer === 'object' ? /** @type {Record<string, unknown>} */ (commit.committer) : null
    const author = commit && typeof commit.author === 'object' ? /** @type {Record<string, unknown>} */ (commit.author) : null
    const t = (committer && typeof committer.date === 'string' ? committer.date : null) ?? (author && typeof author.date === 'string' ? author.date : null)
    if (t && (!max || t > max)) max = t
  }
  if (max) {
    if (!cursor.since) cursor.since = {}
    cursor.since.commits = max
  }
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {string[]}
 */
function filenames(rows) {
  /** @type {string[]} */
  const out = []
  for (const r of rows) {
    if (typeof r.filename === 'string') out.push(r.filename)
  }
  return out
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {string[]}
 */
function fullNames(rows) {
  /** @type {string[]} */
  const out = []
  for (const row of rows) {
    if (typeof row.full_name === 'string') out.push(row.full_name)
  }
  return out
}

/**
 * Parse the `rel="next"` URL from a GitHub `Link` header.
 *
 * @param {string | null} link
 * @returns {string | null}
 */
function parseNextLink(link) {
  if (!link) return null
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part)
    if (m) return m[1]
  }
  return null
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
