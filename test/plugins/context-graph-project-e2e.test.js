// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { executeQuerySql } from '../../src/core/query/sql.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'
import { aiGatewayDatasetRegistration, DATASET_NAME } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { edgeId, keys, makeRowBuilders, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import { graphDatasetRegistration } from '../../hypaware-core/plugins-workspace/context-graph/src/datasets.js'
import { projectGraph } from '../../hypaware-core/plugins-workspace/context-graph/src/project.js'
import { createAiGatewayGraphContract } from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js'

/**
 * @import { Contract } from '../../hypaware-core/plugins-workspace/context-graph/src/types.d.ts'
 */

// End-to-end: a contributed contract, run by the engine, over a real seeded
// `ai_gateway_messages` dataset. Proves Task 2 (engine iterates contracts),
// Task 3 (the connector's contract), and Task 1 (the kit) together, and is the
// automated regression that the relocation changed nothing observable.

// @ref LLP 0030#decision — the ai-gateway contract keys the Session on
// session_id now (conversation_id is null for Claude). The fixture carries
// both columns: session_id for the contract under test, conversation_id for
// the version-bump regression's bespoke session-only contract below.
/** Only the columns the ai-gateway contract reads (a subset of the full schema). */
const COLUMNS = /** @type {const} */ ([
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'conversation_id', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'git_branch', type: 'STRING', nullable: true },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'user_id', type: 'STRING', nullable: true },
  { name: 'model', type: 'STRING', nullable: true },
  { name: 'tool_name', type: 'STRING', nullable: true },
  { name: 'tool_args', type: 'STRING', nullable: true },
  { name: 'part_type', type: 'STRING', nullable: true },
  { name: 'message_created_at', type: 'STRING', nullable: true },
  // `attributes` is a real (always-present) column the contract's shared aux
  // filter reads to exclude Claude harness aux rows (LLP 0026). JSON arrives
  // as a string here, exactly like `tool_args`.
  { name: 'attributes', type: 'STRING', nullable: true },
])

const ROWS = [
  {
    session_id: 'sess-1', conversation_id: null, cwd: '/repo', git_branch: 'main', client_name: 'claude-code',
    user_id: 'u1', model: 'sonnet', tool_name: null, tool_args: null, part_type: 'text',
    message_created_at: '2026-06-01T00:00:00.000Z', attributes: '{"dev_run_id":"run-1"}',
  },
  {
    session_id: 'sess-1', conversation_id: null, cwd: null, git_branch: null, client_name: 'claude-code',
    user_id: null, model: 'sonnet', tool_name: 'Read', tool_args: '{"file_path":"/repo/auth.py"}',
    part_type: 'tool_call', message_created_at: '2026-06-01T00:01:00.000Z', attributes: null,
  },
]

// A Claude harness aux exchange: retained in the source (tagged
// attributes.claude.aux_kind) but it must NOT mint any graph node/edge. Its
// keys are all distinct, so a regressed filter would change the node/edge
// counts. Seeded only by the aux-exclusion test (the provenance tests use a
// single-conversation fixture).
const AUX_ROW = {
  session_id: 'sess-aux', conversation_id: null, cwd: '/repo', git_branch: 'main', client_name: 'aux-app',
  user_id: 'u1', model: 'aux-model', tool_name: 'Read', tool_args: '{"file_path":"/repo/secret.py"}',
  part_type: 'tool_call', message_created_at: '2026-06-01T00:02:00.000Z',
  attributes: '{"claude":{"aux_kind":"security_monitor"}}',
}

/**
 * @param {(deps: { registry: any, storage: any }) => Promise<void>} body
 * @param {Record<string, unknown>[]} [rows]
 */
async function withSeededGateway(body, rows = ROWS) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-e2e-'))
  try {
    const registry = createQueryRegistry()
    registry.registerDataset(aiGatewayDatasetRegistration())
    registry.registerDataset(graphDatasetRegistration('node'))
    registry.registerDataset(graphDatasetRegistration('edge'))
    await appendRowsToSourceTable(cacheRoot, DATASET_NAME, ['source=claude'], [...COLUMNS], rows)
    const storage = createQueryStorageService({ cacheRoot })
    await body({ registry, storage })
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
}

