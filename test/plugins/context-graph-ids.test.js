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
  // Keys containing spaces must not collide with delimiter boundaries.
  assert.equal(nodeId('File', '/tmp/a b.txt'), 'f089fa67a6b72ea65ff004f9')
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
