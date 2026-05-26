// @ts-check

import path from 'node:path'

import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { readCursorSync } from '../../../src/core/cache/partition.js'
import { maintainCache, cacheStatus } from '../../../src/core/cache/maintenance.js'

/**
 * @import { ColumnSpec } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { KernelRuntime } from '../../../src/core/runtime/activation.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.d.ts'
 */

const DATASET = 'maintenance_rows'
/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'value', type: 'STRING', nullable: false },
]

/**
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })
  registerDataset(kernel)

  // --- 1. Create many small appends to trigger compaction ---
  const tablePath = kernel.storage.cacheTablePath(DATASET)
  const totalRows = 1200

  await runRoot(
    'smoke.populate',
    {
      [Attr.COMPONENT]: 'cache',
      [Attr.OPERATION]: 'smoke.populate',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'populate',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      for (let batch = 0; batch < 40; batch++) {
        const rows = []
        for (let i = 0; i < 30; i++) {
          rows.push({ id: BigInt(batch * 30 + i), value: `v-${batch * 30 + i}` })
        }
        await kernel.storage.appendRows(tablePath, COLUMNS, rows)
        await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_maintenance' })
      }
    }
  )

  // --- 2. Verify pre-maintenance state ---
  const statusBefore = await cacheStatus({ cacheRoot })
  expect.that(
    'pre-maintenance: partitions discovered',
    statusBefore.partitions.length,
    (v) => typeof v === 'number' && v > 0
  )

  const partBefore = statusBefore.partitions.find((p) => p.dataset === DATASET)
  expect.that(
    'pre-maintenance: multiple data files from many small appends',
    partBefore?.dataFileCount,
    (v) => typeof v === 'number' && v > 1
  )
  expect.that(
    'pre-maintenance: multiple snapshots from many appends',
    partBefore?.snapshotCount,
    (v) => typeof v === 'number' && v > 1
  )

  // --- 3. Run maintenance with --force ---
  const report = await runRoot(
    'smoke.maintenance',
    {
      [Attr.COMPONENT]: 'cache',
      [Attr.OPERATION]: 'smoke.maintenance',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'run_maintenance',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    () => maintainCache({
      cacheRoot,
      force: true,
      config: {
        min_snapshots_to_keep: 2,
        max_snapshot_age_hours: 0,
      },
    })
  )

  expect.that(
    'maintenance: at least one partition compacted',
    report.totalCompacted,
    (v) => typeof v === 'number' && v > 0
  )

  // --- 4. Verify post-maintenance state ---
  const cursor = readCursorSync(path.join(
    cacheRoot, 'datasets', DATASET, 'all'
  ))
  expect.that(
    'post-maintenance: cursor epoch advanced',
    cursor.epoch,
    (v) => typeof v === 'number' && v > 0
  )
  expect.that(
    'post-maintenance: cursor has compaction metadata',
    cursor.compaction,
    (v) => v !== null && typeof v === 'object'
  )
  expect.that(
    'post-maintenance: row count preserved',
    cursor.rowCount,
    (v) => typeof v === 'number' && v === totalRows
  )

  // --- 5. Verify data is still queryable ---
  await runRoot(
    'smoke.verify',
    {
      [Attr.COMPONENT]: 'cache',
      [Attr.OPERATION]: 'smoke.verify',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'verify',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const stdout = makeBuf()
      const stderr = makeBuf()
      const code = await dispatch(
        ['query', 'sql', `select count(*) as n from ${DATASET}`, '--refresh', 'never', '--format', 'json'],
        { stdout, stderr, kernel, registry }
      )
      expect.that('query: sql exited 0', code, (v) => v === 0)
      expect.that(
        'query: row count matches after compaction',
        JSON.parse(stdout.text())?.[0]?.n,
        (v) => Number(v) === totalRows
      )

      // --- 6. Verify hyp query status output ---
      const statusStdout = makeBuf()
      const statusStderr = makeBuf()
      const statusCode = await dispatch(
        ['query', 'status'],
        { stdout: statusStdout, stderr: statusStderr, kernel, registry }
      )
      expect.that('query status: exited 0', statusCode, (v) => v === 0)
      expect.that(
        'query status: output contains partition info',
        statusStdout.text(),
        (v) => typeof v === 'string' && v.includes('partitions:')
      )

      // --- 7. Verify hyp query maintain CLI ---
      const maintainStdout = makeBuf()
      const maintainStderr = makeBuf()
      const maintainCode = await dispatch(
        ['query', 'maintain', '--dry-run'],
        { stdout: maintainStdout, stderr: maintainStderr, kernel, registry }
      )
      expect.that('query maintain: dry-run exited 0', maintainCode, (v) => v === 0)
      expect.that(
        'query maintain: output contains maintenance summary',
        maintainStdout.text(),
        (v) => typeof v === 'string' && v.includes('maintenance:')
      )
    }
  )

  await obs.shutdown()
}

/**
 * @param {KernelRuntime} kernel
 */
function registerDataset(kernel) {
  kernel.query.registerDataset({
    name: DATASET,
    plugin: '@hypaware/smoke',
    schema: { columns: COLUMNS },
    discoverPartitions() {
      return [{ dataset: DATASET, partition: {}, tablePath: kernel.storage.cacheTablePath(DATASET) }]
    },
    async createDataSource(partitions, ctx) {
      const storage = /** @type {ExtendedQueryStorageService} */ (ctx.storage)
      const partMetas = await storage.discoverCachePartitions({ datasets: [DATASET] })
      if (partMetas.length === 0) {
        const source = await storage.dataSourceForTable(partitions[0]?.tablePath ?? '')
        return source ?? {
          columns: COLUMNS.map((c) => c.name),
          scan() {
            return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} }
          },
        }
      }
      const sources = []
      for (const m of partMetas) {
        const epochDir = path.join(m.path, `epoch=${m.epoch}`)
        const source = await storage.dataSourceForTable(epochDir)
        if (source) sources.push(source)
      }
      if (sources.length === 0) {
        return {
          columns: COLUMNS.map((c) => c.name),
          scan() {
            return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} }
          },
        }
      }
      if (sources.length === 1) return sources[0]
      const columns = COLUMNS.map((c) => c.name)
      return {
        columns,
        scan(opts) {
          return {
            appliedWhere: false,
            appliedLimitOffset: false,
            async *rows() {
              for (const source of sources) {
                const scan = source.scan(opts ?? {})
                for await (const row of scan.rows()) yield row
              }
            },
          }
        },
      }
    },
  })
}

function makeBuf() {
  let buf = ''
  return {
    write(/** @type {string} */ chunk) { buf += String(chunk) },
    text() { return buf },
  }
}
