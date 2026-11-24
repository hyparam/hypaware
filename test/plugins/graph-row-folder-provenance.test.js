// @ts-check

// LLP 0616: graph rows carry the folders that contributed to them, and the
// query seam shows a row's content only when every one of those folders is
// one the caller may see. End to end over a real cache: the projection
// writes `source_cwds`, the shared visibility filter reads it, and rows that
// cannot say where they came from stay suppressed.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'

import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { executeQuerySql } from '../../src/core/query/sql.js'
import { renderLocalOnlyNotice } from '../../src/core/query/verb.js'
import { parseSourceCwds } from '../../src/core/query/visibility.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'
import { writeLocalOnlyDirs } from '../../src/core/usage-policy/local_only.js'
import { aiGatewayDatasetRegistration, AI_GATEWAY_SCHEMA_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayGraphContract } from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js'
import * as kit from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import { graphDatasetRegistration } from '../../hypaware-core/plugins-workspace/context-graph/src/datasets.js'
import { mergeRow, projectGraph } from '../../hypaware-core/plugins-workspace/context-graph/src/project.js'
import { graphNeighborsVerb } from '../../hypaware-core/plugins-workspace/context-graph/src/verb.js'
import { enrichDatasetRegistration, enrichTablePath, COMMITTED_COLUMNS } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/datasets.js'
import { withLogRecords } from '../helpers/log_records.js'

/**
 * @import { ExecuteSqlOptions } from '../../src/core/query/types.js'
 * @import { Contract } from '../../hypaware-core/plugins-workspace/context-graph/src/types.js'
 */

const AT = '2026-11-01T00:00:00.000Z'

/**
 * One source message. `folder` names a fixture folder, resolved to a real
 * directory under the temp root.
 *
 * @param {string} session
 * @param {string} folder
 * @param {Record<string, unknown>} [extra]
 */
function message(session, folder, extra = {}) {
  return {
    session_id: session, message_id: `${session}-${Object.keys(extra).join('-') || 'text'}`, part_id: `${session}-p`,
    cwd: folder, client_name: 'claude-code', model: null, tool_name: null, tool_args: null,
    part_type: 'text', role: 'user', content_text: 'hi', message_created_at: AT, attributes: null, ...extra,
  }
}

/** Two sessions, one per folder, sharing an App and one Model. */
const MESSAGES = [
  message('sess-shared', 'shared', { model: 'model-shared' }),
  message('sess-shared', 'shared', { model: 'model-both' }),
  message('sess-private', 'private', { model: 'model-private' }),
  message('sess-private', 'private', { model: 'model-both' }),
]

/**
 * A temp HYP_HOME with the gateway, graph and enrichment datasets registered.
 * `dirs` are real folders, so the default resolver classifies them from the
 * machine-local list beside the cache, exactly as `hyp` does.
 *
 * @param {(ctx: any) => Promise<void>} body
 * @param {{ partitions?: Record<string, Record<string, unknown>[]> }} [opts]
 */
async function fixture(body, opts = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-folders-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const dirs = {
      shared: path.join(root, 'work', 'shared'),
      private: path.join(root, 'work', 'private'),
      caller: path.join(root, 'work', 'caller'),
      ignored: path.join(root, 'work', 'ignored'),
    }
    for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dirs.ignored, '.hypignore'), '')
    const registry = createQueryRegistry()
    registry.registerDataset(aiGatewayDatasetRegistration())
    registry.registerDataset(graphDatasetRegistration('node'))
    registry.registerDataset(graphDatasetRegistration('edge'))
    registry.registerDataset(enrichDatasetRegistration('enrichment_committed', 'committed_at'))
    for (const [partition, rows] of Object.entries(opts.partitions ?? { claude: MESSAGES })) {
      const resolved = rows.map((row) => ({ ...row, cwd: dirs[/** @type {keyof typeof dirs} */ (row.cwd)] ?? row.cwd }))
      const columns = AI_GATEWAY_SCHEMA_COLUMNS.filter((c) => Object.hasOwn(resolved[0], c.name))
      await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', [`source=${partition}`], [...columns], resolved)
    }
    const storage = createQueryStorageService({ cacheRoot })
    /**
     * @param {string} query
     * @param {Partial<ExecuteSqlOptions>} [extra]
     */
    const sql = (query, extra = {}) => executeQuerySql({ query, registry, storage, refresh: 'always', callerCwd: dirs.caller, ...extra })
    const markPrivate = () => writeLocalOnlyDirs({ stateDir: root, dirs: [dirs.private] })
    await body({ root, cacheRoot, dirs, registry, storage, sql, markPrivate })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

