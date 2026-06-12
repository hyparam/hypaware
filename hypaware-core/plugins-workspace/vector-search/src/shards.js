// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @import { CachePartitionMeta, VectorSearchHit } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { RawShardHit, ShardMeta, ShardState } from './types.d.ts'
 */

/**
 * Shard layout: one hypvector parquet file per cache partition, plus a
 * JSON sidecar carrying what the parquet KV metadata cannot — the
 * embedder model and the source partition's row count at build time.
 * Files live under `<plugin stateDir>/indexes/<index>/`:
 *
 *   indexes/<index>/<partitionFileBase>.parquet
 *   indexes/<index>/<partitionFileBase>.meta.json
 *
 * Shards are derived artifacts: rebuildable from the cache, never the
 * system of record. Deleting the whole tree costs one cold rebuild.
 */

/**
 * Render a partition kv-bag into a stable, filename-safe base name.
 * Keys are sorted so discovery order can never produce two names for
 * one partition. Mirrors the format-parquet filename convention,
 * including the `all` fallback for partition-less datasets.
 *
 * @param {Record<string, string>} partition
 * @returns {string}
 */
export function shardFileBase(partition) {
  const entries = Object.entries(partition ?? {}).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return 'all'
  return entries
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
    .replace(/[^A-Za-z0-9._=,-]/g, '_')
}

/**
 * @param {string} indexesDir
 * @param {string} indexName
 * @param {string} fileBase
 * @returns {{ file: string, meta: string }}
 */
export function shardPaths(indexesDir, indexName, fileBase) {
  const dir = path.join(indexesDir, indexName)
  return {
    file: path.join(dir, `${fileBase}.parquet`),
    meta: path.join(dir, `${fileBase}.meta.json`),
  }
}

/**
 * Default shard row id: a content hash of the embedded text. Identical
 * texts collapse to one vector, so denormalized columns (the same
 * value repeated on every row) cost one embedding call instead of one
 * per row.
 *
 * @param {string} text
 * @returns {string}
 */
export function contentId(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Read every shard sidecar under one index dir. Unreadable or
 * malformed sidecars are skipped — the shard will classify as
 * `missing` and rebuild through the normal path.
 *
 * @param {string} indexesDir
 * @param {string} indexName
 * @returns {Map<string, ShardMeta>}
 */
export function readShardMetas(indexesDir, indexName) {
  /** @type {Map<string, ShardMeta>} */
  const metas = new Map()
  const dir = path.join(indexesDir, indexName)
  /** @type {string[]} */
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return metas
  }
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue
    const fileBase = entry.slice(0, -'.meta.json'.length)
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'))
      if (parsed && parsed.schema_version === 1 && typeof parsed.model === 'string') {
        // A sidecar without its parquet file is a torn write; treat as
        // missing so the shard rebuilds. Empty shards (zero embeddable
        // texts) legitimately have a sidecar only.
        if (parsed.row_count > 0 && !fs.existsSync(path.join(dir, `${fileBase}.parquet`))) continue
        metas.set(fileBase, /** @type {ShardMeta} */ (parsed))
      }
    } catch { /* malformed sidecar — rebuild path handles it */ }
  }
  return metas
}

/**
 * Classify every shard of one index against the live cache partitions.
 * Pure over its inputs so the staleness rules are unit-testable:
 *
 *  - no shard for a live partition            → `missing`
 *  - sidecar model differs from config model  → `stale_model`
 *    (stale, not an error — the refresh path re-embeds)
 *  - sidecar source_row_count differs from the partition's current
 *    rowCount                                  → `stale_rows`
 *    (compaction dedup can shrink rowCount without new content; the
 *    re-embed is wasted work but never wrong)
 *  - shard whose partition no longer exists    → `orphan`
 *    (cache retention evicted it; the next sweep deletes the shard,
 *    so there is no index-over-deleted-rows staleness class)
 *  - otherwise                                 → `fresh`
 *
 * @param {{ partitions: CachePartitionMeta[], metas: Map<string, ShardMeta>, model: string }} args
 * @returns {ShardState[]}
 * @ref LLP 0024#indexes-are-declared-in-config-sharded-per-partition [implements] — model mismatch is staleness; retention coupling dissolves into orphan sweep
 */
export function computeShardStates({ partitions, metas, model }) {
  /** @type {ShardState[]} */
  const states = []
  const liveBases = new Set()

  for (const partition of partitions) {
    const fileBase = shardFileBase(partition.partition)
    liveBases.add(fileBase)
    const meta = metas.get(fileBase)
    if (!meta) {
      states.push({ fileBase, state: 'missing', partition })
    } else if (meta.model !== model) {
      states.push({ fileBase, state: 'stale_model', partition, meta })
    } else if (meta.source_row_count !== partition.rowCount) {
      states.push({ fileBase, state: 'stale_rows', partition, meta })
    } else {
      states.push({ fileBase, state: 'fresh', partition, meta })
    }
  }

  for (const [fileBase, meta] of metas) {
    if (!liveBases.has(fileBase)) {
      states.push({ fileBase, state: 'orphan', meta })
    }
  }

  return states
}

/**
 * Merge per-shard hit lists into one global top-K. Scores are cosine
 * over normalized vectors (higher = better) — fixed at shard write
 * time, so a plain descending sort is a correct merge.
 *
 * @template {RawShardHit} T
 * @param {T[][]} hitLists
 * @param {number} topK
 * @returns {T[]}
 */
export function mergeTopK(hitLists, topK) {
  /** @type {T[]} */
  const all = []
  for (const hits of hitLists) all.push(...hits)
  all.sort((a, b) => b.score - a.score)
  return all.slice(0, Math.max(0, topK))
}

/**
 * Render a hit's partition for display (`source=claude`, or `all`).
 *
 * @param {VectorSearchHit} hit
 * @returns {string}
 */
export function partitionLabel(hit) {
  return shardFileBase(hit.partition)
}
