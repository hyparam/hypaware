// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'
import { createBackfillSweepDriver } from '../../../src/core/daemon/backfill_sweep.js'
import { runBackfillProvider } from '../../../src/core/commands/backfill.js'

/**
 * LLP 0173 T12 smoke: OpenClaw Lane B sweep -> quiesce filter -> dedupe.
 *
 * Boots `@hypaware/ai-gateway` + `@hypaware/openclaw` against a tmp
 * `HYP_HOME` with two staged OpenClaw v3 session fixtures under the fake
 * HOME's `.openclaw/agents/main/sessions/`, both in the nested-`message`-
 * envelope shape PR #552's reader (`session_file.js`) projects, and drives
 * `src/core/daemon/backfill_sweep.js`'s real `createBackfillSweepDriver`
 * (the same driver `runTick()` wires into the daemon's sink-tick cadence,
 * LLP 0172#lane-b-sweep) directly against this boot's own
 * `kernel.backfills` / `kernel.backfillMaterializers` / `kernel.storage`,
 * so a sweep-written row and a `hyp query`-read row land in and come from
 * the exact same tables `hyp backfill openclaw` would use.
 *
 * Asserts the three properties LLP 0173's T12 brief names:
 *
 *  - **(a) quiesce skip**: a session file whose mtime is inside the
 *    default 180000ms quiesce window (LLP 0172#45-the-quiesce-window) is
 *    absent from the sweep's first tick.
 *  - **(b) quiesce capture**: a session file backdated past the window is
 *    captured by that same tick, with native message identity.
 *  - **(c) cross-write dedupe**: a second sweep tick (a fresh `now`, so the
 *    ai-gateway materializer's dedupe gets its own `devRunId` and is
 *    forced to re-scan committed partitions rather than reuse an
 *    in-memory seen set) finds the first tick's part_ids already
 *    committed and writes ZERO new rows. R11's identity-convergence
 *    argument (`openclaw/src/backfill.js`'s own module doc) is exactly
 *    that Lane A (live) and Lane B (backfill) land on the same
 *    `part_id` for the same turn, so the dedupe this proves for two
 *    sweep ticks is indistinguishable, at the write layer, from "a
 *    live-lane row already wrote it before the sweep ran."
 *
 * The sweep's own `now` is chosen to land on OpenClaw's default
 * `sweep.cron` (every 5th minute) so this exercises the real `cronMatches`
 * due-check (`src/core/sinks/driver.js`, imported by the sweep driver),
 * not a `force: true` bypass: this is the only automated coverage, of any
 * tier, for the sweep driver's `cronMatches` wiring and the quiesce
 * filter's composition with it before the human acceptance run
 * (LLP 0173's "hermetic-smoke decision" section, LLP 0172 Section 9).
 *
 * @ref LLP 0172#45-the-quiesce-window [tests]: a file inside the default
 * quiesce window is skipped, one backdated past it is captured
 * @ref LLP 0172#lane-b-sweep [tests]: the sweep driver fires the due,
 * sweep-bearing provider through the real `cronMatches` due-check
 * @ref LLP 0161#backfill-provider [tests]: native message identity makes a
 * sweep-then-rerun (standing in for Lane A already having written the same
 * part_id) net zero new rows
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'backfill_openclaw_fixture: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const pluginDirs = [
    path.join(pluginsRoot, 'ai-gateway'),
    path.join(pluginsRoot, 'openclaw'),
  ]

  // The OpenClaw provider captures its `agents/` root from `ctx.env.HOME`
  // (-> `<HOME>/.openclaw/agents`, `session_file.js`'s
  // `defaultOpenclawAgentsDir`) at activation, so stage both session
  // fixtures and point HOME at the fake home BEFORE activating plugins.
  const fakeHome = path.join(harness.tmpDir, 'home')
  const agentsDir = path.join(fakeHome, '.openclaw', 'agents')
  const agentId = 'main'

  const freshSessionId = `oc-fresh-${harness.devRunId}`
  const oldSessionId = `oc-old-${harness.devRunId}`

  // Inside the quiesce window: a freshly-written file, left untouched, sits
  // well inside the default 180000ms window for the whole duration of this
  // smoke.
  await writeOpenclawSession({ agentsDir, agentId, sessionId: freshSessionId })
  // Outside the quiesce window: back-dated 4 minutes, mirroring
  // `test/plugins/openclaw-backfill.test.js`'s own default-quiesce-window
  // precedent (`ageFile`, 4 * 60 * 1000 against the real 180000ms default).
  const oldFilePath = await writeOpenclawSession({ agentsDir, agentId, sessionId: oldSessionId })
  await ageFile(oldFilePath, 4 * 60 * 1000)

  const previousHome = process.env.HOME
  process.env.HOME = fakeHome

  try {
    await runRoot(
      'kernel.boot',
      {
        [Attr.COMPONENT]: 'kernel',
        [Attr.OPERATION]: 'boot',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'sweep_activate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded } = await loadManifests(pluginDirs)
        if (loaded.length !== pluginDirs.length) {
          throw new Error(`backfill_openclaw_fixture: expected ${pluginDirs.length} manifests, got ${loaded.length}`)
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `backfill_openclaw_fixture: unsatisfied requirements: ${
              resolution.unsatisfied.map((u) => `${u.plugin}:${u.errorKind}`).join(', ')
            }`
          )
        }
        const byName = new Map(loaded.map((l) => [l.manifest.name, l]))
        const entries = resolution.order
          .map((name) => byName.get(name))
          .filter((l) => l !== undefined)
          .map((l) => ({ manifest: l.manifest, rootDir: l.rootDir, config: {} }))
        return activatePlugins({
          plugins: entries,
          stateRoot: harness.stateDir,
          runId: harness.devRunId,
          runtime: kernel,
          tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
        })
      }
    )

    const env = { ...process.env, HYP_HOME: harness.hypHome }

    // The sweep driver itself, wired exactly the way the daemon wires it
    // (`src/core/daemon/backfill_sweep.js`'s own doc), reusing this boot's
    // `kernel.backfills` / `kernel.backfillMaterializers` / `kernel.storage`.
    /** @type {Array<Promise<any>>} */
    const pendingRuns = []
    const sweep = createBackfillSweepDriver({
      backfills: kernel.backfills,
      backfillMaterializers: kernel.backfillMaterializers,
      storage: kernel.storage,
      query: kernel.query,
      env,
      config: { version: 2 },
      // Test seam (`src/core/daemon/types.d.ts`'s `BackfillSweepRunner`):
      // `tick()` fires this fire-and-forget internally and resolves once
      // runs are STARTED, not finished, so the smoke needs its own handle
      // on the underlying promise to await completion before it queries or
      // reruns. Still the real `runBackfillProvider`, just with its
      // promise captured on the way out.
      runBackfill: (/** @type {any} */ args) => {
        const p = runBackfillProvider(args)
        pendingRuns.push(p)
        return p
      },
    })

    /**
     * Run one sweep tick and await every run it fired.
     *
     * @param {Date} now
     */
    async function tickAndAwait(now) {
      pendingRuns.length = 0
      const report = await sweep.tick({ now })
      const results = await Promise.all(pendingRuns)
      return { report, result: results[0] }
    }

    // A UTC-minute-0 instant is due against OpenClaw's default `sweep.cron`
    // (every 5th minute): real `cronMatches`, not a `force: true` bypass.
    const tick1Now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
    // A later due instant, still on the 5-minute grid, so the second tick
    // gets its own `devRunId` and the ai-gateway materializer's
    // `createBackfillDedupe` (memoized per `devRunId`) is forced to
    // re-scan committed partitions rather than reuse tick 1's in-memory
    // seen set.
    const tick2Now = new Date(tick1Now.getTime() + 5 * 60 * 1000)

    // ----- 1. First sweep tick: quiesce skip + quiesce capture ((a)/(b)) -----
    const tick1 = await tickAndAwait(tick1Now)
    expect.that(
      'tick 1: the openclaw provider fired',
      tick1.report.fired,
      (v) => Array.isArray(v) && v.includes('openclaw'),
    )
    expect.that(
      'tick 1: exactly one session file scanned (only the one outside the quiesce window)',
      tick1.result,
      (v) => v !== undefined && v.ok === true && v.scanned === 1,
    )
    expect.that(
      'tick 1: both rows of the outside-window session were written',
      tick1.result,
      (v) => v !== undefined && v.rowsWritten === 2,
    )

    /** @param {string} sessionId */
    const sqlFor = (sessionId) => `
      select role, content_text, message_id, part_id, provider, conversation_source, client_name
      from ai_gateway_messages
      where session_id = '${sessionId}'
      order by message_index, part_index
    `.trim().replace(/\s+/g, ' ')

    const freshRowsAfterTick1 = await queryRows({
      dispatch, sql: sqlFor(freshSessionId), kernel, registry, env, expect, label: 'fresh session after tick 1',
    })
    expect.that(
      '(a) a file with mtime inside the quiesce window is skipped by the sweep run',
      freshRowsAfterTick1,
      (v) => Array.isArray(v) && v.length === 0,
    )

    const oldRowsAfterTick1 = await queryRows({
      dispatch, sql: sqlFor(oldSessionId), kernel, registry, env, expect, label: 'old session after tick 1',
    })
    expect.that(
      '(b) a file with mtime outside the quiesce window is captured by the sweep run',
      oldRowsAfterTick1,
      (v) => Array.isArray(v) && v.length === 2,
    )
    expect.that(
      '(b) every captured row carries native identity and the right client/source',
      oldRowsAfterTick1,
      (v) => Array.isArray(v) && v.every(
        (/** @type {any} */ r) => r.conversation_source === 'openclaw' && r.client_name === 'openclaw' &&
          r.provider === 'anthropic' && typeof r.message_id === 'string' && r.message_id.length > 0,
      ),
    )

    // ----- 2. Second sweep tick: cross-write dedupe (c) -----
    const tick2 = await tickAndAwait(tick2Now)
    expect.that(
      'tick 2: the openclaw provider fired again',
      tick2.report.fired,
      (v) => Array.isArray(v) && v.includes('openclaw'),
    )
    expect.that(
      '(c) rerunning the sweep after the part_id was already written nets zero new rows',
      tick2.result,
      (v) => v !== undefined && v.ok === true && v.rowsWritten === 0,
    )

    const oldRowsAfterTick2 = await queryRows({
      dispatch, sql: sqlFor(oldSessionId), kernel, registry, env, expect, label: 'old session after tick 2',
    })
    expect.that(
      '(c) the rerun did not duplicate rows (still exactly two)',
      oldRowsAfterTick2,
      (v) => Array.isArray(v) && v.length === 2,
    )
    expect.that(
      '(c) the rerun\'s row set is byte-identical to tick 1\'s (same part_ids, no drift)',
      oldRowsAfterTick2,
      (v) => Array.isArray(v) &&
        JSON.stringify(v.map((/** @type {any} */ r) => r.part_id).sort()) ===
          JSON.stringify(oldRowsAfterTick1.map((/** @type {any} */ r) => r.part_id).sort()),
    )

    const freshRowsAfterTick2 = await queryRows({
      dispatch, sql: sqlFor(freshSessionId), kernel, registry, env, expect, label: 'fresh session after tick 2',
    })
    expect.that(
      '(c) the still-quiesced session remains untouched by the rerun',
      freshRowsAfterTick2,
      (v) => Array.isArray(v) && v.length === 0,
    )

    // ----- 3. Internal telemetry: the sweep driver's own log lines, distinct
    //          from `hyp backfill`'s CLI-path logs, prove this ran through
    //          the daemon-facing driver (T9's cronMatches wiring), not just
    //          the provider underneath it. -----
    await obs.shutdown()
    const logs = await expect.logs()

    const dueLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'backfill.sweep_due' && l.attributes?.provider === 'openclaw',
    )
    expect.that(
      'logs: backfill.sweep_due fired once per due tick (twice total)',
      dueLogs,
      (v) => Array.isArray(v) && v.length === 2,
    )

    const finishedLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'backfill.sweep_finished' && l.attributes?.provider === 'openclaw',
    )
    expect.that(
      'logs: backfill.sweep_finished (tick 1) reports rows_written=2',
      finishedLogs.find((/** @type {any} */ l) => l.attributes?.rows_written === 2),
      (v) => v !== undefined,
    )
    expect.that(
      'logs: backfill.sweep_finished (tick 2) reports rows_written=0',
      finishedLogs.find((/** @type {any} */ l) => l.attributes?.rows_written === 0),
      (v) => v !== undefined,
    )

    const scanCompleteLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'openclaw.backfill.scan_complete',
    )
    expect.that(
      'logs: openclaw.backfill.scan_complete (tick 1) saw one file, past the quiesce filter',
      scanCompleteLogs[0],
      (v) => v !== undefined && v.attributes?.files_seen === 1 && v.attributes?.sessions_projected === 1,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

/**
 * Write one minimal OpenClaw v3 session JSONL under
 * `<agentsDir>/<agentId>/sessions/<sessionId>.jsonl`: a `type: "session"`
 * header line and one user/assistant turn in the nested-`message`-envelope
 * shape PR #552's reader (`session_file.js`'s `parseOpenclawSessionMessage`
 * / `openclawMessageEnvelope`) actually projects - `role`/`content` and,
 * on the assistant turn, `model`/`provider`/`api`/`stopReason`/`usage`
 * nested under the record's own `message` object, never flat on the
 * record line (a flat fixture would test the reader's now-fixed #543 bug,
 * not its fix). No `cwd` on the header: an absent `cwd` reads as "not
 * usable" (`openclawSessionCwd`) and the session is simply not
 * usage-policy gated, which keeps this fixture independent of the host's
 * real filesystem beyond the temp tree it writes.
 *
 * @param {{ agentsDir: string, agentId: string, sessionId: string }} args
 * @returns {Promise<string>}
 */
async function writeOpenclawSession(args) {
  const { agentsDir, agentId, sessionId } = args
  const dir = path.join(agentsDir, agentId, 'sessions')
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  const startedAt = new Date().toISOString()
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: startedAt }),
    JSON.stringify(messageLine({
      id: `${sessionId}-user`,
      timestamp: startedAt,
      role: 'user',
      content: [{ type: 'text', text: 'list the files' }],
    })),
    JSON.stringify(messageLine({
      id: `${sessionId}-asst`,
      timestamp: startedAt,
      parentId: `${sessionId}-user`,
      role: 'assistant',
      content: [{ type: 'text', text: 'here they are' }],
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      api: 'anthropic-messages',
      stopReason: 'end_turn',
      usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 },
    })),
  ]
  await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8')
  return filePath
}

