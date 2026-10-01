// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { renderCacheStatus } from '../../src/core/commands/query.js'

/**
 * @param {Record<string, unknown>} over
 */
function sourceTable(over) {
  return {
    dataset: 'ai_gateway_messages',
    partition: { source: 'claude' },
    epoch: 0,
    rowCount: 0,
    dataFileCount: 1,
    metadataBytes: 0,
    snapshotCount: 1,
    deleteFileCount: 0,
    lastRetentionCutoffDate: '2026-07-03',
    layout: 'source-table',
    ...over,
  }
}

/**
 * @param {unknown[]} partitions
 * @param {Array<{ name: string, plugin: string }>} datasets
 */
function render(partitions, datasets) {
  return renderCacheStatus(/** @type {any} */ ({
    report: { cacheRoot: '/cache', pendingSpoolBytes: 2048, partitions },
    datasets,
  }))
}

test('cache status renders one aligned table grouped by dataset', () => {
  const out = render(
    [
      { dataset: 'ai_gateway_messages', partition: {}, epoch: 1, rowCount: 0, dataFileCount: 1, metadataBytes: 111013, snapshotCount: 6, layout: 'epoch' },
      sourceTable({ rowCount: 109719, dataFileCount: 49, snapshotCount: 20, metadataBytes: 3035022 }),
      sourceTable({ partition: { source: 'codex' }, rowCount: 14683, dataFileCount: 52, snapshotCount: 45, metadataBytes: 10772234, deleteFileCount: 7 }),
      sourceTable({ dataset: 'edge', partition: { source: 'unknown' }, rowCount: 67216, snapshotCount: 20, metadataBytes: 671065, deleteFileCount: 4 }),
    ],
    [
      { name: 'ai_gateway_messages', plugin: '@hypaware/ai-gateway' },
      { name: 'edge', plugin: '@hypaware/context-graph' },
    ]
  )

  assert.equal(out, [
    'cache      /cache',
    'pending    2 KB',
    'retention  cutoff 2026-07-03',
    '',
    'DATASET                 ROWS  FILES  SNAPSHOTS  DELETES  METADATA',
    'ai_gateway_messages                                                 @hypaware/ai-gateway',
    '  (all)                    0      1          6        -    111 KB   legacy epoch 1',
    '  claude             109,719     49         20        -    3.0 MB',
    '  codex               14,683     52         45        7   10.8 MB',
    'edge                  67,216      1         20        4    671 KB   @hypaware/context-graph',
    '',
  ].join('\n'))
})

test('cache status keeps every dataset name at column 0', () => {
  const out = render(
    [sourceTable({}), sourceTable({ dataset: 'orphan', partition: { source: 'unknown' } })],
    [
      { name: 'ai_gateway_messages', plugin: '@hypaware/ai-gateway' },
      { name: 'node', plugin: '@hypaware/context-graph' },
    ]
  )

  // A registered dataset with nothing on disk still lists; a partition whose
  // dataset no plugin registers is marked, so it is not read as queryable.
  assert.match(out, /^ai_gateway_messages\s+@hypaware\/ai-gateway$/m)
  assert.match(out, /^ {2}claude\s/m, 'a lone real source keeps its own row')
  assert.match(out, /^node\s+-\s+-\s+-\s+-\s+-\s+@hypaware\/context-graph$/m)
  assert.match(out, /^orphan\s.*\(not registered\)$/m)
})

test('cache status notes only a partition whose retention cutoff departs from the shared one', () => {
  const out = render(
    [
      sourceTable({}),
      sourceTable({ partition: { source: 'codex' } }),
      sourceTable({ partition: { source: 'hermes' }, lastRetentionCutoffDate: '2026-06-01' }),
      sourceTable({ partition: { source: 'openclaw' }, lastRetentionCutoffDate: undefined }),
    ],
    [{ name: 'ai_gateway_messages', plugin: '@hypaware/ai-gateway' }]
  )

  assert.match(out, /^retention {2}cutoff 2026-07-03$/m)
  assert.match(out, /^ {2}claude(?!.*cutoff).*$/m)
  assert.match(out, /^ {2}hermes\s.* {3}cutoff 2026-06-01$/m)
  assert.match(out, /^ {2}openclaw\s.* {3}no cutoff$/m)
})

test('cache status on an empty install says so instead of printing an empty table', () => {
  const out = render([], [])

  assert.equal(out, 'cache      /cache\npending    2 KB\ndatasets   none registered\n')
})
