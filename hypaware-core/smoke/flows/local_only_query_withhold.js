// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * @import { ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 */

const DATASET = 'local_only_smoke_rows'
/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'msg', type: 'STRING', nullable: false },
]

/**
 * Hermetic leak-closure smoke for the LLP 0105 query-seam visibility filter
 * (enrollment-privacy-review task T4), modeled on
 * `local_only_export_withhold.js` but driving the REAL `hyp query sql` CLI
 * (the same verb the MCP tool projects) with different caller working
 * directories.
 *
 * The transcript leak this closes: a query run inside a captured session
 * whose `cwd` is synced returns `local-only` rows as tool results, and the
 * transcript itself then exports them around the export seam. So:
 *
 * @ref LLP 0105 [tests]: from a synced caller cwd the local-only rows are
 *   absent from stdout and the withheld count is reported on stderr, through
 *   the real CLI dispatch -> verb -> executeQuerySql path.
 * @ref LLP 0105#test [tests]: from the local-only directory itself the same
 *   query returns everything (a never-exported transcript loses nothing).
 * @ref LLP 0105#override [tests]: `--include-local-only` restores the rows
 *   from the synced context.
 *
 * Also asserts COUNT(*) honors the filter (the numRows fast path cannot
 * count withheld rows) and that `usage_policy.query_withhold` telemetry
 * fired with counts only.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'local_only_query_withhold: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  /**
   * @param {string} name
   * @returns {Record<string, string>}
   */
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

  const fixtureDir = path.join(harness.tmpDir, 'plugins', 'test-local-only-rows')
  await writeFixturePlugin(fixtureDir)
  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  /**
   * Run one CLI invocation from a given caller directory.
   * @param {string[]} argv
   * @param {string} cwd
   */
  const cli = async (argv, cwd) => {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(argv, {
      stdout,
      stderr,
      kernel,
      registry,
      env: process.env,
      cwd,
    })
    return { code, stdout: stdout.text(), stderr: stderr.text() }
  }

  const SQL = `SELECT id, msg FROM ${DATASET} ORDER BY id`

  // ----- smoke_step: setup (activate the fixture dataset, make the cwds) -----
  const { cleanCwd, excludedCwd } = await step('setup', async () => {
    const { loaded, failed } = await loadManifests([fixtureDir])
    if (failed.length > 0) {
      throw new Error(
        `local_only_query_withhold: manifest failures - ${
          failed.map((f) => `${f.manifestPath}: ${f.message}`).join('; ')
        }`
      )
    }
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

    const cleanCwd = path.join(harness.tmpDir, 'clean-repo')
    const excludedCwd = path.join(harness.tmpDir, 'excluded-repo')
    await fs.mkdir(cleanCwd, { recursive: true })
    await fs.mkdir(excludedCwd, { recursive: true })
    return { cleanCwd, excludedCwd }
  })

  // ----- smoke_step: mark_local_only (the durable CLI, LLP 0072#cli) -----
  await step('mark_local_only', async () => {
    const r = await cli(['ignore', '--local-only', excludedCwd], cleanCwd)
    expect.that('cli: hyp ignore --local-only exited 0', r.code, (v) => v === 0)
    expect.that(
      'cli: hyp ignore --local-only confirms the added directory',
      r.stdout,
      (v) => v.includes('added') && v.includes(excludedCwd)
    )
  })

  // ----- smoke_step: seed_rows (two cwds, one dataset) -----
  await step('seed_rows', async () => {
    const tablePath = kernel.storage.cacheTablePath(DATASET)
    await kernel.storage.appendRows(tablePath, COLUMNS, [
      { id: 1n, cwd: cleanCwd, msg: `clean-1-${harness.devRunId}` },
      { id: 2n, cwd: cleanCwd, msg: `clean-2-${harness.devRunId}` },
      { id: 3n, cwd: excludedCwd, msg: `excluded-1-${harness.devRunId}` },
      { id: 4n, cwd: excludedCwd, msg: `excluded-2-${harness.devRunId}` },
    ])
    await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed' })
  })

  // ----- smoke_step: query_synced_context (the leak is closed) -----
  await step('query_synced_context', async () => {
    const r = await cli(['query', 'sql', SQL, '--json'], cleanCwd)
    expect.that('synced: hyp query sql exited 0', r.code, (v) => v === 0)
    /** @type {any[]} */
    const rows = JSON.parse(r.stdout)
    expect.that('synced: only the 2 clean rows are visible', rows.length, (v) => v === 2)
    expect.that(
      'synced: every visible row is a clean one',
      rows,
      (v) => v.every((row) => String(row.msg).startsWith('clean-'))
    )
    expect.that(
      'synced: no local-only content leaks into stdout',
      r.stdout.includes('excluded-'),
      (v) => v === false
    )
    expect.that(
      'synced: the withheld count is reported on stderr (never the content)',
      r.stderr,
      (v) => v.includes('local-only: withheld 2 row(s)') && !v.includes('excluded-')
    )
    expect.that(
      'synced: the stderr notice names the override',
      r.stderr,
      (v) => v.includes('--include-local-only')
    )
  })

  // ----- smoke_step: query_count (the numRows fast path cannot leak a count) -----
  await step('query_count', async () => {
    const r = await cli(['query', 'sql', `SELECT COUNT(*) AS n FROM ${DATASET}`, '--json'], cleanCwd)
    expect.that('count: hyp query sql exited 0', r.code, (v) => v === 0)
    const rows = JSON.parse(r.stdout)
    expect.that('count: COUNT(*) sees only the visible rows', Number(rows[0]?.n), (v) => v === 2)
  })

  // ----- smoke_step: query_private_context (a local-only caller loses nothing) -----
  await step('query_private_context', async () => {
    const r = await cli(['query', 'sql', SQL, '--json'], excludedCwd)
    expect.that('private: hyp query sql exited 0', r.code, (v) => v === 0)
    /** @type {any[]} */
    const rows = JSON.parse(r.stdout)
    expect.that('private: all 4 rows are visible from the local-only cwd', rows.length, (v) => v === 4)
    expect.that(
      'private: nothing was withheld, so stderr carries no local-only notice',
      r.stderr.includes('local-only:'),
      (v) => v === false
    )
  })

  // ----- smoke_step: query_override (informed consent restores the rows) -----
  await step('query_override', async () => {
    const r = await cli(['query', 'sql', SQL, '--include-local-only', '--json'], cleanCwd)
    expect.that('override: hyp query sql exited 0', r.code, (v) => v === 0)
    /** @type {any[]} */
    const rows = JSON.parse(r.stdout)
    expect.that('override: --include-local-only restores all 4 rows', rows.length, (v) => v === 4)
    expect.that(
      'override: no withheld notice when nothing was withheld',
      r.stderr.includes('local-only:'),
      (v) => v === false
    )
  })

  await obs.shutdown()

  // ----- smoke_step: assert_telemetry (counts only, never content) -----
  await step('assert_telemetry', async () => {
    const logs = await expect.logs()
    const withholds = logs.filter((/** @type {any} */ l) => l.body === 'usage_policy.query_withhold')
    expect.that('logs: usage_policy.query_withhold fired for the filtered queries', withholds, (v) => Array.isArray(v) && v.length >= 1)
    expect.that(
      'logs: the withhold events carry counts and caller class, never content',
      withholds,
      (v) => v.every((/** @type {any} */ l) =>
        l.attributes?.withheld_row_count !== undefined &&
        l.attributes?.caller_usage_class === 'full' &&
        !JSON.stringify(l.attributes).includes('excluded-')
      )
    )
  })
}

/** @param {string} dir */
async function writeFixturePlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/test-local-only-rows',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(dir, 'index.js'), fixturePluginSource())
}

function fixturePluginSource() {
  return `// auto-generated by local_only_query_withhold smoke; fixture: @hypaware/test-local-only-rows
import fs from 'node:fs'
import path from 'node:path'

const DATASET = '${DATASET}'
const COLUMNS = ${JSON.stringify(COLUMNS)}

let activatedStorage = null

const dataset = {
  name: DATASET,
  plugin: '@hypaware/test-local-only-rows',
  schema: { columns: COLUMNS },
  primaryTimestampColumn: undefined,
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
    if (parts.length === 0) {
      parts.push({ dataset: DATASET, partition: { partition: 'all' }, tablePath: base ? path.join(base, 'all') : '' })
    }
    return parts
  },
  async createDataSource(partitions, ctx) {
    for (const partition of partitions) {
      if (!partition.tablePath) continue
      const source = await ctx.storage.dataSourceForTable(partition.tablePath)
      if (source && (source.numRows ?? 0) > 0) return source
    }
    return emptySource()
  },
}

function emptySource() {
  return {
    columns: COLUMNS.map((c) => c.name),
    numRows: 0,
    scan() {
      return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} }
    },
  }
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
