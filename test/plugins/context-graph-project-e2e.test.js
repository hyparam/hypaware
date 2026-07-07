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
import { queryNeighbors } from '../../hypaware-core/plugins-workspace/context-graph/src/query.js'
import { createAiGatewayGraphContract } from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js'

/**
 * @import { Contract } from '../../hypaware-core/plugins-workspace/context-graph/src/types.js'
 */

// End-to-end: a contributed contract, run by the engine, over a real seeded
// `ai_gateway_messages` dataset. Proves Task 2 (engine iterates contracts),
// Task 3 (the connector's contract), and Task 1 (the kit) together, and is the
// automated regression that the relocation changed nothing observable.

// @ref LLP 0030#decision: the ai-gateway contract keys the Session on
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
  // Read by the Claude Skill rules' strict filters (LLP 0074): only
  // role='user' text parts with a leading anchor can mint a Skill/ran pair.
  { name: 'role', type: 'STRING', nullable: true },
  { name: 'content_text', type: 'STRING', nullable: true },
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
    role: 'user', content_text: 'hello',
    message_created_at: '2026-06-01T00:00:00.000Z', attributes: '{"dev_run_id":"run-1"}',
  },
  {
    session_id: 'sess-1', conversation_id: null, cwd: null, git_branch: null, client_name: 'claude-code',
    user_id: null, model: 'sonnet', tool_name: 'Read', tool_args: '{"file_path":"/repo/auth.py"}',
    part_type: 'tool_call', role: 'assistant', content_text: null,
    message_created_at: '2026-06-01T00:01:00.000Z', attributes: null,
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
  part_type: 'tool_call', role: 'assistant', content_text: null,
  message_created_at: '2026-06-01T00:02:00.000Z',
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

test('projectGraph excludes retained Claude aux rows from the graph', async () => {
  // The gateway now retains harness aux exchanges (tagged
  // attributes.claude.aux_kind) instead of dropping them (LLP 0026). They
  // must not mint graph nodes/edges. Seed the same two real rows plus one
  // aux row whose keys are all distinct. Counts must stay 5/4.
  await withSeededGateway(async ({ registry, storage }) => {
    const contract = createAiGatewayGraphContract({ nodeId, edgeId, makeRowBuilders })
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

test('bumping projectorVersion does not re-project: committed rows keep their original version', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const v1 = await projectGraph({ query: registry, storage, contracts: [sessionContract(1)] })
    assert.equal(v1.nodesWritten, 1, 'one Session node committed at v1')

    // Same source, same content-addressed ids, projectorVersion bumped to 2.
    const v2 = await projectGraph({ query: registry, storage, contracts: [sessionContract(2)] })
    assert.equal(v2.nodesWritten, 0, 'a version bump alone rewrites nothing - pre-write dedup skips the committed id')

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

// --- LLP 0073/0079 (issues #229/#230): Skill/Program end-to-end + query proof ---
//
// A fixture spanning all four Skill activation surfaces plus both Program
// source tools, across three sessions/two clients, run through the REAL
// engine (not the per-rule unit tests in ai-gateway-graph-contract.test.js):
//
//   sess-alpha (claude-code/sonnet): the `Skill` tool call (surface 1,
//     dispatch_tool) for `hypaware-query`; a `Bash` call whose program is `git`.
//   sess-beta  (codex/gpt-5-codex):  the Codex exec_command SKILL.md read
//     (surface 4, dispatch_shell_read) for the SAME `hypaware-query` skill -
//     cross-client convergence onto one Skill node - plus a second
//     exec_command whose program is `cat` (the SKILL.md read itself) and a
//     third whose program is `git` (converging with sess-alpha's Program node).
//   sess-gamma (claude-code/sonnet): the slash tag (surface 3) AND the marker
//     (surface 2) for `hypaware-ai-improvement-report`, in one session - the
//     mergeRow dispatch-flag union under test.
//
// @ref LLP 0073#node-edge-declarations [tests]: Skill/Program nodes and
// ran/invoked edges materialize through projectGraph, not just per-rule toRow.
const SKILL_PROGRAM_ROWS = [
  // sess-alpha, surface 1: the model chose the `Skill` tool.
  {
    session_id: 'sess-alpha', conversation_id: null, cwd: '/repo', git_branch: 'main', client_name: 'claude-code',
    user_id: 'u1', model: 'sonnet', tool_name: 'Skill', tool_args: JSON.stringify({ skill: 'hypaware-query' }),
    part_type: 'tool_call', role: 'assistant', content_text: null,
    message_created_at: '2026-06-03T00:00:00.000Z', attributes: null,
  },
  // sess-alpha: a Bash call whose program facet is `git`.
  {
    session_id: 'sess-alpha', conversation_id: null, cwd: '/repo', git_branch: 'main', client_name: 'claude-code',
    user_id: 'u1', model: 'sonnet', tool_name: 'Bash', tool_args: JSON.stringify({ command: 'git status' }),
    part_type: 'tool_call', role: 'assistant', content_text: null,
    message_created_at: '2026-06-03T00:01:00.000Z', attributes: null,
  },
  // sess-beta, surface 4: Codex's own signal - an exec_command shell read of
  // `.codex/skills/hypaware-query/SKILL.md`. Also mints a Program node (`cat`)
  // from the SAME row: the path-pattern Skill rule and the Program rule read
  // independently off one source row, so a skill-activation read is ALSO a
  // program invocation - a real, expected double derivation, not a bug.
  {
    session_id: 'sess-beta', conversation_id: null, cwd: '/repo2', git_branch: 'main', client_name: 'codex',
    user_id: 'u2', model: 'gpt-5-codex', tool_name: 'exec_command',
    tool_args: JSON.stringify({ cmd: 'cat /home/u/.codex/skills/hypaware-query/SKILL.md' }),
    part_type: 'tool_call', role: 'assistant', content_text: null,
    message_created_at: '2026-06-03T00:02:00.000Z', attributes: null,
  },
  // sess-beta: a second exec_command whose program facet is `git`, converging
  // with sess-alpha's Program node (a different session, so a distinct edge).
  {
    session_id: 'sess-beta', conversation_id: null, cwd: '/repo2', git_branch: 'main', client_name: 'codex',
    user_id: 'u2', model: 'gpt-5-codex', tool_name: 'exec_command', tool_args: JSON.stringify({ cmd: 'git commit -m wip' }),
    part_type: 'tool_call', role: 'assistant', content_text: null,
    message_created_at: '2026-06-03T00:03:00.000Z', attributes: null,
  },
  // sess-gamma, surface 3: the user-typed slash command.
  {
    session_id: 'sess-gamma', conversation_id: null, cwd: '/repo', git_branch: 'main', client_name: 'claude-code',
    user_id: 'u1', model: 'sonnet', tool_name: null, tool_args: null,
    part_type: 'text', role: 'user', content_text: '<command-name>/hypaware-ai-improvement-report</command-name>',
    message_created_at: '2026-06-03T00:04:00.000Z', attributes: null,
  },
  // sess-gamma, surface 2: the SKILL.md injection marker for the SAME skill -
  // the mergeRow union case (LLP 0078): one `ran` edge, both dispatch flags.
  {
    session_id: 'sess-gamma', conversation_id: null, cwd: '/repo', git_branch: 'main', client_name: 'claude-code',
    user_id: 'u1', model: 'sonnet', tool_name: null, tool_args: null,
    part_type: 'text', role: 'user',
    content_text: 'Base directory for this skill: /home/u/.claude/skills/hypaware-ai-improvement-report',
    message_created_at: '2026-06-03T00:05:00.000Z', attributes: null,
  },
]

/**
 * A JSON-typed column's value: assert it whether the query/storage layer
 * hands it back parsed or still as a JSON string (the same "may arrive
 * parsed or as a string" duality every JSON column in this codebase has).
 * @param {unknown} value
 * @returns {unknown}
 */
function parseJsonColumn(value) {
  if (typeof value !== 'string') return value
  return JSON.parse(value)
}

/**
 * @param {Awaited<ReturnType<typeof queryNeighbors>>} r
 * @returns {any}
 */
function okTraversal(r) {
  assert.equal(r.ok, true, r.ok ? '' : `expected ok, got error: ${r.error}`)
  return r
}

test('projectGraph mints Skill/Program nodes and ran/invoked edges from all activation surfaces (#229/#230), and is idempotent', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const contract = createAiGatewayGraphContract({ nodeId, edgeId, makeRowBuilders })

    const first = await projectGraph({ query: registry, storage, contracts: [contract] })
    // 3 Session (alpha/beta/gamma) + 2 App (claude-code/codex) + 2 Model
    // (sonnet/gpt-5-codex) + 3 Tool (Skill/Bash/exec_command) + 2 Program
    // (git/cat) + 2 Skill (hypaware-query/hypaware-ai-improvement-report).
    // No File/Repo/Commit: no file-touching tools, no captured
    // git_remote/head_sha in this fixture.
    assert.equal(first.nodes, 14)
    // 3 via + 3 used_model + 3 used (Tool) + 3 invoked (Program) + 3 ran
    // (Skill). No touched/in/at: same reason as above.
    assert.equal(first.edges, 15)
    assert.equal(first.nodesWritten, 14)
    assert.equal(first.edgesWritten, 15)

    const again = await projectGraph({ query: registry, storage, contracts: [contract] })
    assert.equal(again.nodesWritten, 0, 're-projecting the identical fixture is idempotent')
    assert.equal(again.edgesWritten, 0)
  }, SKILL_PROGRAM_ROWS)
})

// @ref LLP 0078#decision [tests]: dispatch flags union order-independently
// through the ENGINE's mergeRow (not just the per-rule toRow props checked in
// ai-gateway-graph-contract.test.js) - two different source rows, same
// (session, skill) pair, collapse onto one edge id and both flags survive.
test('a session sighted via both the marker and slash surfaces merges onto one ran edge with both dispatch flags', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const contract = createAiGatewayGraphContract({ nodeId, edgeId, makeRowBuilders })
    await projectGraph({ query: registry, storage, contracts: [contract] })

    const src = nodeId('Session', 'sess-gamma')
    const dst = nodeId('Skill', 'hypaware-ai-improvement-report')
    const id = edgeId(src, 'ran', dst)

    const res = await executeQuerySql({
      query: `SELECT props FROM edge WHERE edge_id = '${id}'`,
      registry,
      storage,
      refresh: 'always',
    })
    assert.equal(res.rows.length, 1, 'the marker and slash sightings collapse onto one edge id')
    assert.deepEqual(
      parseJsonColumn(res.rows[0].props),
      { dispatch_marker: true, dispatch_slash: true },
      'mergeRow unions both surfaces\' flags onto the one edge'
    )
  }, SKILL_PROGRAM_ROWS)
})

