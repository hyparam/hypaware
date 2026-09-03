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
  repoKeyFromRemote,
  reviewKey,
} from '../../hypaware-core/plugins-workspace/github/src/keys.js'

import * as hostKeys from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph-keys.js'

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

/**
 * The two in-repo key modules are hand-synced copies (LLP 0032
 * §shared-key-vocabulary). Until this PR they lived in separate repositories
 * and only independent digest pins on either side could catch a drift, which
 * meant a drift showed up as two pins disagreeing about nothing in particular.
 * Now that both are here, assert directly that the shared recipes agree: a
 * divergence is a silent orphaning of every already-projected node, so it must
 * be a failing test rather than a discovery.
 *
 * @ref LLP 0032#shared-key-vocabulary [tests]: the host twin and the GitHub side must normalize identically
 */
test('the GitHub and host key modules agree on every shared recipe', () => {
  const repos = [
    'Octocat/Hello-World',
    'octocat/hello-world',
    'ACME/Widgets.js',
    'a/b',
    'no-slash',
    '',
  ]
  for (const value of repos) {
    assert.equal(repoKey(value), hostKeys.repoKey(value), `repoKey(${JSON.stringify(value)})`)
  }

  const remotes = [
    'git@github.com:Acme/Widgets.git',
    'https://github.com/Acme/Widgets.git',
    'https://www.github.com/Acme/Widgets/',
    'ssh://git@github.com:22/Acme/Widgets.git',
    'https://gitlab.com/acme/widgets.git',
    '',
  ]
  for (const value of remotes) {
    assert.equal(repoKeyFromRemote(value), hostKeys.repoKeyFromRemote(value), `repoKeyFromRemote(${JSON.stringify(value)})`)
  }

  const paths = ['src/a.js', './src/a.js', '/src/a.js', 'src\\a.js', '']
  for (const value of paths) {
    assert.equal(fileKey('Acme/Widgets', value), hostKeys.fileKey('Acme/Widgets', value), `fileKey(${JSON.stringify(value)})`)
  }

  // Full shas are byte-identical, which is the half convergence depends on.
  for (const sha of ['6dcb09b5b57875f334f61aebed695e2e4193db5e', '6DCB09B5B57875F334F61AEBED695E2E4193DB5E']) {
    assert.equal(commitKey(sha), hostKeys.commitKey(sha), `commitKey(${sha})`)
  }

  // The one settled divergence: the host refuses to key an abbreviated sha so
  // it cannot mint a node the GitHub side will never converge with; the GitHub
  // side trusts its API for full shas (LLP 0032#abbreviated-sha-guard).
  assert.equal(commitKey('6dcb09b5'), '6dcb09b5')
  assert.equal(hostKeys.commitKey('6dcb09b5'), null)
})
