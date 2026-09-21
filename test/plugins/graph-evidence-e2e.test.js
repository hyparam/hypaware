// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendRowsToSourceTable, discoverCachePartitions, tryReadCursorSync } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'
import { executeQuerySql } from '../../src/core/query/sql.js'
import { aiGatewayDatasetRegistration, AI_GATEWAY_SCHEMA_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import * as kit from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import { graphDatasetRegistration, graphTablePath, EDGE_COLUMNS } from '../../hypaware-core/plugins-workspace/context-graph/src/datasets.js'
import { projectGraph } from '../../hypaware-core/plugins-workspace/context-graph/src/project.js'
import { queryEvidence, queryNeighbors } from '../../hypaware-core/plugins-workspace/context-graph/src/query.js'
import { createAiGatewayGraphContract } from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js'
import { buildEnrichmentContract } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/contract.js'
import { enrichDatasetRegistration, enrichTablePath, COMMITTED_COLUMNS } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/datasets.js'
import { collectProspectRows, evidenceKeys, buildTranscript } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/propose.js'
import { curateRequestForCluster, routeDecision } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/curate.js'
import { validateEnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/config.js'

const validated = validateEnrichConfig({})
if (!validated.ok) throw new Error('bad fixture config')
const cfg = validated.config
const at = '2026-09-21T12:00:00.000Z'
const quote = 'Review helpers now require a changed diff.'
const source = Array.from({ length: 61 }, (_, i) => ({
  session_id: 'review-session', message_id: `message-${i}`, part_id: `part-${i}`, message_created_at: at,
  part_type: 'text', role: 'user', content_text: i === 60 ? quote : `Unrelated earlier passage ${i}`,
  cwd: i === 60 ? '/private-work' : '/shared-work',
}))

/** @param {(ctx: any) => Promise<void>} run @param {any[]} rows */
async function fixture(run, rows = source) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-evidence-'))
  try {
    const registry = createQueryRegistry()
    registry.registerDataset(aiGatewayDatasetRegistration())
    registry.registerDataset(graphDatasetRegistration('node'))
    registry.registerDataset(graphDatasetRegistration('edge'))
    registry.registerDataset(enrichDatasetRegistration('enrichment_committed', 'committed_at'))
    const privateDir = path.join(cacheRoot, 'private')
    await fs.mkdir(privateDir)
    await fs.writeFile(path.join(privateDir, '.hypignore'), '')
    rows = rows.map(r => ({ ...r, cwd: r.cwd === '/private-work' ? privateDir : path.join(cacheRoot, 'shared') }))
    const columns = AI_GATEWAY_SCHEMA_COLUMNS.filter(c => Object.hasOwn(rows[0], c.name))
    await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=test'], [...columns], rows)
    const storage = createQueryStorageService({ cacheRoot })
    const sql = query => executeQuerySql({ query, storage, registry, includeLocalOnly: true, refresh: 'always' })
    await run({ registry, storage, sql })
  } finally { await fs.rm(cacheRoot, { recursive: true, force: true }) }
}

test('late verified evidence survives T1, T2, commit, graph and two-hop source dereference', async () => {
  await fixture(async ({ registry, storage, sql }) => {
    const prospects = [...collectProspectRows([{ anchorKey: 'review-session', rows: source,
      candidates: [{ type: 'Decision', label: 'Review policy', evidence: quote }] }], cfg, at).values()]
    assert.equal(prospects.length, 1)
    assert.deepEqual(prospects[0].source_keys, { message_id: ['message-60'], part_id: ['part-60'] })
    const runtime = /** @type {any} */ ({ config: cfg, _completion: { provider: 'test' }, execSql: ({ query }) => sql(query) })
    const request = await curateRequestForCluster(runtime, prospects, new Map())
    const prompt = JSON.stringify(request.messages)
    assert.ok(prompt.includes(quote))
    assert.ok(!prompt.includes('Unrelated earlier passage'))
    const routed = routeDecision(prospects[0], { type: 'Decision', label: 'Review policy', summary: '', confidence: undefined }, { index: 1, decision: 'commit' }, at)
    assert.ok(routed.committed)
    const contracts = [buildEnrichmentContract(kit)]
    const legacy = { ...routed.committed, props: { summary: 'Legacy claim without a precise quote' }, source_keys: { message_id: source.map(r => r.message_id) }, committed_at: '2026-09-20T12:00:00.000Z' }
    await storage.appendRows(enrichTablePath(storage, 'enrichment_committed'), [...COMMITTED_COLUMNS], [legacy])
    await projectGraph({ query: registry, storage, contracts })
    const sharedClaim = { ...routed.committed, anchor_key: 'shared-session', source_keys: { message_id: ['message-0'], part_id: ['part-0'] } }
    await storage.appendRows(enrichTablePath(storage, 'enrichment_committed'), [...COMMITTED_COLUMNS], [routed.committed, sharedClaim])
    await projectGraph({ query: registry, storage, contracts, refresh: true })
    const id = kit.edgeId(kit.nodeId('Session', 'review-session'), 'produced', kit.nodeId('Decision', 'Review policy'))
    const evidence = await queryEvidence({ query: registry, storage, kind: 'edge', id, includeLocalOnly: true })
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].part_id, 'part-60')
    assert.equal(evidence[0].content_text, quote)
    // Mixed source contexts never make the merged label or its private evidence
    // visible to an unknown/shared caller. No implicit override at any hop.
    assert.deepEqual(await queryEvidence({ query: registry, storage, kind: 'edge', id }), [])
    const visibleSource = await executeQuerySql({ query: 'SELECT part_id FROM ai_gateway_messages', registry, storage })
    assert.equal(visibleSource.rows.length, 60, 'the private part is withheld while shared parts remain visible')
    const restricted = await executeQuerySql({ query: 'SELECT label, source_keys, props FROM node', registry, storage })
    assert.ok(restricted.rows.every(r => r.label === null && r.source_keys === null && r.props === null))
  })
})

