// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { edgeId, makeRowBuilders, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import { createContractRegistry } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-registry.js'

// The contract kit and registry are what `@hypaware/context-graph` owns after
// the contract rules moved out to source plugins: the central id recipe +
// provenance stamping (kit), and the place sources contribute contracts the
// engine iterates (registry). Rule semantics live with each source (see
// ai-gateway-graph-contract.test.js).

const TS = '2026-06-01T00:00:00.000Z'

test('makeRowBuilders stamps provenance from the passed metadata', () => {
  const { buildNode, buildEdge } = makeRowBuilders({ sourceDataset: 'src_ds', projector: 'src.t0', projectorVersion: 3 })

  const n = buildNode({ type: 'Session', key: 'k', props: { a: 1 }, firstSeen: TS, sourceKeys: { conversation_id: 'k' } })
  assert.equal(n.node_id, nodeId('Session', 'k'))
  assert.equal(n.node_type, 'Session')
  assert.equal(n.natural_key, 'k')
  assert.equal(n.source_dataset, 'src_ds')
  assert.equal(n.projector, 'src.t0')
  assert.equal(n.projector_version, 3)
  assert.deepEqual(n.source_keys, { conversation_id: 'k' })

  const e = buildEdge({ type: 'via', srcType: 'Session', srcKey: 'k', dstType: 'App', dstKey: 'a', firstSeen: TS, sourceKeys: {} })
  assert.equal(e.edge_id, edgeId(nodeId('Session', 'k'), 'via', nodeId('App', 'a')))
  assert.equal(e.src_type, 'Session')
  assert.equal(e.dst_type, 'App')
  assert.equal(e.source_dataset, 'src_ds')
  assert.equal(e.projector, 'src.t0')
  assert.equal(e.projector_version, 3)
})

test('makeRowBuilders normalizes first_seen and prunes empty props to null', () => {
  const { buildNode } = makeRowBuilders({ sourceDataset: 's', projector: 'p', projectorVersion: 1 })
  assert.equal(buildNode({ type: 'A', key: 'k', firstSeen: new Date(TS), sourceKeys: {} }).first_seen, TS)
  assert.equal(buildNode({ type: 'A', key: 'k', firstSeen: Date.parse(TS), sourceKeys: {} }).first_seen, TS)
  assert.equal(buildNode({ type: 'A', key: 'k', firstSeen: '', sourceKeys: {} }).first_seen, null)
  assert.equal(buildNode({ type: 'A', key: 'k', props: {}, firstSeen: TS, sourceKeys: {} }).props, null)
})

test('the id recipe is source-agnostic — same (type, key) converges across sources', () => {
  const imsg = makeRowBuilders({ sourceDataset: 'imessage', projector: 'imsg.t0', projectorVersion: 1 })
  const aigw = makeRowBuilders({ sourceDataset: 'ai_gateway_messages', projector: 'ai-gateway.t0', projectorVersion: 1 })
  const a = imsg.buildNode({ type: 'Actor', key: 'phil', firstSeen: TS, sourceKeys: {} })
  const b = aigw.buildNode({ type: 'Actor', key: 'phil', firstSeen: TS, sourceKeys: {} })
  assert.equal(a.node_id, b.node_id, 'two sources naming the same node mint the same id')
  assert.notEqual(a.source_dataset, b.source_dataset, 'but provenance still distinguishes them')
})

/**
 * A minimal well-formed contract for registry tests; `overrides` may also make
 * it intentionally malformed, so the return is intentionally untyped.
 * @param {Record<string, unknown>} [overrides]
 * @returns {any}
 */
function sampleContract(overrides = {}) {
  return {
    name: 'x-src',
    plugin: '@x/x',
    sourceDataset: 'x',
    projector: 'x.t0',
    projectorVersion: 1,
    rules: [{ kind: 'node', type: 'T', sql: 'SELECT 1', toRow: () => null }],
    ...overrides,
  }
}

test('contract registry registers contracts and lists them name-sorted', () => {
  const reg = createContractRegistry()
  reg.register(sampleContract({ name: 'b-src', plugin: '@x/b' }))
  reg.register(sampleContract({ name: 'a-src', plugin: '@x/a' }))
  assert.deepEqual(reg.list().map((c) => c.name), ['a-src', 'b-src'])
})

test('contract registry rejects malformed contracts', () => {
  const reg = createContractRegistry()
  assert.throws(() => reg.register(sampleContract({ name: '' })), /name/)
  assert.throws(() => reg.register(sampleContract({ plugin: '' })), /plugin/)
  assert.throws(() => reg.register(sampleContract({ sourceDataset: '' })), /sourceDataset/)
  assert.throws(() => reg.register(sampleContract({ projector: '' })), /projector/)
  assert.throws(() => reg.register(sampleContract({ projectorVersion: 1.5 })), /projectorVersion/)
  assert.throws(() => reg.register(sampleContract({ rules: [] })), /rules/)
})

test('contract registry rejects malformed rules, naming the offending rule index', () => {
  const reg = createContractRegistry()
  const ok = { kind: 'node', type: 'T', sql: 'SELECT 1', toRow: () => null }
  // A good rule at 0, a bad one at 1 — the error pins which rule and which field,
  // so a connector typo fails at registration with a locatable message rather
  // than mid-projection (or by silently routing rows into the wrong target map).
  assert.throws(() => reg.register(sampleContract({ rules: [ok, { ...ok, kind: 'vertex' }] })), /rule 1 kind/)
  assert.throws(() => reg.register(sampleContract({ rules: [{ ...ok, type: '' }] })), /rule 0 type/)
  assert.throws(() => reg.register(sampleContract({ rules: [{ ...ok, sql: '' }] })), /rule 0 sql/)
  assert.throws(() => reg.register(sampleContract({ rules: [{ ...ok, toRow: 'nope' }] })), /rule 0 toRow/)
  assert.throws(() => reg.register(sampleContract({ rules: [null] })), /rule 0 must be an object/)
})

test('contract registry rejects a duplicate (plugin, name)', () => {
  const reg = createContractRegistry()
  reg.register(sampleContract())
  assert.throws(() => reg.register(sampleContract()), /duplicate/)
})
