// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { edgeId, makeRowBuilders, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import {
  createGithubGraphContract,
  PLUGIN_NAME,
  PROJECTOR,
  PROJECTOR_VERSION,
  SOURCE_DATASET,
} from '../../hypaware-core/plugins-workspace/github/src/graph_contract.js'

// Build the contract the way activate() does, from the graph plugin's real
// shared kit, so the rules' row identity + provenance are the true end-to-end
// ones (this doubles as a digest-stability cross-check alongside graph-ids.test.js).
const KIT = { nodeId, edgeId, makeRowBuilders }
const contract = createGithubGraphContract(KIT)

const TS = '2026-06-05T12:00:00.000Z'

/**
 * Find a rule by kind + type, optionally disambiguating the several same-typed
 * rules (`in`, `touched`, `commented`) by predicate or selected column.
 *
 * @param {'node' | 'edge'} kind
 * @param {string} type
 * @param {{ eventType?: string, column?: string }} [match]
 */
function rule(kind, type, match) {
  const found = contract.rules.find((r) =>
    r.kind === kind &&
    r.type === type &&
    (!match?.eventType || r.where?.eq?.event_type === match.eventType) &&
    (!match?.column || r.columns?.includes(match.column))
  )
  assert.ok(found, `${kind}/${type}${match ? ` (${JSON.stringify(match)})` : ''} exists`)
  return found
}

test('contract carries its source/projector metadata', () => {
  assert.equal(contract.name, 'github-t0')
  assert.equal(contract.plugin, PLUGIN_NAME)
  assert.equal(contract.plugin, '@hypaware/github')
  assert.equal(contract.sourceDataset, SOURCE_DATASET)
  assert.equal(contract.sourceDataset, 'github_events')
  assert.equal(contract.projector, PROJECTOR)
  assert.equal(contract.projector, 'github.t0')
  assert.equal(contract.projectorVersion, PROJECTOR_VERSION)
})

test('Repo node normalizes owner/repo and converges on the bridge key', () => {
  const row = rule('node', 'Repo').toRow({ repo: 'Octocat/Hello-World', created_at: TS })
  assert.ok(row)
  assert.equal(row.node_id, nodeId('Repo', 'octocat/hello-world'))
  assert.equal(row.natural_key, 'octocat/hello-world')
  assert.equal(row.label, 'octocat/hello-world')
  assert.equal(row.first_seen, TS)
  assert.equal(row.source_dataset, 'github_events')
  assert.equal(row.props, null)
  assert.equal(rule('node', 'Repo').toRow({ repo: 'no-slash', created_at: TS }), null)
})