test('unmatched and ambiguous claim evidence fails closed; oversized transcripts refuse', () => {
  assert.equal(evidenceKeys(source, 'invented quote', cfg), null)
  assert.equal(evidenceKeys(source, '', cfg), null)
  assert.equal(evidenceKeys([...source, { ...source[60], part_id: 'another-part' }], quote, cfg), null)
  assert.throws(() => buildTranscript([{ content_text: 'x'.repeat(2_000_001) }], cfg), /budget/)
})

test('same-batch claims for one item retain distinct evidence locators', async () => {
  await fixture(async ({ registry, storage, sql }) => {
    const prospects = [...collectProspectRows([{ anchorKey: 'review-session', rows: source,
      candidates: [
        { type: 'Decision', label: 'First claim', evidence: source[0].content_text },
        { type: 'Decision', label: 'Second claim', evidence: quote },
        { type: 'Decision', label: 'Repeated first claim', evidence: source[0].content_text },
      ] }], cfg, at).values()]
    const committed = prospects.map(p => routeDecision(p,
      { type: 'Decision', label: String(p.label), summary: '', confidence: undefined },
      { index: 1, decision: 'commit', item_key: 'shared-item' }, at).committed)
    await storage.appendRows(enrichTablePath(storage, 'enrichment_committed'), [...COMMITTED_COLUMNS], committed)
    await projectGraph({ query: registry, storage, contracts: [buildEnrichmentContract(kit)] })
    const id = kit.nodeId('Decision', 'shared-item')
    const graphRow = (await sql(`SELECT props FROM node WHERE node_id = '${id}'`)).rows[0]
    const props = typeof graphRow.props === 'string' ? JSON.parse(graphRow.props) : graphRow.props
    const evidence = await queryEvidence({ query: registry, storage, kind: 'node', id, includeLocalOnly: true })
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].content_text, props.evidence)
    assert.deepEqual(await queryEvidence({ query: registry, storage, kind: 'node', id }), [])
    await storage.appendRows(enrichTablePath(storage, 'enrichment_committed'), [...COMMITTED_COLUMNS], Array(16).fill(committed[0]))
    assert.deepEqual(await queryEvidence({ query: registry, storage, kind: 'node', id, includeLocalOnly: true }), [], 'overflow refuses partial candidate matching')
  })
})