// @ref LLP 0073#query-surface [tests]: issue #229's headline "sessions per
// skill" ranking, run unchanged over the node/edge datasets.
test('issue #229 headline SQL: sessions-per-skill ranking', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const contract = createAiGatewayGraphContract({ nodeId, edgeId, makeRowBuilders })
    await projectGraph({ query: registry, storage, contracts: [contract] })

    const res = await executeQuerySql({
      query: `select s.label skill, count(distinct e.src_id) sessions
        from edge e join node s on s.node_id = e.dst_id
        where e.edge_type = 'ran' group by s.label order by sessions desc`,
      registry,
      storage,
      refresh: 'always',
    })
    assert.deepEqual(res.rows.map((r) => [r.skill, Number(r.sessions)]), [
      ['hypaware-query', 2],
      ['hypaware-ai-improvement-report', 1],
    ])
  }, SKILL_PROGRAM_ROWS)
})

// @ref LLP 0073#query-surface [tests]: issue #230's headline "which sessions
// ran <program>" lookup, run unchanged over the node/edge datasets.
test('issue #230 headline SQL: which sessions ran the `git` program', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const contract = createAiGatewayGraphContract({ nodeId, edgeId, makeRowBuilders })
    await projectGraph({ query: registry, storage, contracts: [contract] })

    const res = await executeQuerySql({
      query: `select json_extract(e.source_keys,'$.session_id') session_id
        from edge e join node p on p.node_id = e.dst_id
        where e.edge_type = 'invoked' and p.natural_key = 'git'`,
      registry,
      storage,
      refresh: 'always',
    })
    assert.deepEqual(new Set(res.rows.map((r) => r.session_id)), new Set(['sess-alpha', 'sess-beta']))
  }, SKILL_PROGRAM_ROWS)
})