test('Actor node lowercases login and keeps actor_type as a pruned prop', () => {
  const row = rule('node', 'Actor').toRow({ actor_login: 'Octocat', actor_type: 'User', created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, 'octocat')
  assert.deepEqual(row.props, { actor_type: 'User' })
  const bare = rule('node', 'Actor').toRow({ actor_login: 'octocat', actor_type: null, created_at: TS })
  assert.ok(bare)
  assert.equal(bare.props, null, 'null actor_type prunes to null props')
  assert.equal(rule('node', 'Actor').toRow({ actor_login: null, created_at: TS }), null)
})

test('Commit node keys on the full sha lowercased (no repo qualification)', () => {
  const row = rule('node', 'Commit').toRow({ sha: '6DCB09B5B57875F334F61AEBED695E2E4193DB5E', created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, '6dcb09b5b57875f334f61aebed695e2e4193db5e')
  assert.equal(row.label, null)
})

test('File node keys on owner/repo:relpath with a basename label', () => {
  const row = rule('node', 'File').toRow({ repo: 'Octocat/Hello-World', path: './src/App.js', created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, 'octocat/hello-world:src/App.js')
  assert.equal(row.label, 'App.js')
})

test('Issue / PullRequest / Review nodes carry state props', () => {
  const issue = rule('node', 'Issue').toRow({ repo: 'o/r', number: 42, state: 'closed', created_at: TS })
  assert.ok(issue)
  assert.equal(issue.natural_key, 'o/r#42')
  assert.deepEqual(issue.props, { state: 'closed' })

  const pr = rule('node', 'PullRequest').toRow({ repo: 'o/r', number: 7, state: 'merged', created_at: TS })
  assert.ok(pr)
  assert.equal(pr.natural_key, 'o/r#7')
  assert.deepEqual(pr.props, { state: 'merged' })

  const review = rule('node', 'Review').toRow({ review_id: 80, review_state: 'APPROVED', created_at: TS })
  assert.ok(review)
  assert.equal(review.natural_key, 'review/80')
  assert.deepEqual(review.props, { state: 'APPROVED' })
})

test('Commit -in-> Repo and File -in-> Repo wire node ids', () => {
  const commitIn = rule('edge', 'in', { eventType: 'commit' }).toRow({ repo: 'o/r', sha: 'abc', created_at: TS })
  assert.ok(commitIn)
  assert.equal(commitIn.src_type, 'Commit')
  assert.equal(commitIn.dst_type, 'Repo')
  assert.equal(commitIn.src_id, nodeId('Commit', 'abc'))
  assert.equal(commitIn.dst_id, nodeId('Repo', 'o/r'))

  const fileIn = rule('edge', 'in', { column: 'path' }).toRow({ repo: 'o/r', path: 'a.js', created_at: TS })
  assert.ok(fileIn)
  assert.equal(fileIn.src_type, 'File')
  assert.equal(fileIn.dst_type, 'Repo')
  assert.equal(fileIn.dst_id, nodeId('Repo', 'o/r'))
})

test('authorship + activity edges', () => {
  const authored = rule('edge', 'authored').toRow({ actor_login: 'Octo', sha: 'abc', created_at: TS })
  assert.ok(authored)
  assert.equal(authored.src_id, nodeId('Actor', 'octo'))
  assert.equal(authored.dst_id, nodeId('Commit', 'abc'))

  const openedPr = rule('edge', 'opened', { eventType: 'pull_request' }).toRow({ repo: 'o/r', number: 7, actor_login: 'Octo', created_at: TS })
  assert.ok(openedPr)
  assert.equal(openedPr.src_type, 'Actor')
  assert.equal(openedPr.dst_type, 'PullRequest')
  assert.equal(openedPr.dst_id, nodeId('PullRequest', 'o/r#7'))
})

test('comment edges discriminate Issue vs PullRequest by event_type', () => {
  const onIssue = rule('edge', 'commented', { eventType: 'issue_comment' }).toRow({ repo: 'o/r', number: 5, actor_login: 'a', created_at: TS })
  assert.ok(onIssue)
  assert.equal(onIssue.dst_type, 'Issue')

  const onPr = rule('edge', 'commented', { eventType: 'pull_request_comment' }).toRow({ repo: 'o/r', number: 5, actor_login: 'a', created_at: TS })
  assert.ok(onPr)
  assert.equal(onPr.dst_type, 'PullRequest')
})

test('review, code, and linkage edges', () => {
  const submitted = rule('edge', 'submitted').toRow({ actor_login: 'a', review_id: 80, created_at: TS })
  assert.ok(submitted)
  assert.equal(submitted.dst_id, nodeId('Review', 'review/80'))

  const on = rule('edge', 'on').toRow({ repo: 'o/r', review_id: 80, pr_number: 7, created_at: TS })
  assert.ok(on)
  assert.equal(on.src_id, nodeId('Review', 'review/80'))
  assert.equal(on.dst_id, nodeId('PullRequest', 'o/r#7'))

  const commitTouched = rule('edge', 'touched', { eventType: 'commit_file' }).toRow({ sha: 'abc', repo: 'o/r', path: 'a.js', created_at: TS })
  assert.ok(commitTouched)
  assert.equal(commitTouched.src_id, nodeId('Commit', 'abc'))
  assert.equal(commitTouched.dst_id, nodeId('File', 'o/r:a.js'))

  const prTouched = rule('edge', 'touched', { eventType: 'pull_request_file' }).toRow({ repo: 'o/r', number: 7, path: 'a.js', created_at: TS })
  assert.ok(prTouched)
  assert.equal(prTouched.src_id, nodeId('PullRequest', 'o/r#7'))

  const references = rule('edge', 'references').toRow({ repo: 'o/r', sha: 'abc', pr_number: 7, created_at: TS })
  assert.ok(references)
  assert.equal(references.src_id, nodeId('PullRequest', 'o/r#7'))
  assert.equal(references.dst_id, nodeId('Commit', 'abc'))
})

test('every rule skips rows missing an endpoint key', () => {
  assert.equal(rule('edge', 'authored').toRow({ actor_login: null, sha: 'abc', created_at: TS }), null)
  assert.equal(rule('edge', 'on').toRow({ repo: 'o/r', review_id: 80, pr_number: null, created_at: TS }), null)
  assert.equal(rule('edge', 'references').toRow({ repo: 'o/r', sha: null, pr_number: 7, created_at: TS }), null)
})

test('every rule uses the one-scan declarative contract form', () => {
  for (const r of contract.rules) {
    assert.equal(r.sql, undefined)
    assert.ok(Array.isArray(r.columns) && r.columns.length > 0, `${r.kind}/${r.type} declares columns`)
    assert.equal(typeof r.toRow, 'function')
    assert.ok(r.kind === 'node' || r.kind === 'edge')
  }
})
