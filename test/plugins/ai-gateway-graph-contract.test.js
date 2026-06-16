// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { edgeId, makeRowBuilders, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import {
  createAiGatewayGraphContract,
  PROJECTOR,
  PROJECTOR_VERSION,
  SOURCE_DATASET,
} from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js'

// Build the contract the way the connector's activate() does: from the graph
// plugin's shared kit. The rules' row identity + provenance are therefore the
// real end-to-end ones — these assertions double as the digest-stability guard.
const KIT = { nodeId, edgeId, makeRowBuilders }
const contract = createAiGatewayGraphContract(KIT)

/**
 * @param {'node' | 'edge'} kind
 * @param {string} type
 */
function rule(kind, type) {
  const found = contract.rules.find((r) => r.kind === kind && r.type === type)
  assert.ok(found, `${kind} rule ${type} exists`)
  return found
}

const TS = '2026-06-05T12:00:00.000Z'

test('contract carries its source/projector metadata', () => {
  assert.equal(contract.name, 'ai-gateway-t0')
  assert.equal(contract.plugin, '@hypaware/ai-gateway-graph')
  assert.equal(contract.sourceDataset, SOURCE_DATASET)
  assert.equal(contract.sourceDataset, 'ai_gateway_messages')
  assert.equal(contract.projector, PROJECTOR)
  assert.equal(contract.projectorVersion, PROJECTOR_VERSION)
})

// @ref LLP 0030#decision — the Session node keys on session_id (the
// session container, always present); conversation_id is null for Claude.
test('Session rule builds a node keyed on session_id with pruned props', () => {
  const r = rule('node', 'Session')
  const row = r.toRow({
    session_id: 'sess-1',
    cwd: '/repo',
    git_branch: null,
    client_name: 'claude',
    user_id: undefined,
    message_created_at: TS,
  })
  assert.ok(row)
  assert.equal(row.node_id, nodeId('Session', 'sess-1'))
  assert.equal(row.node_type, 'Session')
  assert.equal(row.natural_key, 'sess-1')
  assert.deepEqual(row.props, { client_name: 'claude', cwd: '/repo' }, 'null/undefined props dropped, keys sorted')
  assert.equal(row.first_seen, TS)
  assert.equal(row.source_dataset, SOURCE_DATASET)
  assert.deepEqual(row.source_keys, { session_id: 'sess-1' })
  assert.equal(row.projector, PROJECTOR)
  assert.equal(row.projector_version, PROJECTOR_VERSION)
})

test('node rules skip rows missing their natural key', () => {
  assert.equal(rule('node', 'Session').toRow({ session_id: null, message_created_at: TS }), null)
  assert.equal(rule('node', 'Session').toRow({ session_id: '', message_created_at: TS }), null)
  assert.equal(rule('node', 'App').toRow({ client_name: null, message_created_at: TS }), null)
  assert.equal(rule('node', 'Model').toRow({ model: undefined, message_created_at: TS }), null)
  assert.equal(rule('node', 'Tool').toRow({ tool_name: '', message_created_at: TS }), null)
})

test('Session rule with no optional fields builds null props', () => {
  const row = rule('node', 'Session').toRow({ session_id: 'sess-1', message_created_at: TS })
  assert.ok(row)
  assert.equal(row.props, null, 'empty props prune to null')
})