// @ref LLP 0073#query-surface [tests]: `hyp graph neighbors` is type-agnostic
// (no CLI change) - `--edge-type ran`/`--edge-type invoked` reach the new
// node types as soon as the rows exist. `--type` narrows the SEED match
// (LLP 0064#seed-resolution), so it disambiguates a skill-name seed here,
// not the destination type of a session seed.
test('graph neighbors traversal: --edge-type ran reaches Skill, --edge-type invoked reaches Program', async () => {
  await withSeededGateway(async ({ registry, storage }) => {
    const contract = createAiGatewayGraphContract({ nodeId, edgeId, makeRowBuilders })
    await projectGraph({ query: registry, storage, contracts: [contract] })

    // Out from a session, over `ran`: the Skill it ran.
    const ranOut = okTraversal(await queryNeighbors({ query: registry, storage, seed: 'sess-alpha', edgeTypes: ['ran'], direction: 'out' }))
    assert.deepEqual(ranOut.neighbors.map((n) => [n.node.node_type, n.node.natural_key]), [['Skill', 'hypaware-query']])

    // In from the Skill (seeded by name, `--type Skill` disambiguating the
    // seed), over `ran`: the sessions that ran it - both clients converge.
    const ranIn = okTraversal(await queryNeighbors({ query: registry, storage, seed: 'hypaware-query', type: 'Skill', edgeTypes: ['ran'], direction: 'in' }))
    assert.deepEqual(new Set(ranIn.neighbors.map((n) => n.node.natural_key)), new Set(['sess-alpha', 'sess-beta']))

    // Out from a session, over `invoked`: the Programs it ran.
    const invokedOut = okTraversal(await queryNeighbors({ query: registry, storage, seed: 'sess-beta', edgeTypes: ['invoked'], direction: 'out' }))
    assert.deepEqual(
      new Set(invokedOut.neighbors.map((n) => `${n.node.node_type}:${n.node.natural_key}`)),
      new Set(['Program:git', 'Program:cat'])
    )
  }, SKILL_PROGRAM_ROWS)
})
