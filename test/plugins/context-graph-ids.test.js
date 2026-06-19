// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { edgeId, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/ids.js'

// Graph ids are content-addressed: every committed node/edge row keys on
// these digests, so any change to the hash recipe (algorithm, truncation,
// or the NUL delimiter between segments) orphans all existing graph rows.
// These pins exist to make such a change a deliberate, visible decision.
test('nodeId pins known digests', () => {
  assert.equal(nodeId('Session', 'conv-1'), '5f39286b22257c21464b8de1')
  assert.equal(nodeId('App', 'claude'), '2e9bdd4283a3dfed19a24ddc')
  // Keys containing spaces must not collide with delimiter boundaries. This is
  // ALSO an out-of-repo File path: the LLP 0032 File re-key only bridges paths
  // INSIDE a captured repo, so an absolute /tmp path keeps its key — this pin is
  // deliberately unchanged by the migration.
  assert.equal(nodeId('File', '/tmp/a b.txt'), 'f089fa67a6b72ea65ff004f9')
})

// LLP 0032 bridge keys, pinned at the recipe level (the contract-driven
// convergence proof lives in ai-gateway-graph-bridge.test.js). These ids equal
// what @hypaware/github mints for Octocat/Hello-World, so they double as the
// cross-repo contract: a change to the id recipe here breaks both sides.
test('nodeId pins the GitHub↔LLM bridge keys', () => {
  assert.equal(nodeId('Repo', 'octocat/hello-world'), 'e1505143b1ca95f6a92c3681')
  assert.equal(nodeId('Commit', '6dcb09b5b57875f334f61aebed695e2e4193db5e'), 'c40ec7e789b96f5b036504dd')
  assert.equal(nodeId('File', 'octocat/hello-world:src/App.js'), 'ca7c3b2086e794a4ac00a9e0')
})

test('edgeId pins known digests', () => {
  const src = nodeId('Session', 'conv-1')
  const dst = nodeId('App', 'claude')
  assert.equal(edgeId(src, 'via', dst), '90e14c2a6aea4322fcf96cfe')
})

test('ids are 24 lowercase hex chars and delimiter-collision-free', () => {
  const id = nodeId('Session', 'x')
  assert.match(id, /^[0-9a-f]{24}$/)
  // A space inside the key must hash differently from a space-delimited
  // reading of the segments (the NUL join guarantees this).
  assert.notEqual(nodeId('Session', 'a b'), nodeId('Session a', 'b'))
  assert.notEqual(edgeId('s', 'a b', 'd'), edgeId('s a', 'b', 'd'))
})