const contract = () => createAiGatewayGraphContract(kit)

/** @param {Record<string, unknown>[]} rows */
const byKey = (rows) => Object.fromEntries(rows.map((row) => [`${row.node_type}:${row.natural_key ?? row.node_id}`, row]))

const NODES = 'SELECT node_id, node_type, natural_key, label, source_cwds FROM node ORDER BY node_id'
const EDGES = 'SELECT edge_id, edge_type, src_id, source_keys, source_cwds FROM edge ORDER BY edge_id'

// @ref LLP 0616#tests [tests]: 1. names show on a machine with no local-only folder; 2. a local-only folder's node stays hidden without leaking the folder; 3. a mixed node stays hidden; 7. reclassification hides on the next query
test('projected rows show names until a contributing folder turns local-only, and never leak it', async () => {
  await fixture(async ({ dirs, registry, storage, sql, markPrivate }) => {
    await projectGraph({ query: registry, storage, contracts: [contract()] })

    // 1. No folder is local-only: every node and edge reads its content.
    const nodes = await sql(NODES)
    assert.ok(nodes.rows.length >= 6, 'two Sessions, an App and three Models at least')
    assert.ok(nodes.rows.every((row) => typeof row.natural_key === 'string'), 'every node names itself')
    assert.equal(nodes.localOnly.filtered, true, 'the synced caller is still filtered')
    assert.equal(nodes.localOnly.suppressedRows, 0)
    const edges = await sql(EDGES)
    assert.ok(edges.rows.length > 0)
    assert.ok(edges.rows.every((row) => row.source_keys !== null), 'every edge keeps its content')
    assert.equal(edges.localOnly.suppressedRows, 0)
    const named = byKey(nodes.rows)
    assert.equal(named['Model:model-shared'].source_cwds, JSON.stringify([dirs.shared]))
    assert.equal(named['Model:model-both'].source_cwds, JSON.stringify([dirs.private, dirs.shared].sort()), 'the union, sorted')

    // 7. The private folder turns local-only after projection: no rewrite, the next query hides it.
    await markPrivate()
    const after = await sql(NODES)
    const hidden = Object.fromEntries(after.rows.map((row) => [row.node_id, row]))
    /** @param {string} type @param {string} key */
    const row = (type, key) => hidden[kit.nodeId(type, key)]
    assert.equal(row('Session', 'sess-shared').natural_key, 'sess-shared')
    assert.equal(row('Model', 'model-shared').label, 'model-shared')
    // 2. A node only the local-only folder contributed to.
    assert.equal(row('Session', 'sess-private').natural_key, null)
    assert.equal(row('Model', 'model-private').label, null)
    // 3. Mixed nodes: the local-only folder outranks the syncing one.
    assert.equal(row('Model', 'model-both').natural_key, null)
    assert.equal(row('App', 'claude-code').label, null)
    for (const r of [row('Session', 'sess-private'), row('Model', 'model-both')]) {
      assert.equal(r.source_cwds, null, 'source_cwds is content too')
      assert.equal(r.node_type === 'Session' || r.node_type === 'Model', true, 'structure stays visible')
    }
    assert.equal(after.rows.length, nodes.rows.length, 'suppression is not withholding')
    assert.ok(!JSON.stringify(after.rows).includes(dirs.private), 'no column names the local-only folder')
    assert.equal(after.localOnly.unprovenancedRows, 0, 'every hidden row has recorded provenance')
    assert.ok(after.localOnly.suppressedRows >= 4)
    assert.match(renderLocalOnlyNotice(after.localOnly), /row\(s\) drawn from a local-only folder/)
    assert.doesNotMatch(renderLocalOnlyNotice(after.localOnly), /no recorded provenance/)

    const privateEdges = (await sql(EDGES)).rows.filter((r) => r.src_id === kit.nodeId('Session', 'sess-private'))
    assert.ok(privateEdges.length > 0)
    assert.ok(privateEdges.every((r) => r.source_keys === null && r.source_cwds === null), 'edges a local-only folder wrote stay hidden')

    // A caller inside the local-only folder ranks with it and sees the mixed rows.
    const inside = byKey((await sql(NODES, { callerCwd: dirs.private })).rows)
    assert.equal(inside['Model:model-both'].label, 'model-both')
    assert.equal(inside['Model:model-both'].source_cwds, JSON.stringify([dirs.private, dirs.shared].sort()))
  })
})

