// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { installObservability } from '../../../src/core/observability/index.js'

/**
 * @import { ColumnSpec } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { KernelRuntime } from '../../../src/core/runtime/activation.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.d.ts'
 */

const DATASET = 'spool_rows'
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

  const tablePath = kernel.storage.cacheTablePath(DATASET)
  const rowCount = 200
  for (let i = 0; i < rowCount; i += 1) {
    await kernel.storage.appendRows(tablePath, COLUMNS, [{ id: BigInt(i), value: `v-${i}` }])
  }

  await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_batching' })

  const dataFiles = await listDataFiles(tablePath)
  expect.that(
    'cache: one-row appends landed in fewer Iceberg data files than rows',
    dataFiles.length,
    (v) => typeof v === 'number' && v > 0 && v < rowCount
  )

  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(
    ['query', 'sql', `select count(*) as n from ${DATASET}`, '--refresh', 'never', '--format', 'json'],
    { stdout, stderr, kernel, registry }
  )
  expect.that('dispatch: query sql exited 0', code, (v) => v === 0)
  expect.that('stderr: query sql had no errors', stderr.text(), (v) => v === '')
  expect.that(
    'query: count matches all spooled rows after flush',
    JSON.parse(stdout.text())?.[0]?.n,
    (v) => Number(v) === rowCount
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
      const source = await storage.dataSourceForTable(partitions[0]?.tablePath ?? '')
      return source ?? {
        columns: COLUMNS.map((c) => c.name),
        scan() {
          return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} }
        },
      }
    },
  })
}

/** @param {string} tablePath */
async function listDataFiles(tablePath) {
  try {
    const entries = await fs.readdir(path.join(tablePath, 'data'), { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.parquet'))
  } catch {
    return []
  }
}

function makeBuf() {
  let buf = ''
  return {
    write(chunk) { buf += String(chunk) },
    text() { return buf },
  }
}
