// @ts-check

/** @import { GithubClient } from '../../hypaware-core/plugins-workspace/github/src/types.js' */

/**
 * An in-memory GitHub client for tests, with no
 * network. `data.repos` is keyed by lowercased `owner/repo`. Page cursors are
 * accepted and ignored (pagination mechanics are the real client's job;
 * capture orchestration is what these tests exercise).
 *
 * `since` is honored the way GitHub documents it for the issues family:
 * **inclusive** ("at or after"), so an item whose timestamp equals the
 * persisted watermark comes back on the next tick. That is the boundary the
 * capture passes have to survive; a fake that filtered exclusively would hide
 * it. An item with no timestamp is always returned.
 *
 * The three `since`-windowed listings also come back **newest-first**, as the
 * real ones do (`/commits` is reverse-chronological, `/issues` and
 * `/issues/comments` default to `sort=created&direction=desc`). Order is not
 * cosmetic here: the boundary rows trail the new ones, so a fixture-order fake
 * hides a gate that forgets the boundary as soon as it sees something newer.
 * Items with no timestamp keep their fixture position, at the front.
 *
 * @param {{
 *   viewerRepos?: string[],
 *   repos?: Record<string, {
 *     issues?: any[], pulls?: any[], commits?: any[], comments?: any[],
 *     prFiles?: Record<number, string[]>, prReviews?: Record<number, any[]>,
 *     prCommits?: Record<number, any[]>, commitFiles?: Record<string, string[]>,
 *   }>,
 *   calls?: string[],
 * }} data
 * @returns {GithubClient}
 */
export function fakeClient(data) {
  const repos = data.repos ?? {}
  const calls = data.calls ?? (data.calls = [])
  /** @param {string} owner @param {string} repo */
  const get = (owner, repo) => repos[`${owner}/${repo}`.toLowerCase()] ?? {}

  return {
    async listViewerRepos() {
      calls.push('listViewerRepos')
      return data.viewerRepos ?? []
    },
    async listIssuesPage(owner, repo, since) {
      calls.push(`listIssues:${owner}/${repo}`)
      return page(atOrAfter(get(owner, repo).issues, since, itemTime))
    },
    async listPullRequestsPage(owner, repo) {
      calls.push(`listPullRequests:${owner}/${repo}`)
      return page(get(owner, repo).pulls)
    },
    async listPullRequestFilesPage(owner, repo, number) {
      calls.push(`listPullRequestFiles:${owner}/${repo}#${number}`)
      return page(get(owner, repo).prFiles?.[number])
    },
    async listPullRequestReviewsPage(owner, repo, number) {
      calls.push(`listPullRequestReviews:${owner}/${repo}#${number}`)
      return page(get(owner, repo).prReviews?.[number])
    },
    async listPullRequestCommitsPage(owner, repo, number) {
      calls.push(`listPullRequestCommits:${owner}/${repo}#${number}`)
      return page(get(owner, repo).prCommits?.[number])
    },
    async listCommitsPage(owner, repo, since) {
      calls.push(`listCommits:${owner}/${repo}`)
      return page(atOrAfter(get(owner, repo).commits, since, commitTime))
    },
    async listCommitFilesPage(owner, repo, sha) {
      calls.push(`listCommitFiles:${owner}/${repo}@${sha}`)
      return page(get(owner, repo).commitFiles?.[sha])
    },
    async listIssueCommentsPage(owner, repo, since) {
      calls.push(`listIssueComments:${owner}/${repo}`)
      return page(atOrAfter(get(owner, repo).comments, since, itemTime))
    },
  }
}

/** @template T @param {T[] | undefined} items */
function page(items) {
  return { items: items ?? [], next: null }
}

/**
 * @template T
 * @param {T[] | undefined} items
 * @param {string | undefined} since
 * @param {(item: any) => string | undefined} timeOf
 */
function atOrAfter(items, since, timeOf) {
  if (!items) return items
  const kept = since ? items.filter((item) => {
    const at = timeOf(item)
    return at === undefined || at >= since
  }) : [...items]
  return kept.sort((a, b) => (timeOf(b) ?? '').localeCompare(timeOf(a) ?? ''))
}

/** @param {any} item */
function itemTime(item) {
  return item?.updated_at ?? item?.created_at ?? undefined
}

/** @param {any} commit */
function commitTime(commit) {
  return commit?.commit?.committer?.date ?? commit?.commit?.author?.date ?? undefined
}

/** A logger that records nothing (tests assert on outputs, not logs). */
export const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