// @ref LLP 0616#tests [tests]: 5. a caller at ignore or with --include-local-only is unchanged, the wrapper skipped
test('--include-local-only and an ignore-classed caller read every row unfiltered', async () => {
  await fixture(async ({ dirs, registry, storage, sql, markPrivate }) => {
    await projectGraph({ query: registry, storage, contracts: [contract()] })
    const before = await sql(NODES, { includeLocalOnly: true })
    await markPrivate()
    for (const extra of [{ includeLocalOnly: true }, { callerCwd: dirs.ignored }]) {
      const open = await sql(NODES, extra)
      assert.deepEqual(open.rows, before.rows, JSON.stringify(Object.keys(extra)))
      assert.equal(open.localOnly.filtered, false)
      assert.equal(open.localOnly.suppressedRows, 0)
      assert.ok(open.rows.every((row) => typeof row.natural_key === 'string'))
    }
  })
})

// @ref LLP 0616#tests [tests]: 6. an unknown contribution (a raw-SQL rule without cwd, an enrichment_committed-derived row) stays hidden and absorbs on merge
test('an unknown contribution stays suppressed and absorbs every folder it merges with', async () => {
  // A raw-SQL rule that leaves cwd out names model-shared, which the gateway
  // contract also names from a syncing folder.
  const builders = kit.makeRowBuilders({ sourceDataset: 'ai_gateway_messages', projector: 'probe.t0', projectorVersion: 1 })
  /** @type {Contract} */
  const blind = {
    name: 'probe-blind', plugin: '@test/probe', sourceDataset: 'ai_gateway_messages', projector: 'probe.t0', projectorVersion: 1,
    rules: [{
      kind: 'node', type: 'Model', sql: "SELECT model, message_created_at FROM ai_gateway_messages WHERE model = 'model-shared'",
      toRow: (r) => builders.buildNode({ type: 'Model', key: String(r.model), label: String(r.model), firstSeen: r.message_created_at, sourceKeys: { model: r.model } }),
    }],
  }
  /** @type {Contract} */
  const sighted = { ...blind, name: 'probe-sighted', rules: [{ ...blind.rules[0], type: 'Program', sql: "SELECT cwd, model, message_created_at FROM ai_gateway_messages WHERE model = 'model-shared'",
    toRow: (r) => builders.buildNode({ type: 'Program', key: String(r.model), label: String(r.model), firstSeen: r.message_created_at, sourceKeys: { model: r.model } }) }] }
  await fixture(async ({ dirs, registry, storage, sql }) => {
    await projectGraph({ query: registry, storage, contracts: [contract(), blind, sighted] })
    const open = byKey((await sql(NODES, { includeLocalOnly: true })).rows)
    assert.equal(open['Model:model-shared'].source_cwds, null, 'unknown absorbed the syncing folder')
    assert.equal(open['Program:model-shared'].source_cwds, JSON.stringify([dirs.shared]), 'a raw rule that selects cwd records it')
    const synced = await sql(NODES)
    const rows = byKey(synced.rows)
    assert.equal(rows[`Model:${kit.nodeId('Model', 'model-shared')}`]?.label ?? null, null)
    assert.equal(synced.rows.find((r) => r.node_id === kit.nodeId('Model', 'model-shared'))?.label, null, 'no machine has a local-only folder, yet it stays hidden')
    assert.equal(rows['Program:model-shared'].label, 'model-shared')
    assert.equal(rows['Model:model-private'].label, 'model-private', 'unrelated rows are untouched')
    assert.equal(synced.localOnly.unprovenancedRows, 1)
  })

  // A row derived from enrichment_committed, whose own content is suppressed raw.
  await fixture(async ({ registry, storage, sql }) => {
    await storage.appendRows(enrichTablePath(storage, 'enrichment_committed'), [...COMMITTED_COLUMNS], [{
      item_id: 'item-1', item_type: 'Decision', label: 'model-shared', props: null, confidence: 1, anchor_type: 'Session', anchor_key: 'sess-shared',
      source_dataset: 'ai_gateway_messages', source_keys: { session_id: 'sess-shared' }, curator: 'test', curator_version: 1, committed_at: AT,
    }])
    const enrichBuilders = kit.makeRowBuilders({ sourceDataset: 'enrichment_committed', projector: 'enrich.t1', projectorVersion: 1 })
    /** @type {Contract} */
    const enrichment = {
      name: 'probe-enrich', plugin: '@test/probe', sourceDataset: 'enrichment_committed', projector: 'enrich.t1', projectorVersion: 1,
      rules: [{
        kind: 'node', type: 'Model', columns: ['label', 'committed_at'],
        toRow: (r) => enrichBuilders.buildNode({ type: 'Model', key: String(r.label), label: String(r.label), firstSeen: r.committed_at, sourceKeys: { item_id: 'item-1' } }),
      }],
    }
    await projectGraph({ query: registry, storage, contracts: [contract(), enrichment] })
    const synced = await sql(NODES)
    assert.equal(synced.rows.find((r) => r.node_id === kit.nodeId('Model', 'model-shared'))?.label, null)
    assert.equal(synced.rows.find((r) => r.node_id === kit.nodeId('Model', 'model-private'))?.label, 'model-private')
    assert.equal(synced.localOnly.unprovenancedRows, 1)
  })
})

