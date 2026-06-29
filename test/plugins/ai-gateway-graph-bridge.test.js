// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { edgeId, makeRowBuilders, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import { createAiGatewayGraphContract } from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js'

// Cross-source convergence guard (LLP 0032). A repo, commit, or file seen by
// BOTH @hypaware/github and a recorded Claude/Codex session must land on ONE
// graph node: the whole point of the bridge. Convergence is automatic given a
// shared natural key + a shared id recipe (LLP 0023 §content-addressed-ids), and
// the GitHub plugin imports THIS repo's id recipe, so the only thing that can
// break convergence is a key-normalization drift between this connector's
// `graph-keys.js` and the GitHub side. These digests are lifted verbatim from the GitHub plugin's published
// pins (`github-hyp-plugin/test/graph-ids.test.js`) for `Octocat/Hello-World`;
// asserting the HOST bridge mints the same ids from a session's captured
// remote/sha/path proves the join fires. If a host key recipe drifts, these
// fail; if the GitHub side drifts, its pins change and these must be updated in
// lockstep: either way the break is deliberate and visible.
const GITHUB_PINS = {
  repo: 'e1505143b1ca95f6a92c3681', // nodeId('Repo', 'octocat/hello-world')
  commit: 'c40ec7e789b96f5b036504dd', // nodeId('Commit', '6dcb…db5e')
  file: 'ca7c3b2086e794a4ac00a9e0', // nodeId('File', 'octocat/hello-world:src/App.js')
  commitInRepo: 'f036a2845fc3f585cb6cbfe2', // edgeId(commit, 'in', repo)
}

const KIT = { nodeId, edgeId, makeRowBuilders }
const contract = createAiGatewayGraphContract(KIT)
const TS = '2026-06-18T12:00:00.000Z'

/**
 * @param {'node' | 'edge'} kind
 * @param {string} type
 * @param {number} [nth]
 */
function rule(kind, type, nth = 0) {
  const found = contract.rules.filter((r) => r.kind === kind && r.type === type)
  assert.ok(found[nth], `${kind} rule ${type} #${nth} exists`)
  return found[nth]
}

// A session sitting on Octocat/Hello-World, expressed the way capture produces
// it: a git remote URL, a full HEAD sha, an absolute repo root, and absolute
// file paths under it.
const REMOTE = 'https://github.com/Octocat/Hello-World.git'
const SHA = '6DCB09B5B57875F334F61AEBED695E2E4193DB5E'
const REPO_ROOT = '/Users/dev/Hello-World'
const FILE_ABS = '/Users/dev/Hello-World/src/App.js'

test('host Repo node converges with the GitHub Repo node', () => {
  const row = rule('node', 'Repo').toRow({ git_remote: REMOTE, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.node_id, GITHUB_PINS.repo, 'same id @hypaware/github mints for Octocat/Hello-World')
  assert.equal(row.node_id, nodeId('Repo', 'octocat/hello-world'))
})

test('host Commit node converges with the GitHub Commit node (full sha, any case)', () => {
  const row = rule('node', 'Commit').toRow({ head_sha: SHA, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.node_id, GITHUB_PINS.commit)
})

test('host File node converges with the GitHub File node via owner/repo:relpath', () => {
  const row = rule('node', 'File').toRow({
    tool_name: 'Edit',
    tool_args: { file_path: FILE_ABS },
    git_remote: REMOTE,
    repo_root: REPO_ROOT,
    message_created_at: TS,
  })
  assert.ok(row)
  assert.equal(row.natural_key, 'octocat/hello-world:src/App.js')
  assert.equal(row.node_id, GITHUB_PINS.file, 'same id @hypaware/github mints for Octocat/Hello-World:src/App.js')
})

test('host Commit -in-> Repo edge converges with the GitHub edge', () => {
  const row = rule('edge', 'in', 1).toRow({ head_sha: SHA, git_remote: REMOTE, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.edge_id, GITHUB_PINS.commitInRepo)
})

test('worktrees of one repo converge on a single File node', () => {
  // Same file, two checkouts: the main repo and a linked worktree. Different
  // absolute paths and repo roots, but the remote and relpath are identical, so
  // the bridge key (and therefore the node id) is the same. Absolute-path
  // keying (pre-0032) would have split this into two File nodes.
  const main = rule('node', 'File').toRow({
    tool_name: 'Edit',
    tool_args: { file_path: '/Users/dev/Hello-World/src/App.js' },
    git_remote: REMOTE,
    repo_root: '/Users/dev/Hello-World',
    message_created_at: TS,
  })
  const worktree = rule('node', 'File').toRow({
    tool_name: 'Edit',
    tool_args: { file_path: '/Users/dev/wt/feature/src/App.js' },
    git_remote: REMOTE,
    repo_root: '/Users/dev/wt/feature',
    message_created_at: TS,
  })
  assert.ok(main && worktree)
  assert.equal(main.node_id, worktree.node_id, 'one File node across both worktrees')
  assert.equal(main.node_id, GITHUB_PINS.file)
})
