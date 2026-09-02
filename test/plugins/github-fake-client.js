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
    async listIssues(owner, repo) {
      calls.push(`listIssues:${owner}/${repo}`)
      return get(owner, repo).issues ?? []
    },
    async listPullRequests(owner, repo) {
      calls.push(`listPullRequests:${owner}/${repo}`)
      return get(owner, repo).pulls ?? []
    },
    async listPullRequestFiles(owner, repo, number) {
      calls.push(`listPullRequestFiles:${owner}/${repo}#${number}`)
      return get(owner, repo).prFiles?.[number] ?? []
    },
    async listPullRequestReviews(owner, repo, number) {
      calls.push(`listPullRequestReviews:${owner}/${repo}#${number}`)
      return get(owner, repo).prReviews?.[number] ?? []
    },
    async listPullRequestCommits(owner, repo, number) {
      calls.push(`listPullRequestCommits:${owner}/${repo}#${number}`)
      return get(owner, repo).prCommits?.[number] ?? []
    },
    async listCommits(owner, repo) {
      calls.push(`listCommits:${owner}/${repo}`)
      return get(owner, repo).commits ?? []
    },
    async listCommitFiles(owner, repo, sha) {
      calls.push(`listCommitFiles:${owner}/${repo}@${sha}`)
      return get(owner, repo).commitFiles?.[sha] ?? []
    },
    async listIssueComments(owner, repo) {
      calls.push(`listIssueComments:${owner}/${repo}`)
      return get(owner, repo).comments ?? []
    },
  }
}

/** A logger that records nothing (tests assert on outputs, not logs). */
export const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
