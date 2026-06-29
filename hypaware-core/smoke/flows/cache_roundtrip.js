// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'

/**
 * Phase 4 smoke. Stands up the intrinsic Iceberg cache, registers a
 * synthetic `dummy_rows` dataset from a test fixture plugin, writes
 * 100 rows through `ctx.storage.appendRows`, then runs
 * `hyp query sql "select count(*) from dummy_rows" --refresh always
 * --format json` through the dispatcher.
 *
 * Asserts the §Phase 4 contract:
 *
 * - traces: a `cache.append` span with `hyp_dataset=dummy_rows`,
 *   `row_count=100`, and `bytes_written > 0`
 * - traces: a `query.execute_sql` span with `status=ok`
 * - traces: a child `query.scan_dataset` of `query.execute_sql`
 *   tagged `hyp_dataset=dummy_rows`
 * - stdout: the count comes back as 100
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0013#write-path-and-query [tests]: rows written to the cache come back through hyp query
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'cache_roundtrip: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginDir = path.join(harness.tmpDir, 'plugins', 'test-fixture')
  await writeFixturePlugin(pluginDir)

  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  // Activate the fixture plugin against our kernel; the plugin
  // registers `dummy_rows` and appends 100 rows via ctx.storage.
  await runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'boot',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'fixture_activate',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const { loaded } = await loadManifests([pluginDir])
      const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir }))
      return activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
    }
  )

  // Dispatch the SQL through the kernel CLI. Pass the kernel so the
  // dataset and storage we just populated are visible to the
  // dispatcher.
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(
    [
      'query',
      'sql',
      'select count(*) as n from dummy_rows',
      '--refresh',
      'always',
      '--format',
      'json',
    ],
    { stdout, stderr, kernel, registry }
  )
  expect.that('dispatch: query sql exited 0', code, (v) => v === 0)
  expect.that(
    'stderr: query sql had no errors',
    stderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )

  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(stdout.text())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    expect.that(
      `stdout: query sql --format json was valid JSON (parse error: ${message})`,
      false,
      (v) => v === true
    )
    return
  }
  expect.that(
    'stdout: json result is an array with exactly one row',
    parsed,
    (v) => Array.isArray(v) && v.length === 1
  )
  const count = parsed?.[0]?.n
  expect.that(
    'stdout: select count(*) returned 100',
    count,
    (v) => v === 100 || v === '100' || (typeof v === 'bigint' && Number(v) === 100)
  )

  await obs.shutdown()

  const traces = await expect.traces()

  const cacheAppends = traces.filter((t) => t.name === 'cache.append')
  expect.that(
    'traces: at least one cache.append span emitted',
    cacheAppends,
    (rows) => rows.length >= 1
  )
  const dummyAppend = cacheAppends.find((s) => s.attributes?.hyp_dataset === 'dummy_rows')
  expect.that(
    'traces: cache.append for dummy_rows exists',
    dummyAppend,
    (v) => v !== undefined
  )
  expect.that(
    'traces: cache.append for dummy_rows has row_count=100',
    dummyAppend?.attributes?.row_count,
    (v) => v === 100
  )
  expect.that(
    'traces: cache.append for dummy_rows has bytes_written > 0',
    dummyAppend?.attributes?.bytes_written,
    (v) => typeof v === 'number' && v > 0
  )
  expect.that(
    'traces: cache.append status=ok',
    dummyAppend?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: cache.append recorded spooled=true',
    dummyAppend?.attributes?.spooled,
    (v) => v === true
  )

  const cacheFlushes = traces.filter((t) => t.name === 'cache.flush')
  const dummyFlush = cacheFlushes.find((s) => s.attributes?.hyp_dataset === 'dummy_rows')
  expect.that(
    'traces: cache.flush for dummy_rows exists',
    dummyFlush,
    (v) => v !== undefined
  )
  expect.that(
    'traces: cache.flush for dummy_rows has row_count=100',
    dummyFlush?.attributes?.row_count,
    (v) => v === 100
  )
  expect.that(
    'traces: cache.flush for dummy_rows has bytes_written > 0',
    dummyFlush?.attributes?.bytes_written,
    (v) => typeof v === 'number' && v > 0
  )

  const execSpans = traces.filter((t) => t.name === 'query.execute_sql')
  expect.that(
    'traces: exactly one query.execute_sql span',
    execSpans,
    (rows) => rows.length === 1
  )
  const execSpan = execSpans[0]
  expect.that(
    'traces: query.execute_sql status=ok',
    execSpan?.attributes?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: query.execute_sql span.status=ok',
    execSpan?.status,
    (v) => v === 'ok'
  )

  const scanSpans = traces.filter(
    (t) => t.name === 'query.scan_dataset' && t.parentSpanId === execSpan?.spanId
  )
  expect.that(
    'traces: exactly one query.scan_dataset child of query.execute_sql',
    scanSpans,
    (rows) => rows.length === 1
  )
  expect.that(
    'traces: query.scan_dataset has hyp_dataset=dummy_rows',
    scanSpans[0]?.attributes?.hyp_dataset,
    (v) => v === 'dummy_rows'
  )
}

/**
 * Drop a minimal fixture plugin under `dir`. The plugin's `activate()`
 * registers a `dummy_rows` dataset and immediately materializes 100
 * rows via `ctx.storage.appendRows`, exercising both surfaces in
 * one boot. The data source is the Iceberg table itself, so the
 * dispatcher's SQL run scans the same bytes the activation wrote.
 *
 * @param {string} dir
 */
