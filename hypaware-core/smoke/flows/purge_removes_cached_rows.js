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
import { appendRowsToSourceTable, readCursorSync } from '../../../src/core/cache/partition.js'

/**
 * @import { ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 */

const DATASET = 'purge_smoke_rows'
/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'timestamp', type: 'STRING', nullable: true },
]

/**
 * Hermetic smoke for `hyp purge` (LLP 0104 / plan T3). Seeds a source-table
 * cache partition spanning two sessions, then drives the REAL CLI
 * (`hyp purge --session <id> --yes`) through the dispatcher and proves, over
 * the REAL query engine, that:
 *
 *   - the purged session's rows are gone from `hyp query` results;
 *   - the other session's rows survive;
 *   - the partition cursor's `rowCount` drops to the live count;
 *   - a second identical purge is a no-op (idempotent, durable — the deletes
 *     don't resurrect), so the query result is unchanged.
 *
 * This is the query-visible half of LLP 0104; the watermark/part_id
 * invariants are covered deterministically in `test/core/purge-command.test.js`.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0104 [tests]: purged rows disappear from query results through the real `hyp purge` CLI; survivors and idempotency hold
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('purge_removes_cached_rows: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')
  }

  /** @param {string} name */
  const stepBag = (name) => ({
    [Attr.COMPONENT]: 'smoke',
    [Attr.OPERATION]: 'step',
    [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: name,
    [Attr.DEV_RUN_ID]: harness.devRunId,
    status: 'ok',
  })
  /**
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const step = (name, fn) => runRoot(`smoke.step.${name}`, stepBag(name), fn)

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const repoKeep = path.join(harness.tmpDir, 'keep-repo')
  const repoPurge = path.join(harness.tmpDir, 'purge-repo')

  // ----- setup: register the fixture dataset so `hyp query` can read it -----
  await step('setup', async () => {
    const pluginDir = path.join(harness.tmpDir, 'plugins', 'purge-fixture')
    await writeFixturePlugin(pluginDir)
    const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
    await fs.mkdir(tmpRoot, { recursive: true })
    const { loaded } = await loadManifests([pluginDir])
    const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir }))
    const result = await activatePlugins({
      plugins: entries,
      stateRoot: harness.stateDir,
      runId: harness.devRunId,
      runtime: kernel,
      tmpRoot,
    })
    for (const r of result.results) {
      if (!r.ok) throw new Error(`activate ${r.plugin.name} failed (${r.errorKind}): ${r.message}`)
    }
  })

  // ----- seed: two sessions, one source-table partition (cursor written) -----
  const partitionDir = path.join(cacheRoot, 'datasets', DATASET, 'source=claude')
  await step('seed_rows', async () => {
    await appendRowsToSourceTable(cacheRoot, DATASET, ['source=claude'], COLUMNS, [
      { session_id: 'keep', cwd: repoKeep, part_id: 'k1#0', timestamp: '2026-07-01T00:00:00Z' },
      { session_id: 'keep', cwd: repoKeep, part_id: 'k2#0', timestamp: '2026-07-01T00:00:01Z' },
      { session_id: 'gone', cwd: repoPurge, part_id: 'g1#0', timestamp: '2026-07-01T00:00:02Z' },
    ])
    expect.that('seed: cursor rowCount is 3', readCursorSync(partitionDir).rowCount, (v) => v === 3)
  })

  /** @param {string} sql */
  const queryCount = async (sql) => {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(
      ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
      { stdout, stderr, kernel, registry }
    )
    expect.that(`query "${sql}" exited 0`, code, (v) => v === 0)
    expect.that(`query "${sql}" had no stderr`, stderr.text(), (v) => v.length === 0)
    return JSON.parse(stdout.text())
  }

  // ----- before: all 3 rows are queryable -----
  await step('query_before', async () => {
    const rows = await queryCount(`select part_id from ${DATASET} order by part_id`)
    expect.that('before: query returns all 3 rows', rows.map((/** @type {any} */ r) => r.part_id), (v) => JSON.stringify(v) === JSON.stringify(['g1#0', 'k1#0', 'k2#0']))
  })

  // ----- purge: the REAL CLI, non-interactive with --yes -----
  await step('purge', async () => {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(['purge', '--session', 'gone', '--yes'], {
      stdout, stderr, kernel, registry, env: process.env,
    })
    expect.that('purge: exited 0', code, (v) => v === 0)
    expect.that('purge: reports 1 row deleted', stdout.text(), (v) => /purged 1 row /.test(v))
  })

  // ----- after: the purged session is gone, the other survives -----
  await step('query_after', async () => {
    const rows = await queryCount(`select part_id from ${DATASET} order by part_id`)
    expect.that('after: only the two keep rows remain', rows.map((/** @type {any} */ r) => r.part_id), (v) => JSON.stringify(v) === JSON.stringify(['k1#0', 'k2#0']))
    expect.that('after: cursor rowCount dropped to 2', readCursorSync(partitionDir).rowCount, (v) => v === 2)
  })

  // ----- idempotent + durable: re-purge deletes nothing, no resurrection -----
  await step('repurge_noop', async () => {
    const stdout = makeBuf()
    const code = await dispatch(['purge', '--session', 'gone', '--yes'], {
      stdout, stderr: makeBuf(), kernel, registry, env: process.env,
    })
    expect.that('repurge: exited 0', code, (v) => v === 0)
    expect.that('repurge: deletes 0 rows', stdout.text(), (v) => /purged 0 rows/.test(v))
    const rows = await queryCount(`select part_id from ${DATASET} order by part_id`)
    expect.that('repurge: query still shows exactly the two keep rows', rows.map((/** @type {any} */ r) => r.part_id), (v) => JSON.stringify(v) === JSON.stringify(['k1#0', 'k2#0']))
  })

  await obs.shutdown()

  // ----- telemetry: purge.result logged with the deleted-row count -----
  await step('assert_telemetry', async () => {
    const logs = await expect.logs()
    const results = logs.filter((/** @type {any} */ l) => l.body === 'purge.result')
    expect.that('logs: purge.result fired for both purge runs', results, (v) => Array.isArray(v) && v.length === 2)
    expect.that('logs: first purge.result reports 1 row deleted', results[0]?.attributes?.rows_deleted, (v) => v === 1)
    expect.that('logs: second purge.result reports 0 rows deleted', results[1]?.attributes?.rows_deleted, (v) => v === 0)
  })
}