test('explicit refresh repairs stale activity evidence, repeat refresh is stable, and direct dereference works', async () => {
  const tool = { ...source[0], part_type: 'tool_call', role: 'assistant', tool_name: 'exec', tool_args: 'text(await tools.exec_command({cmd:"cat /repo/a.js /repo/b.js"}))' }
  await fixture(async ({ registry, storage, sql }) => {
    const contract = createAiGatewayGraphContract(kit)
    const touched = contract.rules.find(r => r.type === 'touched')
    assert.ok(touched)
    const stale = /** @type {Record<string, any>} */ ({ ...touched.toRow(tool), source_keys: { session_id: tool.session_id }, projector_version: 2 })
    await storage.appendRows(graphTablePath(storage, 'edge'), [...EDGE_COLUMNS], [stale])
    await projectGraph({ query: registry, storage, contracts: [contract] })
    let row = (await sql(`SELECT * FROM edge WHERE edge_id = '${stale.edge_id}'`)).rows[0]
    assert.equal(row.projector_version, 2, 'default projection still skips persisted ids')
    await projectGraph({ query: registry, storage, contracts: [contract], refresh: true })
    const result = await sql(`SELECT * FROM edge WHERE edge_id = '${stale.edge_id}'`)
    assert.equal(result.rows.length, 1, 'refresh replaces rather than appending a duplicate')
    row = result.rows[0]
    assert.equal(row.projector_version, 3)
    const evidence = await queryEvidence({ query: registry, storage, kind: 'edge', id: String(stale.edge_id), includeLocalOnly: true })
    assert.equal(evidence[0].part_id, 'part-0')
    const neighbors = await queryNeighbors({ query: registry, storage, seed: tool.session_id, edgeTypes: ['touched'], includeLocalOnly: true })
    assert.ok(neighbors.ok)
    assert.equal(neighbors.neighbors.length, 2)
    assert.ok(neighbors.neighbors.every(n => n.props?.inferred_call === true && n.source_keys?.part_id === 'part-0'))
    const parts = await discoverCachePartitions(storage.cacheRoot, { datasets: ['edge'] })
    const before = parts.map(p => tryReadCursorSync(p.path)?.tableDir)
    const again = await projectGraph({ query: registry, storage, contracts: [contract], refresh: true })
    assert.equal(again.edgesWritten, 0)
    assert.deepEqual(parts.map(p => tryReadCursorSync(p.path)?.tableDir), before, 'identical refresh does not rewrite generations')
  }, [tool])
})

test('neighbor output limit cannot hide an over-budget graph scan', async () => {
  const { asyncRow } = await import('squirreling')
  let scanned = 0
  const edgeSource = {
    columns: ['edge_id', 'src_id', 'dst_id', 'edge_type', 'props', 'source_dataset', 'source_keys'],
    numRows: 1_000_000,
    scan(options) {
      return {
        appliedWhere: false, appliedLimitOffset: false,
        async *rows() {
          for (let i = 0; i < 1_000_000; i++) {
            scanned++
            yield asyncRow({ edge_id: `e${i}`, src_id: 'seed', dst_id: `node-${i}`, edge_type: 'touched', props: null, source_dataset: 'ai_gateway_messages', source_keys: null }, options.columns)
          }
        },
      }
    },
  }
  const nodeSource = { columns: ['node_id', 'node_type', 'natural_key', 'label'], numRows: 0,
    scan() { return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} } } }
  const registry = /** @type {any} */ ({ getDataset: name => ({ discoverPartitions: async () => [], createDataSource: async () => name === 'edge' ? edgeSource : nodeSource }), listDatasets: () => [] })
  const storage = /** @type {any} */ ({ cacheRoot: '/tmp/graph-budget-test', pendingInfo: async () => ({ pending: false }) })
  const result = await queryNeighbors({ query: registry, storage, seed: 'seed', limit: 1, includeLocalOnly: true })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /read budget/)
  assert.ok(scanned <= 100_002, `bounded row scan, observed ${scanned}`)
})
