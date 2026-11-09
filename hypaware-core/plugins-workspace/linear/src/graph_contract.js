// @ts-check

import { uuid } from './oauth.js'
import { DATASET_NAME, PLUGIN_NAME } from './dataset.js'

/** @import { GraphKit, GraphRule } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

/** @param {unknown} workspace @param {unknown} issue */
export function issueKey(workspace, issue) {
  return uuid(workspace) && uuid(issue) ? `linear:${workspace.toLowerCase()}:${issue.toLowerCase()}` : null
}

/** @param {unknown} value */
export function pullRequestFromUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(u.hostname) || u.username || u.password || u.port) return null
    const match = /^\/([a-z0-9_-]+)\/([a-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/i.exec(u.pathname)
    if (!match || !Number.isSafeInteger(Number(match[3]))) return null
    return { repo: `${match[1]}/${match[2]}`.toLowerCase(), number: Number(match[3]) }
  } catch { return null }
}

/** @param {unknown} repo @param {unknown} number */
function prKey(repo, number) {
  const parsed = pullRequestFromUrl(`https://github.com/${String(repo)}/pull/${String(number)}`)
  return parsed ? `${parsed.repo}#${parsed.number}` : null
}

/** @param {GraphKit} kit */
// @ref LLP 0592#graph [implements]: namespaced Issue identities converge through the existing GitHub PullRequest natural key
export function createLinearGraphContract(kit) {
  const builders = kit.makeRowBuilders({ sourceDataset: DATASET_NAME, projector: 'linear.t0', projectorVersion: 1 })
  const columns = ['workspace_id', 'issue_id', 'identifier', 'attachment_id', 'repo', 'pr_number', 'created_at']
  const sourceKeys = r => ({ workspace_id: r.workspace_id, issue_id: r.issue_id, ...(r.attachment_id ? { attachment_id: r.attachment_id } : {}) })
  /** @type {GraphRule[]} */
  const rules = [
    { kind: 'node', type: 'Issue', columns, toRow(r) {
      const key = issueKey(r.workspace_id, r.issue_id)
      return key ? builders.buildNode({ type: 'Issue', key, label: typeof r.identifier === 'string' ? r.identifier : null, firstSeen: r.created_at, sourceKeys: sourceKeys(r) }) : null
    } },
    { kind: 'node', type: 'PullRequest', columns, where: { eq: { event_type: 'pr_attachment' } }, toRow(r) {
      const key = prKey(r.repo, r.pr_number)
      return key && issueKey(r.workspace_id, r.issue_id) ? builders.buildNode({ type: 'PullRequest', key, firstSeen: r.created_at, sourceKeys: sourceKeys(r) }) : null
    } },
    { kind: 'edge', type: 'references', columns, where: { eq: { event_type: 'pr_attachment' } }, toRow(r) {
      const issue = issueKey(r.workspace_id, r.issue_id)
      const pr = prKey(r.repo, r.pr_number)
      return issue && pr ? builders.buildEdge({ type: 'references', srcType: 'Issue', srcKey: issue,
        dstType: 'PullRequest', dstKey: pr, firstSeen: r.created_at, sourceKeys: sourceKeys(r) }) : null
    } },
  ]
  return { name: 'linear-t0', plugin: PLUGIN_NAME, sourceDataset: DATASET_NAME, projector: 'linear.t0', projectorVersion: 1, rules }
}
