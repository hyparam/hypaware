// @ts-check

import {
  actorKey,
  commitKey,
  fileKey,
  issueKey,
  pullRequestKey,
  repoKey,
  reviewKey,
  str,
} from './keys.js'
import { DATASET_NAME } from './dataset.js'

/**
 * @import { ContractRule, GraphContract, GraphKit } from './types.js'
 */

/** This plugin's name, stamped on the contract for provenance/dedup. */
export const PLUGIN_NAME = '@hypaware/github'
/** The dataset the contract reads (this plugin's own skeleton). */
export const SOURCE_DATASET = DATASET_NAME
/** Projector id stamped into every row's provenance. */
export const PROJECTOR = 'github.t0'
/**
 * Projector version, stamped into provenance to mark which projector
 * generation minted a row. NOT a re-projection trigger - ids are
 * content-addressed (LLP 0023 §inline-provenance).
 */
export const PROJECTOR_VERSION = 1

/**
 * Build the `github_events → graph` T0 contract: a hand-authored list of
 * read-only `SELECT` + `toRow` rules realizing the LLP 0032 taxonomy. Rows are
 * built with the graph plugin's `kit`, so the id recipe and provenance columns
 * stay owned by the graph plugin - this plugin owns only the SQL + `toRow`
 * semantics and the natural-key normalization ({@link file:./keys.js}).
 *
 * Four node types (`Repo`, `Actor`, `Commit`, `File`) use **bridge-ready** keys
 * so a node minted by another domain converges automatically (LLP 0032);
 * `Issue`, `PullRequest`, `Review` are GitHub-internal.
 *
 * @ref LLP 0360#graph-contract [implements]: node/edge taxonomy plus bridge-ready natural keys
 * @ref LLP 0023#contract-contribution [constrained-by]: central id and provenance kit; this plugin owns only its rules
 *
 * @param {GraphKit} kit
 * @returns {GraphContract}
 */