// @ref LLP 0616#merge [tests]: the union is commutative and idempotent, unknown absorbs, and no merge removes a folder
test('mergeRow unions source_cwds in any order, and unknown absorbs', () => {
  const values = [null, undefined, '[]', '["/a"]', '["/b"]', '["/a","/c"]', 'not json']
  /** @param {unknown} source_cwds */
  const row = (source_cwds) => ({ node_id: 'n', node_type: 'Tool', natural_key: 'k', source_dataset: 'd', source_keys: {}, projector: 'p', projector_version: 1, source_cwds })
  // An unreadable value is unknown wherever it is read, so compare as the read path does.
  /** @param {unknown[]} order */
  const fold = (order) => {
    const merged = row(order[0])
    for (const value of order.slice(1)) mergeRow(merged, row(value))
    return parseSourceCwds(merged.source_cwds) === null ? null : merged.source_cwds
  }
  for (const a of values) {
    for (const b of values) {
      assert.equal(fold([a, b]), fold([b, a]), `commutative: ${a} ${b}`)
      assert.equal(fold([a, b, b]), fold([a, b]), `idempotent: ${a} ${b}`)
      const unknown = [a, b].some((v) => v === null || v === undefined || v === 'not json')
      if (unknown) assert.equal(fold([a, b]), null, `unknown absorbs: ${a} ${b}`)
    }
  }
  assert.equal(fold(['["/b"]', '["/a","/c"]', '[]', '["/a"]']), '["/a","/b","/c"]')
  assert.equal(fold(['["/a","/c"]', '["/b"]', '["/a"]', '[]']), '["/a","/b","/c"]')
  assert.equal(fold(['["/a","/c"]', '["/a"]']), '["/a","/c"]', 'a merge never drops a folder')
})

/**
 * The storage service as it wrote graph rows before this change: the same
 * tables, without the provenance column.
 *
 * @param {any} storage
 */
function preChangeWriter(storage) {
  return {
    ...storage,
    /** @param {string} tablePath @param {any[]} columns @param {Record<string, unknown>[]} rows */
    appendRows: (tablePath, columns, rows) => storage.appendRows(tablePath,
      columns.filter((column) => column.name !== 'source_cwds'),
      rows.map(({ source_cwds: _dropped, ...row }) => row)),
  }
}

