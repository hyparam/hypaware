// @ts-check

import path from 'node:path'
import { discoverCachePartitions } from '../../../../src/core/cache/partition.js'
import { emptySource, unionSources } from 'hypaware/core/query'

/** @import { ColumnSpec, DatasetRegistration, DatasetDiscoveryContext, DatasetDataSourceContext, QueryPartition, LinearStorage } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

export const DATASET_NAME = 'linear_events'
export const PLUGIN_NAME = '@hypaware/linear'
/** @type {ColumnSpec[]} */
export const LINEAR_EVENTS_COLUMNS = [
  { name: 'event_id', type: 'STRING', nullable: false },
  { name: 'event_type', type: 'STRING', nullable: false },
  { name: 'workspace_id', type: 'STRING', nullable: false },
  { name: 'issue_id', type: 'STRING', nullable: false },
  { name: 'identifier', type: 'STRING', nullable: false },
  { name: 'team_id', type: 'STRING', nullable: false },
  { name: 'team_key', type: 'STRING', nullable: false },
  { name: 'state', type: 'STRING', nullable: true },
  { name: 'actor_id', type: 'STRING', nullable: true },
  { name: 'assignee_id', type: 'STRING', nullable: true },
  { name: 'attachment_id', type: 'STRING', nullable: true },
  { name: 'repo', type: 'STRING', nullable: true },
  { name: 'pr_number', type: 'INT64', nullable: true },
  { name: 'created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'updated_at', type: 'TIMESTAMP', nullable: false },
]

/** @param {LinearStorage} storage */
export function linearEventsTablePath(storage) { return storage.cacheTablePath(DATASET_NAME, ['all']) }

/** @param {DatasetDiscoveryContext} ctx @returns {Promise<QueryPartition[]>} */
async function discoverParts(ctx) {
  if (!ctx.cacheDir) return []
  const spool = { dataset: DATASET_NAME, partition: { partition: 'all' }, tablePath: path.join(ctx.cacheDir, 'datasets', DATASET_NAME, 'all') }
  const parts = await discoverCachePartitions(ctx.cacheDir, { datasets: [DATASET_NAME] })
  return [spool, ...parts.filter(p => p.path !== spool.tablePath).map(p => ({ dataset: DATASET_NAME, partition: p.partition, tablePath: p.path }))]
}

/** @param {QueryPartition[]} partitions @param {DatasetDataSourceContext} ctx */
async function createDataSource(partitions, ctx) {
  const storage = /** @type {LinearStorage} */ (ctx.storage)
  const committed = await storage.discoverCachePartitions({ datasets: [DATASET_NAME] })
  const paths = new Set([...partitions.map(p => p.tablePath), ...committed.map(p => p.path)])
  const sources = []
  for (const table of paths) {
    if (!table) continue
    const source = await storage.dataSourceForTable(table)
    if (source && source.numRows !== 0) sources.push(source)
  }
  return sources.length ? unionSources(sources) : emptySource(LINEAR_EVENTS_COLUMNS.map(c => c.name))
}

/** @returns {DatasetRegistration} */
export function linearEventsDatasetRegistration() {
  return { name: DATASET_NAME, plugin: PLUGIN_NAME, schema: { columns: LINEAR_EVENTS_COLUMNS },
    primaryTimestampColumn: 'updated_at', discoverPartitions: discoverParts,
    refreshPartition: async () => ({ status: 'skipped', rows: 0 }), createDataSource }
}
