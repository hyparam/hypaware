// @ts-check

import path from 'node:path'

/**
 * @import { ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService, ExtendedQueryStorageService, ScannableDataSource } from './types.js'
 */

export const PLUGIN_NAME = '@hypaware/github'
export const DATASET_NAME = 'github_events'
export const PARTITION_LABEL = 'all'

/**
 * The thin **activity skeleton** the T0 contract reads - structural columns
 * only, no content (LLP 0360). One append-only table, an `event_type`
 * discriminator the rules filter on, and an atomic grain: a commit touching N
 * files emits one `commit_file` row per file alongside the `commit` row, so
 * every contract rule stays a clean 1:1 map (the ai-gateway `File`-rule shape).
 *
 * `event_type` values:
 *   issue | pull_request | commit | commit_file | pull_request_file |
 *   review | issue_comment | pull_request_comment
 *
 * No `Repo`/`Actor`/`File` row exists on its own - those nodes are minted by
 * the contract from the columns on every event row that mentions them. Content
 * (titles, bodies, diffs, comment text) stays in GitHub and is dereferenced via
 * the natural keys (LLP 0032); it never lands here.
 *
 * @ref LLP 0360#concrete-columns [implements]: typed structural columns + discriminator + small payload, no content
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const GITHUB_EVENTS_COLUMNS = Object.freeze([
  { name: 'event_id', type: 'STRING', nullable: false }, // deterministic, for in-run dedup + readability
  { name: 'event_type', type: 'STRING', nullable: false }, // the discriminator the rules WHERE on
  { name: 'repo', type: 'STRING', nullable: false }, // owner/repo as GitHub returns it; the contract normalizes
  { name: 'actor_login', type: 'STRING', nullable: true },
  { name: 'actor_type', type: 'STRING', nullable: true }, // User | Bot | Organization (Actor prop)
  { name: 'number', type: 'INT64', nullable: true }, // issue / PR / comment subject number
  { name: 'sha', type: 'STRING', nullable: true }, // commit sha (full 40-hex)
  { name: 'path', type: 'STRING', nullable: true }, // changed-file relpath (commit_file / pull_request_file)
  { name: 'review_id', type: 'INT64', nullable: true },
  { name: 'review_state', type: 'STRING', nullable: true }, // APPROVED | CHANGES_REQUESTED | COMMENTED (Review prop)
  { name: 'state', type: 'STRING', nullable: true }, // issue/PR state: open | closed | merged
  { name: 'pr_number', type: 'INT64', nullable: true }, // linkage: PR a review is on / PR that references a commit
  { name: 'created_at', type: 'TIMESTAMP', nullable: true }, // event time (primary timestamp)
  { name: 'payload', type: 'JSON', nullable: true }, // small type-specific structural extras (no content)
])

/** @type {{ columns: ColumnSpec[] }} */
export const GITHUB_EVENTS_SCHEMA = { columns: [...GITHUB_EVENTS_COLUMNS] }

/**
 * On-disk table path for `github_events`. The plugin writes through the kernel
 * cache service; the service owns durable spool + Iceberg flush details.
 *
 * @param {QueryStorageService} storage
 */
export function githubEventsTablePath(storage) {
  return storage.cacheTablePath(DATASET_NAME, [PARTITION_LABEL])
}

/**
 * Discover the single `github_events` partition (gascity's single-partition
 * shape - the cache is HypAware-managed, so discovery only surfaces the path).
 *
 * @param {DatasetDiscoveryContext} ctx
 * @returns {QueryPartition[]}
 */
export function discoverParts(ctx) {
  const cacheDir = ctx.cacheDir ?? ''
  if (!cacheDir) return []
  const tablePath = path.join(cacheDir, 'datasets', DATASET_NAME, PARTITION_LABEL)
  return [{ dataset: DATASET_NAME, partition: { partition: PARTITION_LABEL }, tablePath }]
}

/**
 * No external source file to refresh - capture writes rows through the cache
 * service from the poll/backfill/sync paths - so report `skipped` (the sentinel
 * the query layer tolerates), exactly like gascity and the graph datasets.
 *
 * @returns {Promise<DatasetRefreshResult>}
 */
export async function refreshPartition() {
  return { status: 'skipped', rows: 0 }
}

/**
 * Build a squirreling-compatible data source over the materialized
 * `github_events` rows. Returns an empty source when nothing is materialized so
 * a query on a cold cache still succeeds.
 *
 * The kernel cache service writes capture rows in its **source-table** layout
 * (`datasets/github_events/source=<src>/table/…`), not under the bare
 * `PARTITION_LABEL` path `discoverParts` hand-rolls - so reading
 * `partition.tablePath` directly finds an empty directory and the contract
 * projects nothing. Re-discover through the service (the same path
 * `@hypaware/ai-gateway` uses for its live-ingested rows) and union whatever it
 * surfaces, so flushed events are visible to queries and `graph project`.
 *
 * @param {QueryPartition[]} partitions
 * @param {DatasetDataSourceContext} ctx
 * @returns {Promise<ScannableDataSource>}
 */
export async function createDataSource(partitions, ctx) {
  const storage = /** @type {ExtendedQueryStorageService} */ (ctx.storage)
  const discovered = await storage.discoverCachePartitions({ datasets: [DATASET_NAME] })

  /** @type {Set<string>} */
  const tablePaths = new Set()
  for (const p of partitions) {
    if (p.tablePath) tablePaths.add(p.tablePath)
  }
  for (const p of discovered) {
    if (p.path) tablePaths.add(p.path)
  }

  /** @type {ScannableDataSource[]} */
  const sources = []
  for (const tablePath of tablePaths) {
    const source = await storage.dataSourceForTable(tablePath)
    if (source && source.numRows !== 0) sources.push(source)
  }

  if (sources.length === 0) return emptySource()
  if (sources.length === 1) return sources[0]
  return unionSources(sources)
}

/**
 * Concatenate multiple partition sources into one. `github_events` is
 * single-source today (everything lands under `source=unknown`), but keep this
 * total so a future source split stays queryable without another silent
 * zero-row read.
 *
 * @param {ScannableDataSource[]} sources
 * @returns {ScannableDataSource}
 */
function unionSources(sources) {
  const columns = Array.from(new Set(sources.flatMap((s) => s.columns)))
  const numRows = sources.reduce((n, s) => n + (s.numRows ?? 0), 0)
  return {
    columns,
    numRows,
    scan(options) {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const s of sources) {
            for await (const row of s.scan(options).rows()) yield row
          }
        },
      }
    },
  }
}

/** @returns {ScannableDataSource} */
function emptySource() {
  return {
    columns: GITHUB_EVENTS_COLUMNS.map((c) => c.name),
    numRows: 0,
    scan() {
      return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} }
    },
  }
}

/**
 * The `DatasetRegistration` handed to `ctx.query.registerDataset`.
 *
 * @returns {DatasetRegistration}
 */
export function githubEventsDatasetRegistration() {
  return {
    name: DATASET_NAME,
    plugin: PLUGIN_NAME,
    schema: GITHUB_EVENTS_SCHEMA,
    primaryTimestampColumn: 'created_at',
    discoverPartitions: discoverParts,
    refreshPartition,
    createDataSource,
  }
}
