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
 * Hermetic end-to-end smoke for `hyp query grep` (LLP 0264 / LLP 0265 T7),
 * driving the REAL CLI dispatch -> verb -> grep service path through both
 * tiers and both privacy gates:
 *
 * 1. scan tier: a fresh, uncompacted cache answers a grep with zero
 *    sidecars anywhere (proved from the `query.grep_search` span).
 * 2. `hyp purge --session` then removes one seeded session and grep can
 *    no longer surface it (position deletes honored on a raw file walk).
 * 3. a forced `maintainCache` compacts and builds sidecars (the pass is
 *    called directly, not through `hyp cache maintain`, because the step
 *    asserts on the sidecar counters in its report); the same
 *    grep now answers from the indexed tier (span: indexed>0, scanned=0),
 *    identically, still without the purged row (the sidecar is newer than
 *    the purge here, but the stale-sidecar case is pinned in unit tests).
 * 4. `hyp query status` reports the index coverage line.
 * 5. LLP 0105: a local-only row's hit is withheld from a synced caller
 *    (count on stderr, never content), visible from the local-only cwd
 *    itself, and restored by `--include-local-only`.
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
    const r = await cli(['ignore', '--local-only', excludedCwd], cleanCwd)
    expect.that('setup: hyp ignore --local-only exited 0', r.code, (v) => v === 0)
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

  // ----- smoke_step: maintain_builds_sidecars -----
  await step('maintain_builds_sidecars', async () => {
    const report = await maintainCache({ cacheRoot, force: true })
    const partition = report.partitions.find((p) => p.dataset === DATASET)
    expect.that('maintain: the gateway partition compacted', partition?.compacted, (v) => v === true)
    expect.that('maintain: the rewrite queued sidecar builds',
      partition?.sidecarsBuilt ?? 0, (v) => v >= 1)
    expect.that('maintain: no sidecar build failed', partition?.sidecarsFailed ?? 0, (v) => v === 0)
  })

  // ----- smoke_step: status_reports_coverage -----
  await step('status_reports_coverage', async () => {
    const r = await cli(['query', 'status'], cleanCwd)
    expect.that('status: hyp query status exited 0', r.code, (v) => v === 0)
    expect.that('status: the grep index coverage line is present',
      r.stdout, (v) => /grep index: \d+ of \d+ data files indexed/.test(v))
    const m = r.stdout.match(/grep index: (\d+) of (\d+) data files indexed/)
    expect.that('status: every data file is indexed after the forced maintain',
      m, (v) => v !== null && v[1] === v[2] && Number(v[1]) >= 1)
  })

  // ----- smoke_step: grep_indexed_tier (same answer, served by sidecars) -----
  await step('grep_indexed_tier', async () => {
    const r = await cli(['query', 'grep', needle, '--format', 'json'], cleanCwd)
    expect.that('indexed: hyp query grep exited 0', r.code, (v) => v === 0)
    /** @type {any[]} */
    const rows = JSON.parse(r.stdout)
    expect.that('indexed: the two visible sessions still hit, purged still absent',
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
    expect.that('spans: a post-maintenance search ran wholly on the indexed tier',
      greps, (v) => v.some((/** @type {any} */ s) =>
        Number(s.attributes?.indexed_file_count) >= 1 && Number(s.attributes?.scanned_file_count) === 0))
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
