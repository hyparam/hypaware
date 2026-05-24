// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { Attr, getKernelInstruments, getMeter, withSpan } from '../observability/index.js'
import { datasetsRoot } from './paths.js'
import { readRowsFromTable, tableExists } from './iceberg/store.js'

/**
 * @import { RetentionConfig } from './types.d.ts'
 */

/**
 * Default retention is 30 days per `hypaware-design.md` §Local Query
 * Cache. Plugins do not override this — the user controls retention
 * through `config.query.cache.retention`.
 */
export const DEFAULT_RETENTION_DAYS = 30

/**
 * Build the kernel's retention enforcer. The enforcer is daily
 * granularity: each `tick({ now })` walks every dataset/partition,
 * evicts anything past `default_days` (or the per-dataset override),
 * and emits one `retention.evict` span per evicted partition tagged
 * `hyp_dataset` and `partition`. The `hyp_rows_evicted` Sum metric is
 * incremented by the partition's row count.
 *
 * V1 does **not** wait for sink acknowledgement before evicting — the
 * `query.cache.retention.wait_for_sink_ack` flag is documented in the
 * config schema but is a no-op (open question from §Phase 4).
 *
 * @param {{ cacheRoot: string, config: RetentionConfig | undefined }} args
 */
export function createRetentionEnforcer({ cacheRoot, config }) {
  const cfg = normalizeConfig(config)
  const meter = getMeter('cache')
  const rowsEvicted = meter.createCounter('hyp_rows_evicted', {
    description: 'Rows evicted from the local cache by the retention enforcer',
  })

  return {
    /**
     * @param {{ now?: Date }} [opts]
     */
    async tick(opts = {}) {
      const now = opts.now ?? new Date()
      const root = datasetsRoot(cacheRoot)
      const datasets = listDirectory(root)
      /** @type {Array<{ dataset: string, partition: string, rowCount: number }>} */
      const evicted = []

      for (const dataset of datasets) {
        const retentionDays = cfg.datasets[dataset] ?? cfg.default_days
        if (retentionDays <= 0) continue
        const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
        const datasetDir = path.join(root, dataset)
        const partitions = listDirectory(datasetDir)

        for (const partition of partitions) {
          const partitionDir = path.join(datasetDir, partition)
          if (!tableExists(partitionDir)) continue
          const partitionTime = partitionMtime(partitionDir)
          if (partitionTime > cutoff) continue
          const rowCount = await countRows(partitionDir)

          await withSpan(
            'retention.evict',
            {
              [Attr.COMPONENT]: 'cache',
              [Attr.OPERATION]: 'retention.evict',
              [Attr.DATASET]: dataset,
              partition,
              rows_evicted: rowCount,
              status: 'ok',
            },
            async () => {
              fs.rmSync(partitionDir, { recursive: true, force: true })
              if (rowCount > 0) {
                rowsEvicted.add(rowCount, {
                  [Attr.DATASET]: dataset,
                  partition,
                })
              }
            },
            { component: 'cache' }
          )

          evicted.push({ dataset, partition, rowCount })
        }
      }

      // Touch the kernel instrument registry so test code that asserts
      // it stays consistent finds an initialized meter.
      getKernelInstruments()

      return { evicted }
    },
    config: cfg,
  }
}

/**
 * @param {RetentionConfig | undefined} config
 * @returns {Required<Pick<RetentionConfig, 'default_days'>> & { datasets: Record<string, number>, wait_for_sink_ack: boolean }}
 */
function normalizeConfig(config) {
  const default_days =
    typeof config?.default_days === 'number' && Number.isFinite(config.default_days)
      ? config.default_days
      : DEFAULT_RETENTION_DAYS
  const datasets = config?.datasets && typeof config.datasets === 'object' ? config.datasets : {}
  const wait_for_sink_ack = Boolean(config?.wait_for_sink_ack)
  return { default_days, datasets, wait_for_sink_ack }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listDirectory(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Best-effort partition timestamp: pick the newest data-file mtime if
 * any exist, otherwise fall back to the partition directory mtime.
 *
 * @param {string} partitionDir
 * @returns {number}
 */
function partitionMtime(partitionDir) {
  const dataDir = path.join(partitionDir, 'data')
  let newest = 0
  try {
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const mtime = fs.statSync(path.join(dataDir, entry.name)).mtimeMs
      if (mtime > newest) newest = mtime
    }
  } catch {
    /* no data dir yet */
  }
  if (newest > 0) return newest
  try {
    return fs.statSync(partitionDir).mtimeMs
  } catch {
    return Date.now()
  }
}

/**
 * @param {string} partitionDir
 * @returns {Promise<number>}
 */
async function countRows(partitionDir) {
  try {
    const rows = await readRowsFromTable(partitionDir)
    return rows.length
  } catch {
    return 0
  }
}