// @ref LLP 0616#old-rows [tests]: 4. rows written before the change stay hidden; a refresh re-derives only rows whose sources are present
test('pre-change rows stay hidden, and a refresh re-derives only those whose sources remain', async () => {
  const partitions = { keep: [message('sess-keep', 'shared', { model: 'model-keep' })], gone: [message('sess-gone', 'shared', { model: 'model-gone' })] }
  await fixture(async ({ dirs, cacheRoot, registry, storage, sql }) => {
    await projectGraph({ query: registry, storage: preChangeWriter(storage), contracts: [contract()] })
    // Retention or a purge removes sess-gone's messages after its rows were written.
    await fs.rm(path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=gone'), { recursive: true, force: true })

    const { result: before, records } = await withLogRecords(() => sql(NODES.replace(', source_cwds', '')))
    assert.ok(before.rows.length >= 4)
    assert.ok(before.rows.every((row) => row.natural_key === null), 'every pre-change row stays suppressed')
    assert.equal(before.localOnly.unprovenancedRows, before.rows.length, 'and is counted as having no recorded provenance')
    assert.equal(before.localOnly.suppressedRows, before.rows.length)
    assert.match(renderLocalOnlyNotice(before.localOnly), /no recorded provenance \(for graph rows, `hyp graph project --refresh`/)
    assert.doesNotMatch(renderLocalOnlyNotice(before.localOnly), /drawn from a local-only folder/)
    const withhold = records.find((r) => r.body === 'usage_policy.query_withhold')
    assert.ok(withhold, 'the withhold is logged')
    assert.equal(withhold.attributes.unprovenanced_row_count, before.localOnly.unprovenancedRows)
    assert.equal(withhold.attributes.suppressed_row_count, before.localOnly.suppressedRows)
    assert.ok(!JSON.stringify(withhold.attributes).includes(dirs.shared), 'counts only, never paths')

    // The first thing after the upgrade is the refresh: the table has never seen the column.
    await projectGraph({ query: registry, storage, contracts: [contract()], refresh: true })
    const open = byKey((await sql(NODES, { includeLocalOnly: true })).rows)
    assert.equal(open['Session:sess-keep'].source_cwds, JSON.stringify([dirs.shared]), 're-derived rows carry their folders through the rewrite')
    assert.equal(open['Session:sess-gone'].source_cwds ?? null, null, 'a row whose messages are gone reads the column as null')
    assert.equal(open['Session:sess-gone'].natural_key, 'sess-gone', '--include-local-only still reads it')
    const after = await sql(NODES)
    /** @param {string} type @param {string} key */
    const node = (type, key) => after.rows.find((r) => r.node_id === kit.nodeId(type, key))
    assert.equal(node('Session', 'sess-keep')?.natural_key, 'sess-keep', 're-derived from its present messages')
    assert.equal(node('Model', 'model-keep')?.label, 'model-keep')
    assert.equal(node('App', 'claude-code')?.label, 'claude-code', 're-derived wholly from the messages still recorded')
    assert.equal(node('Session', 'sess-gone')?.natural_key, null, 'its messages are gone, so it stays null for good')
    assert.equal(node('Model', 'model-gone')?.label, null)
    assert.equal(after.localOnly.unprovenancedRows, 2)
  }, { partitions })
})

// LLP 0616 #old-rows reads old rows' new column as null through LLP 0029
// in-place evolution, but that evolution runs only for tables with a cache
// partition declaration, and the graph tables have none. Until that is
// decided, a default projection into a graph table written before the change
// drops source_cwds (rows stay suppressed, fail closed) until a --refresh.
test('rows projected after the upgrade into an existing graph table carry source_cwds', { todo: 'graph tables are not evolved in place (no partition declaration); reported, not decided here' }, async () => {
  const partitions = { keep: [message('sess-keep', 'shared', { model: 'model-keep' })] }
  await fixture(async ({ dirs, cacheRoot, registry, storage, sql }) => {
    await projectGraph({ query: registry, storage: preChangeWriter(storage), contracts: [contract()] })
    await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=keep'],
      [...AI_GATEWAY_SCHEMA_COLUMNS.filter((c) => Object.hasOwn(MESSAGES[0], c.name))],
      [{ ...message('sess-new', 'shared', { model: 'model-new' }), cwd: dirs.shared }])
    await projectGraph({ query: registry, storage, contracts: [contract()] })
    const stored = byKey((await sql(NODES, { includeLocalOnly: true })).rows)
    assert.equal(stored['Session:sess-keep'].source_cwds ?? null, null, 'an old row reads the new column as null')
    assert.equal(stored['Session:sess-new'].source_cwds, JSON.stringify([dirs.shared]))
  }, { partitions })
})

// @ref LLP 0616#tests [tests]: 8. the native batch path and the row path agree over a real cache
test('native graph scans agree with the row path over a projected cache', async () => {
  await fixture(async ({ registry, storage, markPrivate, dirs }) => {
    await projectGraph({ query: registry, storage, contracts: [contract()] })
    await markPrivate()
    let prepared = 0
    /** @param {'native' | 'row'} mode */
    const view = (mode) => ({
      ...registry,
      getDataset: (/** @type {string} */ name) => {
        const dataset = registry.getDataset(name)
        if (!dataset || (name !== 'node' && name !== 'edge')) return dataset
        return {
          ...dataset,
          createDataSource: async (/** @type {any} */ parts, /** @type {any} */ ctx) => {
            const source = await dataset.createDataSource(parts, ctx)
            if (mode === 'row') return { columns: source.columns, scan: (/** @type {any} */ options) => source.scan(options) }
            assert.ok(source.prepareScan, 'the projected graph is natively scannable')
            return {
              columns: source.columns,
              schema: source.schema,
              scan: (/** @type {any} */ options) => source.scan(options),
              prepareScan: (/** @type {any} */ request) => { prepared++; return /** @type {NonNullable<typeof source.prepareScan>} */ (source.prepareScan)(request) },
            }
          },
        }
      },
    })
    for (const query of [
      NODES,
      EDGES,
      "SELECT node_id, label FROM node WHERE natural_key = 'sess-private'",
      'SELECT node_type, COUNT(label) AS named, COUNT(*) AS n FROM node GROUP BY node_type ORDER BY node_type',
      'SELECT node_id FROM node WHERE label IS NULL ORDER BY node_id',
      'SELECT * FROM node ORDER BY node_id LIMIT 3 OFFSET 1',
    ]) {
      for (const callerCwd of [dirs.caller, dirs.private]) {
        /** @param {'native' | 'row'} mode */
        const read = (mode) => executeQuerySql({ query, registry: /** @type {any} */ (view(mode)), storage, refresh: 'always', callerCwd })
        const native = await read('native')
        const row = await read('row')
        assert.deepEqual(native.rows, row.rows, `${callerCwd}: ${query}`)
        assert.deepEqual([native.localOnly.suppressedRows, native.localOnly.unprovenancedRows],
          [row.localOnly.suppressedRows, row.localOnly.unprovenancedRows], `${callerCwd}: ${query}`)
      }
    }
    assert.ok(prepared > 0, 'the native path ran')
  })
})

// @ref LLP 0616#notice [tests]: the graph notice splits hidden-by-folder from no-provenance and names the refresh only for the latter
test('the graph notice splits folder-hidden rows from rows with no recorded provenance', () => {
  const failed = /** @type {any} */ ({ ok: false, error: 'no node matches "x"', localOnly: { callerClass: 'full', filtered: true, withheldRows: 0, suppressedRows: 5, unprovenancedRows: 2 } })
  const stderr = graphNeighborsVerb.render(failed, /** @type {any} */ ({ json: false, format: 'json', maxCell: 1000, maxBytes: 100000 })).stderr ?? ''
  assert.match(stderr, /3 row\(s\) drawn from a local-only folder/)
  assert.match(stderr, /2 row\(s\) with no recorded provenance \(`hyp graph project --refresh` re-derives/)
  const folderOnly = renderLocalOnlyNotice({ callerClass: 'full', filtered: true, withheldRows: 0, suppressedRows: 3, unprovenancedRows: 0 })
  assert.match(folderOnly, /3 row\(s\) drawn from a local-only folder/)
  assert.doesNotMatch(folderOnly, /--refresh/)
})

// @ref LLP 0616#contribution [tests]: the gateway's raw-SQL skill rules select cwd, so the Skill rows they mint record their folder
test('Skill rows from the gateway raw-SQL surfaces record their folder', async () => {
  const marker = message('sess-skill', 'shared', { content_text: 'Base directory for this skill: /home/u/.claude/skills/review' })
  await fixture(async ({ dirs, registry, storage, sql }) => {
    await projectGraph({ query: registry, storage, contracts: [contract()] })
    const open = byKey((await sql(NODES, { includeLocalOnly: true })).rows)
    assert.equal(open['Skill:review'].source_cwds, JSON.stringify([dirs.shared]))
    const synced = byKey((await sql(NODES)).rows)
    assert.equal(synced['Skill:review'].label, 'review', 'visible to a syncing caller')
  }, { partitions: { claude: [marker] } })
})