/**
 * One `type: "message"` line in the shape OpenClaw actually appends: `id`,
 * `parentId`, and `timestamp` on the record line, and every message field
 * nested under `message`. Mirrors `test/plugins/openclaw-backfill.test.js`'s
 * own `messageLine` helper, verified there against a live install (record
 * keys `['id', 'message', 'parentId', 'timestamp', 'type']`).
 *
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
function messageLine(fields) {
  const { id, timestamp, parentId, ...message } = fields
  return {
    type: 'message',
    ...(id !== undefined ? { id } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    parentId: parentId ?? null,
    message: { ...message, ...(timestamp !== undefined ? { timestamp } : {}) },
  }
}

/**
 * Back-date `filePath`'s mtime by `msAgo` milliseconds, so a quiesce-window
 * scenario can control file recency without waiting on the wall clock.
 *
 * @param {string} filePath
 * @param {number} msAgo
 */
async function ageFile(filePath, msAgo) {
  const past = new Date(Date.now() - msAgo)
  await fs.utimes(filePath, past, past)
}

/**
 * Run a `query sql ... --format json` dispatch and return the parsed rows,
 * asserting a clean exit and parseable output.
 *
 * @param {{ dispatch: any, sql: string, kernel: any, registry: any, env: any, expect: any, label: string }} args
 * @returns {Promise<any[]>}
 */
async function queryRows(args) {
  const { dispatch: doDispatch, sql, kernel, registry, env, expect, label } = args
  const out = makeBuf()
  const err = makeBuf()
  const code = await doDispatch(
    ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
    { stdout: out, stderr: err, kernel, registry, env }
  )
  expect.that(`dispatch: query (${label}) exited 0`, code, (/** @type {number} */ v) => v === 0)
  expect.that(`stderr: query (${label}) had no errors`, err.text(), (/** @type {string} */ v) => typeof v === 'string' && v.length === 0)
  try {
    return JSON.parse(out.text())
  } catch (e) {
    expect.that(
      `stdout: query (${label}) was valid JSON (${e instanceof Error ? e.message : String(e)})`,
      false,
      (/** @type {boolean} */ v) => v === true,
    )
    return []
  }
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
