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
import { edgeId, makeRowBuilders, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import { graphDatasetRegistration } from '../../hypaware-core/plugins-workspace/context-graph/src/datasets.js'
import { projectGraph } from '../../hypaware-core/plugins-workspace/context-graph/src/project.js'
import { createAiGatewayGraphContract } from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js'

// End-to-end: a contributed contract, run by the engine, over a real seeded
// `ai_gateway_messages` dataset. Proves Task 2 (engine iterates contracts),
// Task 3 (the connector's contract), and Task 1 (the kit) together, and is the
// automated regression that the relocation changed nothing observable.

/** Only the columns the ai-gateway contract reads (a subset of the full schema). */
const COLUMNS = /** @type {const} */ ([
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
])

const ROWS = [
  {
    conversation_id: 'conv-1', cwd: '/repo', git_branch: 'main', client_name: 'claude-code',
    user_id: 'u1', model: 'sonnet', tool_name: null, tool_args: null, part_type: 'text',
    message_created_at: '2026-06-01T00:00:00.000Z',
  },
  {
    conversation_id: 'conv-1', cwd: null, git_branch: null, client_name: 'claude-code',
    user_id: null, model: 'sonnet', tool_name: 'Read', tool_args: '{"file_path":"/repo/auth.py"}',
    part_type: 'tool_call', message_created_at: '2026-06-01T00:01:00.000Z',
  },
]

/**
 * @param {(deps: { registry: any, storage: any }) => Promise<void>} body
 */
async function withSeededGateway(body) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-e2e-'))
  try {
    const registry = createQueryRegistry()
    registry.registerDataset(aiGatewayDatasetRegistration())
    registry.registerDataset(graphDatasetRegistration('node'))
    registry.registerDataset(graphDatasetRegistration('edge'))
    await appendRowsToSourceTable(cacheRoot, DATASET_NAME, ['source=claude'], [...COLUMNS], ROWS)
    const storage = createQueryStorageService({ cacheRoot })
    await body({ registry, storage })
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
}

test('projectGraph runs a contributed contract end to end and is idempotent', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const contract = createAiGatewayGraphContract({ nodeId, edgeId, makeRowBuilders })

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

test('projectGraph with no contracts writes nothing', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const r = await projectGraph({ query: registry, storage, contracts: [] })
    assert.deepEqual(r, { nodes: 0, edges: 0, nodesWritten: 0, edgesWritten: 0 })
  })
})
