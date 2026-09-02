// @ts-check

/** @import { GithubClient } from '../../hypaware-core/plugins-workspace/github/src/types.js' */

/**
 * An in-memory GitHub client for tests, with no
 * network. `data.repos` is keyed by lowercased `owner/repo`. Cursors are accepted and ignored (cursor mechanics are the real
 * client's job; capture orchestration is what these tests exercise).
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
    async listIssuesPage(owner, repo) {
      calls.push(`listIssues:${owner}/${repo}`)
      return page(get(owner, repo).issues)
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
    async listCommitsPage(owner, repo) {
      calls.push(`listCommits:${owner}/${repo}`)
      return page(get(owner, repo).commits)
    },
    async listCommitFilesPage(owner, repo, sha) {
      calls.push(`listCommitFiles:${owner}/${repo}@${sha}`)
      return page(get(owner, repo).commitFiles?.[sha])
    },
    async listIssueCommentsPage(owner, repo) {
      calls.push(`listIssueComments:${owner}/${repo}`)
      return page(get(owner, repo).comments)
    },
  }
}

/** @template T @param {T[] | undefined} items */
function page(items) {
  return { items: items ?? [], next: null }
}

/** A logger that records nothing (tests assert on outputs, not logs). */
export const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
