// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadLatestFileCatalogMetadata } from 'icebird'

import { compactGraphTables } from '../../hypaware-core/plugins-workspace/context-graph/src/maintenance.js'
import { NODE_COLUMNS } from '../../hypaware-core/plugins-workspace/context-graph/src/datasets.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'
import { scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'

/** @param {Partial<Record<string, unknown>>} overrides */
function nodeRow(overrides) {
  return {
    node_id: 'n-x',
    node_type: 'Session',
    natural_key: 'session:x',
    label: 'x',
    props: { a: 1 },
    first_seen: '2026-06-01T00:00:00Z',
    source_dataset: 'ai_gateway_messages',
    source_keys: null,
    projector: 'context-graph',
    projector_version: 1,
    ...overrides,
  }
}

/** @param {string} partitionDir */
async function readPartitionRows(partitionDir) {
  const cursor = readCursorSync(partitionDir)
  const tableDir = path.join(partitionDir, cursor.tableDir ?? 'table')
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for await (const row of scanRowsFromTable(tableDir)) rows.push(row)
  return { rows, cursor, tableDir }
}

test('compactGraphTables merges cross-partition duplicates into the earliest partition, sorted', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-maint-'))

  // Partition a holds the earliest sighting of n-x plus a unique node;
  // partition b holds a later duplicate of n-x with extra props.
  await appendRowsToSourceTable(cacheRoot, 'node', ['source=a'], NODE_COLUMNS, [
    nodeRow({ node_id: 'n-x', first_seen: '2026-06-01T00:00:00Z', props: { a: 1 } }),
    nodeRow({ node_id: 'n-y', node_type: 'App', natural_key: 'app:y', first_seen: '2026-06-02T00:00:00Z' }),
  ])
  await appendRowsToSourceTable(cacheRoot, 'node', ['source=b'], NODE_COLUMNS, [
    nodeRow({ node_id: 'n-x', first_seen: '2026-06-03T00:00:00Z', props: { b: 2 } }),
    nodeRow({ node_id: 'n-z', node_type: 'Tool', natural_key: 'tool:z', first_seen: '2026-06-04T00:00:00Z' }),
  ])

  const storage = /** @type {any} */ ({ cacheRoot })

  const dry = await compactGraphTables({ storage, dryRun: true })
  const dryNode = dry.datasets.find((d) => d.dataset === 'node')
  assert.equal(dryNode?.duplicateIds, 1)
  assert.equal(dryNode?.rowsMerged, 0, 'dry run does not merge')

  const report = await compactGraphTables({ storage })
  const nodeReport = report.datasets.find((d) => d.dataset === 'node')
  assert.equal(nodeReport?.duplicateIds, 1)
  assert.equal(nodeReport?.rowsMerged, 1)
  assert.equal(nodeReport?.partitionsRewritten, 2)

  const partA = path.join(cacheRoot, 'datasets', 'node', 'source=a')
  const partB = path.join(cacheRoot, 'datasets', 'node', 'source=b')
  const a = await readPartitionRows(partA)
  const b = await readPartitionRows(partB)

  // The merged row lives in partition a (earliest first_seen), once.
  const mergedX = a.rows.filter((r) => r.node_id === 'n-x')
  assert.equal(mergedX.length, 1)
  assert.equal(b.rows.filter((r) => r.node_id === 'n-x').length, 0)
  assert.equal(
    new Date(/** @type {any} */ (mergedX[0].first_seen)).toISOString().slice(0, 10),
    '2026-06-01',
    'earliest first_seen wins'
  )
  const props = typeof mergedX[0].props === 'string' ? JSON.parse(mergedX[0].props) : mergedX[0].props
  assert.deepEqual(props, { a: 1, b: 2 }, 'props are unioned')

  // Unique rows survive in place.
  assert.equal(a.rows.filter((r) => r.node_id === 'n-y').length, 1)
  assert.equal(b.rows.filter((r) => r.node_id === 'n-z').length, 1)

  // The rewrite swapped generations and retired the old table dir.
  assert.notEqual(a.cursor.tableDir, 'table')
  assert.equal(a.cursor.rowCount, 2)
  const retired = await fs.readFile(path.join(partA, 'table', '.retired'), 'utf8')
  assert.ok(retired.length > 0)

  // The replacement table declares the graph sort order.
  const { resolver, lister } = await createLocalIcebergIO()
  const { metadata } = await loadLatestFileCatalogMetadata({
    tableUrl: tableUrlForDir(a.tableDir), resolver, lister,
  })
  const sortOrders = metadata['sort-orders'] ?? []
  const defaultOrder = sortOrders.find((o) => o['order-id'] === metadata['default-sort-order-id'])
  assert.ok(defaultOrder && defaultOrder.fields.length >= 2, 'default sort order declared on rewrite')

  // Idempotent: a second pass finds nothing to do.
  const again = await compactGraphTables({ storage })
  const againNode = again.datasets.find((d) => d.dataset === 'node')
  assert.equal(againNode?.duplicateIds, 0)
  assert.equal(againNode?.partitionsRewritten, 0)

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('compactGraphTables is a no-op on an empty cache', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-maint-'))
  const report = await compactGraphTables({ storage: /** @type {any} */ ({ cacheRoot }) })
  for (const d of report.datasets) {
    assert.equal(d.duplicateIds, 0)
    assert.equal(d.rowsMerged, 0)
    assert.equal(d.partitionsRewritten, 0)
  }
  await fs.rm(cacheRoot, { recursive: true, force: true })
})