test('projectGraph runs a contributed contract end to end and is idempotent', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const contract = createAiGatewayGraphContract({ nodeId, edgeId, makeRowBuilders, keys })

    const first = await projectGraph({ query: registry, storage, contracts: [contract] })
    assert.equal(first.nodes, 5, 'Session, App, Model, Tool, File')
    assert.equal(first.edges, 4, 'via, used_model, used, touched')
    assert.equal(first.nodesWritten, 5)
    assert.equal(first.edgesWritten, 4)

    const again = await projectGraph({ query: registry, storage, contracts: [contract] })
    assert.equal(again.nodesWritten, 0, 're-projection writes nothing (idempotent)')
    assert.equal(again.edgesWritten, 0)

    // Provenance, end to end: the File node carries the connector's projector + dataset.
    const fileId = nodeId('File', '/repo/auth.py')
    const res = await executeQuerySql({
      query: `SELECT node_type, label, source_dataset, projector FROM node WHERE node_id = '${fileId}'`,
      registry,
      storage,
      refresh: 'always',
    })
    assert.equal(res.rows.length, 1)
    assert.equal(res.rows[0].node_type, 'File')
    assert.equal(res.rows[0].label, 'auth.py')
    assert.equal(res.rows[0].source_dataset, 'ai_gateway_messages')
    assert.equal(res.rows[0].projector, 'ai-gateway.t0')
  })
})

test('projectGraph excludes retained Claude aux rows from the graph', async () => {
  // The gateway now retains harness aux exchanges (tagged
  // attributes.claude.aux_kind) instead of dropping them (LLP 0026). They
  // must not mint graph nodes/edges. Seed the same two real rows plus one
  // aux row whose keys are all distinct — counts must stay 5/4.
  await withSeededGateway(async ({ registry, storage }) => {
    const contract = createAiGatewayGraphContract({ nodeId, edgeId, makeRowBuilders, keys })
    const r = await projectGraph({ query: registry, storage, contracts: [contract] })
    assert.equal(r.nodes, 5, 'aux row mints no extra node')
    assert.equal(r.edges, 4, 'aux row mints no extra edge')

    const auxNode = await executeQuerySql({
      query: `SELECT node_id FROM node WHERE natural_key = 'sess-aux'`,
      registry,
      storage,
      refresh: 'always',
    })
    assert.equal(auxNode.rows.length, 0, 'aux-tagged traffic mints no graph node')
  }, [...ROWS, AUX_ROW])
})

test('projectGraph with no contracts writes nothing', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const r = await projectGraph({ query: registry, storage, contracts: [] })
    assert.deepEqual(r, { nodes: 0, edges: 0, nodesWritten: 0, edgesWritten: 0 })
  })
})

/**
 * A minimal one-Session-node contract at a given projector version, over the
 * same seeded `ai_gateway_messages`. Used to prove that `projector_version` is
 * provenance, not a re-projection trigger (LLP 0023 §inline-provenance).
 * @param {number} version
 * @returns {Contract}
 */
function sessionContract(version) {
  const { buildNode } = makeRowBuilders({ sourceDataset: 'ai_gateway_messages', projector: 'ai-gateway.t0', projectorVersion: version })
  return {
    name: 'session-only',
    plugin: '@test/session',
    sourceDataset: 'ai_gateway_messages',
    projector: 'ai-gateway.t0',
    projectorVersion: version,
    rules: [
      {
        kind: 'node',
        type: 'Session',
        sql: 'SELECT session_id, message_created_at FROM ai_gateway_messages',
        toRow(r) {
          const key = r.session_id
          if (typeof key !== 'string') return null
          return buildNode({ type: 'Session', key, firstSeen: r.message_created_at, sourceKeys: { session_id: key } })
        },
      },
    ],
  }
}

test('bumping projectorVersion does not re-project — committed rows keep their original version', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const v1 = await projectGraph({ query: registry, storage, contracts: [sessionContract(1)] })
    assert.equal(v1.nodesWritten, 1, 'one Session node committed at v1')

    // Same source, same content-addressed ids, projectorVersion bumped to 2.
    const v2 = await projectGraph({ query: registry, storage, contracts: [sessionContract(2)] })
    assert.equal(v2.nodesWritten, 0, 'a version bump alone rewrites nothing — pre-write dedup skips the committed id')

    // Exactly one Session row survives, still stamped v1: bumping the version
    // did not re-derive it. (Asserting on the single Session row rather than by
    // node_id keeps the check independent of how the SQL engine compares the
    // hex id literal.)
    const res = await executeQuerySql({
      query: `SELECT natural_key, projector_version FROM node WHERE node_type = 'Session'`,
      registry,
      storage,
      refresh: 'always',
    })
    assert.equal(res.rows.length, 1, 'still exactly one Session row')
    assert.equal(res.rows[0].natural_key, 'sess-1')
    assert.equal(Number(res.rows[0].projector_version), 1, 'the committed row keeps its first-sighting version, not the bumped one')
  })
})