/** @param {string} dir */
async function writeFixturePlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/purge-fixture',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(dir, 'index.js'), fixturePluginSource())
}

function fixturePluginSource() {
  return `// auto-generated by purge_removes_cached_rows smoke
import fs from 'node:fs'
import path from 'node:path'

const DATASET = '${DATASET}'
const COLUMNS = ${JSON.stringify(COLUMNS)}

let activatedStorage = null

const dataset = {
  name: DATASET,
  plugin: '@hypaware/purge-fixture',
  schema: { columns: COLUMNS },
  discoverPartitions(ctx) {
    const cacheDir = ctx.cacheDir ?? activatedStorage?.cacheRoot ?? ''
    const base = cacheDir ? path.join(cacheDir, 'datasets', DATASET) : ''
    const parts = []
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '_hypaware_spool') continue
        parts.push({ dataset: DATASET, partition: { partition: entry.name }, tablePath: path.join(base, entry.name) })
      }
    } catch {}
    if (parts.length === 0) parts.push({ dataset: DATASET, partition: { partition: 'all' }, tablePath: base ? path.join(base, 'all') : '' })
    return parts
  },
  async createDataSource(partitions, ctx) {
    for (const partition of partitions) {
      if (!partition.tablePath) continue
      const source = await ctx.storage.dataSourceForTable(partition.tablePath)
      // numRows is 'undefined' (unknown) once a table carries position-deletes
      // (the post-purge state), so treat undefined as "has rows" and only skip
      // a source that is definitely empty (numRows === 0).
      if (source && source.numRows !== 0) return source
    }
    return { columns: COLUMNS.map((c) => c.name), numRows: 0, scan() { return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} } } }
  },
}

export async function activate(ctx) {
  activatedStorage = ctx.storage
  ctx.query.registerDataset(dataset)
}
`
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
