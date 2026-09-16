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
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { discoverBundledPlugins } from '../../../src/core/runtime/bundled.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { listLiveDataFiles } from '../../../src/core/cache/iceberg/store.js'
import { urlToPath } from '../../../src/core/cache/iceberg/resolver.js'
import { resolveIcebergDir } from '../../../src/core/cache/storage.js'
import { maintainCache } from '../../../src/core/cache/maintenance.js'

/**
 * @import { ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 */

const DATASET = 'ai_gateway_messages'

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'conversation_id', type: 'STRING', nullable: true },
  { name: 'agent_id', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'content_text', type: 'STRING', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
]

/**
 * Hermetic CLI -> plugin verb -> direct scan smoke. Verifies identical
 * results before/after compaction, purge filtering, local-only visibility,
 * absence of generated indexes, and content-free search telemetry.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'query_grep_roundtrip: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
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
  const discovered = await discoverBundledPlugins()
  const grepPlugin = discovered.loaded.find((entry) => entry.manifest.name === '@hypaware/grep')
  if (!grepPlugin) throw new Error('grep plugin was not discovered')
  const activation = await activatePlugins({
    plugins: [grepPlugin], stateRoot: harness.stateDir, runId: harness.devRunId,
    runtime: kernel, tmpRoot: harness.tmpDir,
  })
  expect.that('plugin: grep activated through its manifest', activation.results[0]?.ok, (v) => v === true)

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

  const needle = `grepsmoke_${harness.devRunId}`

  // ----- smoke_step: setup (cwds; one marked local-only) -----
  const { cleanCwd, excludedCwd } = await step('setup', async () => {
    const cleanCwd = path.join(harness.tmpDir, 'clean-repo')
    const excludedCwd = path.join(harness.tmpDir, 'excluded-repo')
    await fs.mkdir(cleanCwd, { recursive: true })
    await fs.mkdir(excludedCwd, { recursive: true })
    const r = await cli(['privacy', 'set', excludedCwd, 'local-only'], cleanCwd)
    expect.that('setup: hyp privacy set <path> local-only exited 0', r.code, (v) => v === 0)
    return { cleanCwd, excludedCwd }
  })

  // ----- smoke_step: seed_rows (three sessions, one local-only) -----
  await step('seed_rows', async () => {
    const tablePath = kernel.storage.cacheTablePath(DATASET)
    /** @param {string} session @param {string} date @param {string} cwd @param {string} text */
    const row = (session, date, cwd, text) => ({
      session_id: session,
      conversation_id: null,
      agent_id: null,
      cwd,
      content_text: text,
      date,
      part_id: `${session}#0`,
      message_id: `${session}-m`,
      message_created_at: new Date(`${date}T12:00:00Z`).getTime(),
      client_name: 'smoke',
    })
    await kernel.storage.appendRows(tablePath, COLUMNS, [
      row('sess-old', '2026-08-01', cleanCwd, `older ${needle} kept`),
      row('sess-new', '2026-08-03', cleanCwd, `newer ${needle} kept`),
      row('sess-purged', '2026-08-02', cleanCwd, `doomed ${needle} purged`),
      row('sess-private', '2026-08-04', excludedCwd, `private ${needle} withheld`),
    ])
    await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed' })
  })

  // ----- smoke_step: grep_scan_tier (correct before any index exists) -----
  await step('grep_scan_tier', async () => {
    const r = await cli(['query', 'grep', needle, '--format', 'json'], cleanCwd)
    expect.that('scan: hyp query grep exited 0', r.code, (v) => v === 0)
    /** @type {any[]} */
    const rows = JSON.parse(r.stdout)
    const sessions = rows.map((row) => row.session_id)
    expect.that('scan: the three visible sessions hit', new Set(sessions),
      (v) => v.has('sess-old') && v.has('sess-new') && v.has('sess-purged'))
    // The seed dates make this exact: sess-new is 2026-08-03, the newest
    // row this caller may see (sess-private is newer but withheld). An
    // either-or here would pass through a one-day sort inversion.
    expect.that('scan: newest visible hit leads', sessions[0], (v) => v === 'sess-new')
    expect.that('scan: the local-only hit is withheld from the synced caller',
      sessions.includes('sess-private'), (v) => v === false)
    expect.that('scan: the withheld count rides stderr, never the content',
      r.stderr, (v) => v.includes('local-only: withheld 1 row(s)') && !v.includes('private '))
  })

  // ----- smoke_step: purge_session (position deletes reach the grep walk) -----
  await step('purge_session', async () => {
    const r = await cli(['purge', '--session', 'sess-purged', '--yes'], cleanCwd)
    expect.that('purge: hyp purge --session exited 0', r.code, (v) => v === 0)
    const after = await cli(['query', 'grep', needle, '--format', 'json'], cleanCwd)
    /** @type {any[]} */
    const rows = JSON.parse(after.stdout)
    expect.that('purge: the purged session cannot surface from grep',
      rows.some((row) => row.session_id === 'sess-purged'), (v) => v === false)
    expect.that('purge: the surviving sessions still hit',
      rows.map((row) => row.session_id).sort(), (v) => JSON.stringify(v) === JSON.stringify(['sess-new', 'sess-old']))
  })

  // ----- smoke_step: maintain_without_indexes -----
  await step('maintain_without_indexes', async () => {
    const report = await maintainCache({ cacheRoot, force: true })
    const partition = report.partitions.find((p) => p.dataset === DATASET)
    expect.that('maintain: the gateway partition compacted', partition?.compacted, (v) => v === true)
    const parts = await kernel.storage.discoverCachePartitions({ datasets: [DATASET] })
    for (const part of parts) {
      for (const file of await listLiveDataFiles(resolveIcebergDir(part.path))) {
        const index = urlToPath(file.filePath).replace(/\.parquet$/, '.index.parquet')
        const exists = await fs.access(index).then(() => true, () => false)
        expect.that('maintain: no index was built', exists, (v) => v === false)
      }
    }
  })

  // ----- smoke_step: status_without_indexes -----
  await step('status_without_indexes', async () => {
    const r = await cli(['query', 'status'], cleanCwd)
    expect.that('status: hyp query status exited 0', r.code, (v) => v === 0)
    expect.that('status: no index coverage is advertised',
      r.stdout.includes('grep index:'), (v) => v === false)
  })

  // ----- smoke_step: grep_after_compaction (same answer, still scanned) -----
  await step('grep_after_compaction', async () => {
    const r = await cli(['query', 'grep', needle, '--format', 'json'], cleanCwd)
    expect.that('compacted: hyp query grep exited 0', r.code, (v) => v === 0)
    /** @type {any[]} */
    const rows = JSON.parse(r.stdout)
    expect.that('compacted: the two visible sessions still hit, purged still absent',
      rows.map((row) => row.session_id).sort(), (v) => JSON.stringify(v) === JSON.stringify(['sess-new', 'sess-old']))
  })

  // ----- smoke_step: grep_private_and_override (LLP 0105 both ways) -----
  await step('grep_private_and_override', async () => {
    const fromPrivate = await cli(['query', 'grep', needle, '--format', 'json'], excludedCwd)
    /** @type {any[]} */
    const privateRows = JSON.parse(fromPrivate.stdout)
    expect.that('private: the local-only caller sees its own row',
      privateRows.some((row) => row.session_id === 'sess-private'), (v) => v === true)

    const withOverride = await cli(['query', 'grep', needle, '--include-local-only', '--format', 'json'], cleanCwd)
    /** @type {any[]} */
    const overrideRows = JSON.parse(withOverride.stdout)
    expect.that('override: --include-local-only restores the withheld hit',
      overrideRows.some((row) => row.session_id === 'sess-private'), (v) => v === true)
    expect.that('override: nothing withheld, so stderr carries no local-only notice',
      withOverride.stderr.includes('local-only:'), (v) => v === false)
  })

  await obs.shutdown()

  // ----- smoke_step: assert_telemetry (the tiers are provable from spans) -----
  // Not wrapped in `step()`: the provider is already shut down, so a span
  // opened here would be dropped rather than recorded, and a smoke_step
  // that never reaches the trace is worse than none.
  {
    const traces = await expect.traces()
    const greps = traces.filter((/** @type {any} */ s) => s.name === 'query.grep_search')
    expect.that('spans: query.grep_search spans were recorded', greps.length, (v) => v >= 3)
    expect.that('spans: an early search ran wholly on the scan tier',
      greps, (v) => v.some((/** @type {any} */ s) =>
        Number(s.attributes?.indexed_file_count) === 0 && Number(s.attributes?.scanned_file_count) >= 1))
    expect.that('spans: every search used scans without indexes',
      greps, (v) => v.every((/** @type {any} */ s) =>
        Number(s.attributes?.indexed_file_count) === 0 && Number(s.attributes?.scanned_file_count) >= 1))
    expect.that('spans: maintenance never ran index work',
      traces.some((/** @type {any} */ s) => s.name === 'maintenance.grep_index'), (v) => v === false)
    expect.that('spans: no span carries the query text, only its shape',
      greps, (v) => v.every((/** @type {any} */ s) =>
        !JSON.stringify(s.attributes ?? {}).includes(needle) && s.attributes?.query_length !== undefined))
  }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    write: (/** @type {string} */ chunk) => {
      chunks.push(chunk)
      return true
    },
    text: () => chunks.join(''),
  }
}
