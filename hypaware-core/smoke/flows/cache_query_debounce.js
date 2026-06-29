// @ts-check

import path from 'node:path'

import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { installObservability } from '../../../src/core/observability/index.js'

/**
 * @import { ColumnSpec } from '../../../collectivus-plugin-kernel-types.js'
 * @import { KernelRuntime } from '../../../src/core/runtime/types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 */

const DATASET = 'debounce_rows'
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
  await kernel.storage.appendRows(tablePath, COLUMNS, [{ id: 1n, value: 'committed' }])
  await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed' })
  await kernel.storage.appendRows(tablePath, COLUMNS, [{ id: 2n, value: 'pending' }])

  const auto = await runSql(kernel, registry, 'auto')
  expect.that('auto query: exited 0', auto.code, (v) => v === 0)
  expect.that(
    'auto query: debounce message emitted to stderr',
    auto.stderr,
    (v) => typeof v === 'string' && /cache: last write to query cache was \d+ minutes ago/.test(v)
  )
  expect.that(
    'auto query: pending row is not included during debounce',
    JSON.parse(auto.stdout)?.[0]?.n,
    (v) => Number(v) === 1
  )

  const always = await runSql(kernel, registry, 'always')
  expect.that('always query: exited 0', always.code, (v) => v === 0)
  expect.that('always query: no debounce stderr', always.stderr, (v) => v === '')
  expect.that(
    'always query: forced refresh includes pending row',
    JSON.parse(always.stdout)?.[0]?.n,
    (v) => Number(v) === 2
  )

  await obs.shutdown()
}

/**
 * @param {ReturnType<typeof createKernelRuntime>} kernel
 * @param {ReturnType<typeof createCommandRegistry>} registry
 * @param {'auto'|'always'} refresh
 */
async function runSql(kernel, registry, refresh) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(
    ['query', 'sql', `select count(*) as n from ${DATASET}`, '--refresh', refresh, '--format', 'json'],
    { stdout, stderr, kernel, registry }
  )
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

/** @param {KernelRuntime} kernel */
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
      if (partMetas.length > 0) {
        const sources = []
        for (const m of partMetas) {
          const source = await storage.dataSourceForTable(m.path)
          if (source) sources.push(source)
        }
        if (sources.length === 1) return sources[0]
        if (sources.length > 1) {
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
        }
      }
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

function makeBuf() {
  let buf = ''
  return {
    write(chunk) { buf += String(chunk) },
    text() { return buf },
  }
}
