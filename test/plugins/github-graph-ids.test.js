// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { edgeId, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import {
  actorKey,
  commitKey,
  fileKey,
  issueKey,
  pullRequestKey,
  repoKey,
  reviewKey,
} from '../../hypaware-core/plugins-workspace/github/src/keys.js'

/**
 * Assert a key helper produced a non-null key (these test inputs are all
 * well-formed) and narrow the type for `nodeId`/`edgeId`.
 *
 * @param {string | null} key
 * @returns {string}
 */
function req(key) {
  assert.ok(key, 'key helper returned a normalized (non-null) key')
  return key
}

// Digest-pinning test (LLP 0003 §keys-are-pinned), the equivalent of the host's
// context-graph-ids.test.js. Graph node/edge ids are content-addressed over the
// (kind, type, NORMALIZED natural key); every committed graph row keys on these
// digests. Pinning known (type, key) to id digests, computed with the REAL host
// id recipe (`nodeId`/`edgeId`) over THIS plugin's real key helpers, makes a
// change to either side (the key normalization here, or the id recipe in the
// graph plugin) a deliberate, visible decision rather than a silent orphaning of
// every committed GitHub graph row.

test('node ids pin for the bridge-ready + internal key recipes', () => {
  assert.equal(nodeId('Repo', req(repoKey('Octocat/Hello-World'))), 'e1505143b1ca95f6a92c3681')
  assert.equal(nodeId('Actor', req(actorKey('Octocat'))), '5bbb70f2c487c4f987dd80ac')
  assert.equal(nodeId('Commit', req(commitKey('6DCB09B5B57875F334F61AEBED695E2E4193DB5E'))), 'c40ec7e789b96f5b036504dd')
  assert.equal(nodeId('File', req(fileKey('Octocat/Hello-World', './src/App.js'))), 'ca7c3b2086e794a4ac00a9e0')
  assert.equal(nodeId('Issue', req(issueKey('Octocat/Hello-World', 42))), '04d803c4d755fddc7c90845d')
  assert.equal(nodeId('PullRequest', req(pullRequestKey('Octocat/Hello-World', 1347))), 'a576a333d8effc3a3d90a300')
  assert.equal(nodeId('Review', req(reviewKey(80))), 'd48db5eff55f8c444c1fb0a6')
})

test('edge ids pin for representative relations', () => {
  const repo = nodeId('Repo', req(repoKey('Octocat/Hello-World')))
  const actor = nodeId('Actor', req(actorKey('Octocat')))
  const commit = nodeId('Commit', req(commitKey('6DCB09B5B57875F334F61AEBED695E2E4193DB5E')))
  const pr = nodeId('PullRequest', req(pullRequestKey('Octocat/Hello-World', 1347)))
  const file = nodeId('File', req(fileKey('Octocat/Hello-World', './src/App.js')))

  assert.equal(edgeId(commit, 'in', repo), 'f036a2845fc3f585cb6cbfe2')
  assert.equal(edgeId(actor, 'authored', commit), '8cae53f7b24c73c0d0436964')
  assert.equal(edgeId(pr, 'touched', file), '9e31f7cf4a93ffc3d167cec9')
})

test('case-insensitive inputs converge on one id (the whole point of normalization)', () => {
  assert.equal(nodeId('Repo', req(repoKey('OCTOCAT/HELLO-WORLD'))), nodeId('Repo', req(repoKey('octocat/hello-world'))))
  assert.equal(nodeId('Commit', req(commitKey('6DCB09B5'))), nodeId('Commit', req(commitKey('6dcb09b5'))))
})
