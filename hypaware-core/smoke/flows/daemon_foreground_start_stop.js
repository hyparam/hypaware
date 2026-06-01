// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { installObservability } from '../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { readStatusFile } from '../../../src/core/daemon/status.js'

/**
 * Phase 3 V1 smoke (finish-v1.md §Phase 3). Boots the daemon under
 * a temp HYP_HOME with `@hypaware/ai-gateway` and `@hypaware/otel`
 * activated, asserts the four bead acceptance criteria, then drives a
 * graceful shutdown and verifies the status file + telemetry.
 *
 * The smoke opts out of OS signal handlers (`installSignalHandlers:
 * false`) and uses `handle.stop()` to simulate SIGTERM — the actual
 * shutdown path is identical, but we avoid trampling the harness
 * process's own SIGTERM handling. Tick interval is set to 0 so the
 * scheduled sink loop never fires (Phase 5 owns sink-driven assertions).
 *
 * Telemetry contract:
 *  - One `daemon.run` root span per run.
 *  - One `kernel.boot` child span inside `daemon.run`.
 *  - One `source.start` span per configured source.
 *  - One `daemon.shutdown` span at shutdown, with `source.stop`
 *    children for every started source.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0017#the-primary-daemon [tests] — boots the daemon, drives start/stop, asserts the lifecycle spans
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'daemon_foreground_start_stop: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  // Stage a v2 config selecting only ai-gateway + otel. ai-gateway
  // does not auto-start in `activate()`; otel does. Together they
  // exercise both branches in the daemon's source-start loop (one
  // already started, one started by the daemon).
  const configPath = defaultConfigPath(harness.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:0',
          upstreams: [
            { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' },
          ],
        },
      },
      {
        name: '@hypaware/otel',
        config: { listen_host: '127.0.0.1', listen_port: 0 },
      },
    ],
    query: { cache: { retention: { default_days: 30 } } },
  }, null, 2))

  process.env.HYP_HOME = harness.hypHome
  process.env.HYP_CONFIG = configPath

  // ----- Boot the daemon -----
  const handle = await runDaemon({
    hypHome: harness.hypHome,
    configPath,
    env: process.env,
    runId: harness.devRunId,
    tickIntervalMs: 0,
    installSignalHandlers: false,
  })

  // ----- 1. Daemon reaches healthy -----
  const live = handle.snapshot()
  expect.that(
    `snapshot: daemon state is healthy (got ${live.state})`,
    live.state,
    (v) => v === 'healthy'
  )
  expect.that(
    'snapshot: pid is the current process',
    live.pid,
    (v) => v === process.pid
  )

  // ----- 2. ai-gateway and otel sources report started -----
  /** @type {Map<string, any>} */
  const sourcesByName = new Map(
    live.sources.map((/** @type {any} */ s) => [s.name, s])
  )
  expect.that(
    `snapshot: source 'ai-gateway' is started (got ${sourcesByName.get('ai-gateway')?.state ?? 'missing'})`,
    sourcesByName.get('ai-gateway')?.state,
    (v) => v === 'started'
  )
  expect.that(
    `snapshot: source 'otlp' is started (got ${sourcesByName.get('otlp')?.state ?? 'missing'})`,
    sourcesByName.get('otlp')?.state,
    (v) => v === 'started'
  )

  // ----- 3. SIGTERM (simulated via handle.stop()) -----
  await handle.stop()
  await handle.done

  // ----- 4. Status file records stopped after shutdown -----
  const stateRoot = path.join(harness.hypHome, 'hypaware')
  const persisted = readStatusFile(stateRoot)
  expect.that(
    'status file: persisted state is stopped',
    persisted?.state,
    (v) => v === 'stopped'
  )
  expect.that(
    'status file: every recorded source ended up stopped',
    persisted?.sources?.map((/** @type {any} */ s) => s.state) ?? [],
    (arr) => Array.isArray(arr) && arr.length >= 2 && arr.every((s) => s === 'stopped')
  )
  expect.that(
    'status file: ai-gateway is among the stopped sources',
    persisted?.sources?.find((/** @type {any} */ s) => s.name === 'ai-gateway')?.state,
    (v) => v === 'stopped'
  )
  expect.that(
    'status file: otlp is among the stopped sources',
    persisted?.sources?.find((/** @type {any} */ s) => s.name === 'otlp')?.state,
    (v) => v === 'stopped'
  )

  await obs.shutdown()

  // ----- 5. Traces contain the expected lifecycle spans -----
  const traces = await expect.traces()

  const daemonRunSpans = traces.filter((/** @type {any} */ t) => t.name === 'daemon.run')
  expect.that(
    'traces: at least one daemon.run root span emitted',
    daemonRunSpans,
    (rows) => Array.isArray(rows) && rows.length >= 1
  )
  expect.that(
    'traces: daemon.run is a root span',
    daemonRunSpans[0]?.parentSpanId ?? null,
    (v) => v === null
  )

  const sourceStartSpans = traces.filter((/** @type {any} */ t) => t.name === 'source.start')
  const startedNames = new Set(
    sourceStartSpans.map((/** @type {any} */ s) => s.attributes?.hyp_source).filter(Boolean)
  )
  expect.that(
    'traces: source.start span exists for ai-gateway',
    startedNames.has('ai-gateway'),
    (v) => v === true
  )
  expect.that(
    'traces: source.start span exists for otlp',
    startedNames.has('otlp'),
    (v) => v === true
  )

  const sourceStopSpans = traces.filter((/** @type {any} */ t) => t.name === 'source.stop')
  const stoppedNames = new Set(
    sourceStopSpans.map((/** @type {any} */ s) => s.attributes?.hyp_source).filter(Boolean)
  )
  expect.that(
    'traces: source.stop span exists for ai-gateway',
    stoppedNames.has('ai-gateway'),
    (v) => v === true
  )
  expect.that(
    'traces: source.stop span exists for otlp',
    stoppedNames.has('otlp'),
    (v) => v === true
  )

  const shutdownSpans = traces.filter((/** @type {any} */ t) => t.name === 'daemon.shutdown')
  expect.that(
    'traces: at least one daemon.shutdown span emitted',
    shutdownSpans,
    (rows) => Array.isArray(rows) && rows.length >= 1
  )

  // `kernel.boot` opens its own root span (each boot is a logical
  // unit of work that survives the calling context), so we don't
  // assert parent-of-daemon.run here — we only assert that the
  // daemon boot path emitted one with `mode=daemon`.
  const kernelBootSpans = traces.filter((/** @type {any} */ t) => t.name === 'kernel.boot')
  expect.that(
    'traces: at least one kernel.boot span emitted with mode=daemon',
    kernelBootSpans.map((/** @type {any} */ s) => s.attributes?.mode),
    (modes) => Array.isArray(modes) && modes.includes('daemon')
  )

  // `source.start` either lands inside `daemon.run` (for sources the
  // daemon starts explicitly, like ai-gateway) or inside the
  // plugin's `activate` span (for sources that auto-start, like otel).
  // We check that at least one source.start came up under daemon.run
  // — that's the new code path Phase 3 actually adds.
  const daemonRunIds = new Set(
    daemonRunSpans.map((/** @type {any} */ s) => s.spanId)
  )
  expect.that(
    'traces: at least one source.start is a child of daemon.run (the daemon-driven start path)',
    sourceStartSpans.map((/** @type {any} */ s) => s.parentSpanId),
    (ids) => Array.isArray(ids) && ids.some((id) => typeof id === 'string' && daemonRunIds.has(id))
  )

  // `source.stop` is dispatched inside the `daemon.shutdown` span so
  // operators can see the shutdown bundle the per-source stops as
  // children when querying the trace store.
  const shutdownIds = new Set(
    shutdownSpans.map((/** @type {any} */ s) => s.spanId)
  )
  expect.that(
    'traces: every source.stop span is a child of a daemon.shutdown span',
    sourceStopSpans.map((/** @type {any} */ s) => s.parentSpanId),
    (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string' && shutdownIds.has(id))
  )
}