export function createGithubGraphContract(kit) {
  const { buildNode, buildEdge } = kit.makeRowBuilders({
    sourceDataset: SOURCE_DATASET,
    projector: PROJECTOR,
    projectorVersion: PROJECTOR_VERSION,
  })

  /** @type {ContractRule[]} */
  const rules = [
    // ---------------------------------------------------------------- nodes

    // Repo per repo column - every event row mentions its repo. ★ bridge-ready.
    {
      kind: 'node',
      type: 'Repo',
      sql: `SELECT repo, created_at FROM ${SOURCE_DATASET}`,
      toRow(r) {
        const key = repoKey(r.repo)
        if (!key) return null
        return buildNode({ type: 'Repo', key, label: key, firstSeen: r.created_at, sourceKeys: { repo: key } })
      },
    },

    // Actor per login, from any row carrying an actor. ★ bridge-ready.
    // Identity-merge across domains (github login vs session user_id) is T1/T2,
    // not here (LLP 0032 §actor-identity-is-enrichment-not-t0).
    {
      kind: 'node',
      type: 'Actor',
      sql: `SELECT actor_login, actor_type, created_at FROM ${SOURCE_DATASET} WHERE actor_login IS NOT NULL`,
      toRow(r) {
        const key = actorKey(r.actor_login)
        if (!key) return null
        return buildNode({
          type: 'Actor',
          key,
          label: key,
          props: pruned({ actor_type: str(r.actor_type) }),
          firstSeen: r.created_at,
          sourceKeys: { actor_login: key },
        })
      },
    },

    // Commit per sha. ★ bridge-ready - sha is globally unique, NOT repo-qualified.
    {
      kind: 'node',
      type: 'Commit',
      sql: `SELECT sha, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'commit'`,
      toRow(r) {
        const key = commitKey(r.sha)
        if (!key) return null
        return buildNode({ type: 'Commit', key, firstSeen: r.created_at, sourceKeys: { sha: key } })
      },
    },

    // File per owner/repo:relpath, from the file-grained rows. ★ bridge-ready.
    {
      kind: 'node',
      type: 'File',
      sql: `SELECT repo, path, created_at FROM ${SOURCE_DATASET} WHERE path IS NOT NULL`,
      toRow(r) {
        const key = fileKey(r.repo, r.path)
        if (!key) return null
        return buildNode({ type: 'File', key, label: basename(key), firstSeen: r.created_at, sourceKeys: { repo: repoKey(r.repo), path: str(r.path) } })
      },
    },

    // Issue per owner/repo#number. GitHub-internal.
    {
      kind: 'node',
      type: 'Issue',
      sql: `SELECT repo, number, state, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'issue'`,
      toRow(r) {
        const key = issueKey(r.repo, r.number)
        if (!key) return null
        return buildNode({ type: 'Issue', key, props: pruned({ state: str(r.state) }), firstSeen: r.created_at, sourceKeys: { repo: repoKey(r.repo), number: numOrNull(r.number) } })
      },
    },

    // PullRequest per owner/repo#number. GitHub-internal.
    {
      kind: 'node',
      type: 'PullRequest',
      sql: `SELECT repo, number, state, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'pull_request'`,
      toRow(r) {
        const key = pullRequestKey(r.repo, r.number)
        if (!key) return null
        return buildNode({ type: 'PullRequest', key, props: pruned({ state: str(r.state) }), firstSeen: r.created_at, sourceKeys: { repo: repoKey(r.repo), number: numOrNull(r.number) } })
      },
    },

    // Review per review/<review_id>. GitHub-internal.
    {
      kind: 'node',
      type: 'Review',
      sql: `SELECT review_id, review_state, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'review'`,
      toRow(r) {
        const key = reviewKey(r.review_id)
        if (!key) return null
        return buildNode({ type: 'Review', key, props: pruned({ state: str(r.review_state) }), firstSeen: r.created_at, sourceKeys: { review_id: numOrNull(r.review_id) } })
      },
    },

    // ---------------------------------------------------------------- edges

    // Repo membership.
    repoMembership('Issue', 'issue', issueKey),
    repoMembership('PullRequest', 'pull_request', pullRequestKey),
    {
      kind: 'edge',
      type: 'in',
      sql: `SELECT repo, sha, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'commit'`,
      toRow(r) {
        const repo = repoKey(r.repo)
        const sha = commitKey(r.sha)
        if (!repo || !sha) return null
        return buildEdge({ type: 'in', srcType: 'Commit', srcKey: sha, dstType: 'Repo', dstKey: repo, firstSeen: r.created_at, sourceKeys: { sha, repo } })
      },
    },
    {
      kind: 'edge',
      type: 'in',
      sql: `SELECT repo, path, created_at FROM ${SOURCE_DATASET} WHERE path IS NOT NULL`,
      toRow(r) {
        const repo = repoKey(r.repo)
        const file = fileKey(r.repo, r.path)
        if (!repo || !file) return null
        return buildEdge({ type: 'in', srcType: 'File', srcKey: file, dstType: 'Repo', dstKey: repo, firstSeen: r.created_at, sourceKeys: { repo, path: str(r.path) } })
      },
    },

    // Authorship / activity.
    actorTo('opened', 'Issue', 'issue', issueKey),
    actorTo('opened', 'PullRequest', 'pull_request', pullRequestKey),
    {
      kind: 'edge',
      type: 'authored',
      sql: `SELECT actor_login, sha, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'commit' AND actor_login IS NOT NULL`,
      toRow(r) {
        const actor = actorKey(r.actor_login)
        const sha = commitKey(r.sha)
        if (!actor || !sha) return null
        return buildEdge({ type: 'authored', srcType: 'Actor', srcKey: actor, dstType: 'Commit', dstKey: sha, firstSeen: r.created_at, sourceKeys: { actor_login: actor, sha } })
      },
    },
    actorTo('commented', 'Issue', 'issue_comment', issueKey),
    actorTo('commented', 'PullRequest', 'pull_request_comment', pullRequestKey),

    // Review.
    {
      kind: 'edge',
      type: 'submitted',
      sql: `SELECT actor_login, review_id, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'review' AND actor_login IS NOT NULL`,
      toRow(r) {
        const actor = actorKey(r.actor_login)
        const review = reviewKey(r.review_id)
        if (!actor || !review) return null
        return buildEdge({ type: 'submitted', srcType: 'Actor', srcKey: actor, dstType: 'Review', dstKey: review, firstSeen: r.created_at, sourceKeys: { actor_login: actor, review_id: numOrNull(r.review_id) } })
      },
    },
    {
      kind: 'edge',
      type: 'on',
      sql: `SELECT repo, review_id, pr_number, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'review' AND pr_number IS NOT NULL`,
      toRow(r) {
        const review = reviewKey(r.review_id)
        const pr = pullRequestKey(r.repo, r.pr_number)
        if (!review || !pr) return null
        return buildEdge({ type: 'on', srcType: 'Review', srcKey: review, dstType: 'PullRequest', dstKey: pr, firstSeen: r.created_at, sourceKeys: { review_id: numOrNull(r.review_id), pr_number: numOrNull(r.pr_number) } })
      },
    },

    // Code.
    {
      kind: 'edge',
      type: 'touched',
      sql: `SELECT sha, repo, path, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'commit_file'`,
      toRow(r) {
        const sha = commitKey(r.sha)
        const file = fileKey(r.repo, r.path)
        if (!sha || !file) return null
        return buildEdge({ type: 'touched', srcType: 'Commit', srcKey: sha, dstType: 'File', dstKey: file, firstSeen: r.created_at, sourceKeys: { sha, repo: repoKey(r.repo), path: str(r.path) } })
      },
    },
    {
      kind: 'edge',
      type: 'touched',
      sql: `SELECT repo, number, path, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'pull_request_file'`,
      toRow(r) {
        const pr = pullRequestKey(r.repo, r.number)
        const file = fileKey(r.repo, r.path)
        if (!pr || !file) return null
        return buildEdge({ type: 'touched', srcType: 'PullRequest', srcKey: pr, dstType: 'File', dstKey: file, firstSeen: r.created_at, sourceKeys: { repo: repoKey(r.repo), number: numOrNull(r.number), path: str(r.path) } })
      },
    },

    // Linkage: a PR references the commits captured under it.
    {
      kind: 'edge',
      type: 'references',
      sql: `SELECT repo, sha, pr_number, created_at FROM ${SOURCE_DATASET} WHERE event_type = 'commit' AND pr_number IS NOT NULL`,
      toRow(r) {
        const pr = pullRequestKey(r.repo, r.pr_number)
        const sha = commitKey(r.sha)
        if (!pr || !sha) return null
        return buildEdge({ type: 'references', srcType: 'PullRequest', srcKey: pr, dstType: 'Commit', dstKey: sha, firstSeen: r.created_at, sourceKeys: { pr_number: numOrNull(r.pr_number), sha } })
      },
    },
  ]

  return {
    name: 'github-t0',
    plugin: PLUGIN_NAME,
    sourceDataset: SOURCE_DATASET,
    projector: PROJECTOR,
    projectorVersion: PROJECTOR_VERSION,
    rules,
  }

  /**
   * `<Subject> -in-> Repo` for an event-discriminated subject keyed on number.
   *
   * @param {string} subjectType
   * @param {string} eventType
   * @param {(repo: unknown, number: unknown) => string | null} subjectKey
   * @returns {ContractRule}
   */
  function repoMembership(subjectType, eventType, subjectKey) {
    return {
      kind: 'edge',
      type: 'in',
      sql: `SELECT repo, number, created_at FROM ${SOURCE_DATASET} WHERE event_type = '${eventType}'`,
      toRow(r) {
        const repo = repoKey(r.repo)
        const subject = subjectKey(r.repo, r.number)
        if (!repo || !subject) return null
        return buildEdge({ type: 'in', srcType: subjectType, srcKey: subject, dstType: 'Repo', dstKey: repo, firstSeen: r.created_at, sourceKeys: { repo, number: numOrNull(r.number) } })
      },
    }
  }

  /**
   * `Actor -<rel>-> <Subject>` for an event-discriminated subject keyed on number.
   *
   * @param {string} rel
   * @param {string} subjectType
   * @param {string} eventType
   * @param {(repo: unknown, number: unknown) => string | null} subjectKey
   * @returns {ContractRule}
   */
  function actorTo(rel, subjectType, eventType, subjectKey) {
    return {
      kind: 'edge',
      type: rel,
      sql: `SELECT repo, number, actor_login, created_at FROM ${SOURCE_DATASET} WHERE event_type = '${eventType}' AND actor_login IS NOT NULL`,
      toRow(r) {
        const actor = actorKey(r.actor_login)
        const subject = subjectKey(r.repo, r.number)
        if (!actor || !subject) return null
        return buildEdge({ type: rel, srcType: 'Actor', srcKey: actor, dstType: subjectType, dstKey: subject, firstSeen: r.created_at, sourceKeys: { actor_login: actor, repo: repoKey(r.repo), number: numOrNull(r.number) } })
      },
    }
  }
}

/**
 * Basename of a `File` natural key (`owner/repo:relpath`) - the label only.
 *
 * @param {string} key
 * @returns {string}
 */
function basename(key) {
  const colon = key.indexOf(':')
  const relpath = colon >= 0 ? key.slice(colon + 1) : key
  const slash = relpath.lastIndexOf('/')
  return slash >= 0 ? relpath.slice(slash + 1) : relpath
}

/**
 * Coerce a GitHub number to a JS number for `source_keys` provenance, or null.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function numOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value)
  return null
}

/**
 * Drop null/undefined entries so identical inputs build identical props
 * (keys sorted for stable JSON), matching the ai-gateway contract.
 *
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
function pruned(obj) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] != null) out[key] = obj[key]
  }
  return out
}