test('File rule resolves file_path from file-touching tools only', () => {
  const r = rule('node', 'File')
  const row = r.toRow({ tool_name: 'Read', tool_args: { file_path: '/repo/auth.py' }, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.node_id, nodeId('File', '/repo/auth.py'))
  assert.equal(row.natural_key, '/repo/auth.py')
  assert.equal(row.label, 'auth.py')

  assert.equal(r.toRow({ tool_name: 'Bash', tool_args: { file_path: '/x' }, message_created_at: TS }), null, 'non-file tool skipped')
  assert.equal(r.toRow({ tool_name: 'Read', tool_args: {}, message_created_at: TS }), null, 'no path in args')
  assert.equal(r.toRow({ tool_name: null, tool_args: { file_path: '/x' }, message_created_at: TS }), null)
})

test('File rule parses tool_args arriving as a JSON string, skipping malformed JSON', () => {
  const r = rule('node', 'File')
  const row = r.toRow({ tool_name: 'Edit', tool_args: '{"file_path":"/repo/proxy.py"}', message_created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, '/repo/proxy.py')

  assert.equal(r.toRow({ tool_name: 'Edit', tool_args: '{not json', message_created_at: TS }), null, 'malformed JSON skipped')
  assert.equal(r.toRow({ tool_name: 'Edit', tool_args: '"just a string"', message_created_at: TS }), null, 'non-object JSON skipped')
})

test('File rule falls back to notebook_path', () => {
  const r = rule('node', 'File')
  const row = r.toRow({ tool_name: 'NotebookEdit', tool_args: { notebook_path: '/repo/nb.ipynb' }, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, '/repo/nb.ipynb')
  assert.equal(row.label, 'nb.ipynb')
})

test('touched edge wires Session and File node ids and skips partial rows', () => {
  const r = rule('edge', 'touched')
  const row = r.toRow({
    session_id: 'sess-1',
    tool_name: 'Write',
    tool_args: { file_path: '/repo/a.js' },
    message_created_at: TS,
  })
  assert.ok(row)
  const src = nodeId('Session', 'sess-1')
  const dst = nodeId('File', '/repo/a.js')
  assert.equal(row.src_id, src)
  assert.equal(row.dst_id, dst)
  assert.equal(row.edge_id, edgeId(src, 'touched', dst))
  assert.equal(row.src_type, 'Session')
  assert.equal(row.dst_type, 'File')

  assert.equal(r.toRow({ session_id: 'sess-1', tool_name: 'Bash', tool_args: {}, message_created_at: TS }), null)
  assert.equal(r.toRow({ session_id: null, tool_name: 'Write', tool_args: { file_path: '/x' }, message_created_at: TS }), null)
})

test('via and used_model edges skip rows missing either endpoint', () => {
  const via = rule('edge', 'via')
  assert.ok(via.toRow({ session_id: 'c', client_name: 'a', message_created_at: TS }))
  assert.equal(via.toRow({ session_id: 'c', client_name: null, message_created_at: TS }), null)
  assert.equal(via.toRow({ session_id: null, client_name: 'a', message_created_at: TS }), null)

  const used = rule('edge', 'used_model')
  assert.ok(used.toRow({ session_id: 'c', model: 'm', message_created_at: TS }))
  assert.equal(used.toRow({ session_id: 'c', model: '', message_created_at: TS }), null)
})

test('toRow normalizes first_seen from Date and epoch-number timestamps', () => {
  const r = rule('node', 'App')
  const fromDate = r.toRow({ client_name: 'claude', message_created_at: new Date(TS) })
  assert.ok(fromDate)
  assert.equal(fromDate.first_seen, TS)

  const fromNumber = r.toRow({ client_name: 'claude', message_created_at: Date.parse(TS) })
  assert.ok(fromNumber)
  assert.equal(fromNumber.first_seen, TS)

  const fromGarbage = r.toRow({ client_name: 'claude', message_created_at: '' })
  assert.ok(fromGarbage)
  assert.equal(fromGarbage.first_seen, null)
})

test('numeric natural keys are stringified', () => {
  const row = rule('node', 'Session').toRow({ session_id: 42, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, '42')
  assert.equal(row.node_id, nodeId('Session', '42'))
})

// @ref LLP 0026#decision — Claude harness aux exchanges are retained (tagged
// attributes.claude.aux_kind) rather than dropped; the graph contract must
// exclude them so security-monitor traffic mints no Session/App/Tool noise.
test('every rule selects attributes so the shared aux filter has its input', () => {
  for (const r of contract.rules) {
    assert.match(r.sql, /^SELECT\s+attributes\b/i, `rule ${r.kind}/${r.type} projects attributes`)
  }
})

test('aux-tagged rows are excluded from every node and edge rule', () => {
  const aux = { attributes: { claude: { aux_kind: 'security_monitor' } } }
  // Otherwise-valid rows that would each mint a node/edge if not aux.
  assert.equal(rule('node', 'Session').toRow({ ...aux, conversation_id: 'conv-1', message_created_at: TS }), null)
  assert.equal(rule('node', 'App').toRow({ ...aux, client_name: 'claude', message_created_at: TS }), null)
  assert.equal(rule('node', 'Model').toRow({ ...aux, model: 'claude-opus', message_created_at: TS }), null)
  assert.equal(rule('node', 'Tool').toRow({ ...aux, tool_name: 'Read', part_type: 'tool_call', message_created_at: TS }), null)
  assert.equal(rule('node', 'File').toRow({ ...aux, tool_name: 'Read', tool_args: { file_path: '/x' }, message_created_at: TS }), null)
  assert.equal(rule('edge', 'via').toRow({ ...aux, conversation_id: 'c', client_name: 'a', message_created_at: TS }), null)
  assert.equal(rule('edge', 'used_model').toRow({ ...aux, conversation_id: 'c', model: 'm', message_created_at: TS }), null)
  assert.equal(rule('edge', 'used').toRow({ ...aux, conversation_id: 'c', tool_name: 'Read', message_created_at: TS }), null)
  assert.equal(rule('edge', 'touched').toRow({ ...aux, conversation_id: 'c', tool_name: 'Write', tool_args: { file_path: '/a.js' }, message_created_at: TS }), null)
})

test('aux filter handles attributes arriving as a JSON string', () => {
  const row = rule('node', 'Session').toRow({
    attributes: JSON.stringify({ claude: { aux_kind: 'security_monitor' } }),
    conversation_id: 'conv-1',
    message_created_at: TS,
  })
  assert.equal(row, null, 'aux_kind in a stringified attributes column is still excluded')
})

test('non-aux rows pass through unchanged (attributes present but no aux_kind)', () => {
  const row = rule('node', 'Session').toRow({
    attributes: { claude: { client_name: 'claude' }, dev_run_id: 'run-1' },
    conversation_id: 'conv-real',
    message_created_at: TS,
  })
  assert.ok(row, 'a real row with attributes but no aux_kind still mints its node')
  assert.equal(row.natural_key, 'conv-real')
})