async function writeFixturePlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/test-fixture',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify(manifest, null, 2)
  )
  await fs.writeFile(path.join(dir, 'index.js'), fixturePluginSource())
}

/**
 * The fixture plugin source. Inline-ESM so the smoke does not need a
 * companion file outside the smoke tree.
 */
function fixturePluginSource() {
  return `// auto-generated by cache_roundtrip smoke; fixture: @hypaware/test-fixture
import path from 'node:path'

const DATASET = 'dummy_rows'
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'value', type: 'STRING', nullable: false },
]

let activatedStorage = null

const dataset = {
  name: DATASET,
  plugin: '@hypaware/test-fixture',
  schema: { columns: COLUMNS },
  primaryTimestampColumn: undefined,
  discoverPartitions(ctx) {
    const cacheDir = ctx.cacheDir ?? activatedStorage?.cacheRoot ?? ''
    return [
      {
        dataset: DATASET,
        partition: { partition: 'all' },
        tablePath: cacheDir ? path.join(cacheDir, 'datasets', DATASET, 'all') : '',
      },
    ]
  },
  async createDataSource(partitions, ctx) {
    const partMetas = await ctx.storage.discoverCachePartitions({ datasets: [DATASET] })
    if (partMetas.length === 0) {
      const partition = partitions[0]
      if (!partition || !partition.tablePath) return emptySource()
      const source = await ctx.storage.dataSourceForTable(partition.tablePath)
      return source ?? emptySource()
    }
    const sources = []
    for (const m of partMetas) {
      const source = await ctx.storage.dataSourceForTable(m.path)
      if (source) sources.push(source)
    }
    if (sources.length === 0) return emptySource()
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
}

function emptySource() {
  return {
    columns: COLUMNS.map((c) => c.name),
    numRows: 0,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {},
      }
    },
  }
}

export async function activate(ctx) {
  activatedStorage = ctx.storage
  ctx.query.registerDataset(dataset)
  const tablePath = ctx.storage.cacheTablePath(DATASET)
  const rows = []
  for (let i = 0; i < 100; i++) {
    rows.push({ id: BigInt(i), value: 'v' + i })
  }
  await ctx.storage.appendRows(tablePath, COLUMNS, rows)
}
`
}

/**
 * Minimal capture stream mirroring the one in `command_dispatch.js`.
 * Smoke flows share the convention so assertions stay consistent.
 */
function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
