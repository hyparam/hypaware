// @ts-check

import { readObservabilityEnv } from './env.js'
import { buildResource } from './resource.js'
import { installTracerProvider } from './tracer.js'
import { installLoggerProvider } from './logger.js'
import { installMeterProvider, resetKernelInstruments } from './meter.js'
import { installRuntimeMetrics } from './runtime_metrics.js'
import { reportTelemetryFailure } from './runtime.js'
import { OTLP_EXPORT_TIMEOUT_MS } from './otlp_exporters.js'

/**
 * @import { LoggerProvider, MeterProvider, TracerProvider } from './runtime.js'
 * @import { MetricReader, ObservabilityEnv } from '../../../src/core/observability/types.js'
 */

/** @type {ReturnType<typeof buildHandle> | null} */
let installed = null

/**
 * What {@link withTimeout} resolves with when the budget ran out rather than
 * the operation finishing. A sentinel rather than a boolean flag because the
 * operation is free to resolve with anything, including `undefined`.
 */
const TIMED_OUT = Symbol('hyp.telemetry.timed-out')

/**
 * How much longer than the exporter's own per-request timeout the non-dev
 * shutdown waits. The margin covers the settle after an abort fires (the
 * fetch's rejection has to reach `Promise.allSettled` and the provider's
 * shutdown has to resolve), so the budget only ever expires on a close that
 * hangs on something with no timer of its own, never on an export the
 * exporter was about to confirm or abandon itself.
 */
const SHUTDOWN_BUDGET_MARGIN_MS = 250

/**
 * The non-dev shutdown budget, and, because the channels close concurrently,
 * the ceiling on the whole non-dev shutdown: a hang on all three costs this
 * once rather than once per channel.
 *
 * Exported so that ceiling can be checked against the window it has to fit
 * inside instead of compared by hand. `requestDaemonStop` waits
 * `DAEMON_STOP_TIMEOUT_MS` for the signalled daemon's process to go away,
 * not for its pid file: the daemon clears that file partway through its own
 * shutdown, and this close runs after it, on the way out of
 * `bin/hypaware.js`. Waiting on liveness is what puts this close inside the
 * window at all, and it is only one of the things spending it, so the two
 * numbers are pinned against each other in a test: raising
 * `OTLP_EXPORT_TIMEOUT_MS` cannot eat that window unnoticed.
 *
 * Dev telemetry is deliberately outside that pin. It keeps a flat 5s per
 * step and adds a `forceFlush` before the close, so its ceiling is two of
 * those steps and already exceeds the stop window on purpose: whoever sets
 * `HYP_DEV_TELEMETRY=1` is debugging the telemetry path and wants the
 * records more than a prompt exit. Nothing renders that variable into an
 * installed daemon's environment, so the shipped stop is the pinned one.
 *
 * @ref LLP 0343#one-budget [implements]: closing the channels concurrently makes the per-channel budget the whole-shutdown ceiling
 */
export const SHUTDOWN_BUDGET_MS = OTLP_EXPORT_TIMEOUT_MS + SHUTDOWN_BUDGET_MARGIN_MS

/**
 * Install tracer, logger, and meter providers using a single shared
 * Resource derived from env. Returns a handle exposing each provider
 * and a `shutdown()` that flushes and closes every channel's exporters
 * at once. Idempotent: a second call returns the existing handle.
 *
 * @param {{ env?: ObservabilityEnv }} [opts]
 * @ref LLP 0021#otel-is-the-substrate [implements]: idempotent install over one shared Resource; safe-by-default tracer
 */
export function installObservability(opts = {}) {
  if (installed) return installed
  const env = opts.env ?? readObservabilityEnv()
  const resource = buildResource(env)
  const tracer = installTracerProvider({ env, resource })
  const logger = installLoggerProvider({ env, resource })
  const meter = installMeterProvider({ env, resource })
  const runtimeMetrics = installRuntimeMetrics({ env, provider: meter.provider })
  installed = buildHandle({ env, resource, tracer, logger, meter, runtimeMetrics })
  return installed
}

/**
 * @param {{
 *   env: ObservabilityEnv,
 *   resource: { attributes: Record<string, string|number|boolean> },
 *   tracer: { provider: TracerProvider|null },
 *   logger: { provider: LoggerProvider|null },
 *   meter: { provider: MeterProvider|null, readers: MetricReader[] },
 *   runtimeMetrics: { active: true, intervalMs: number, stop: () => void }|null
 * }} parts
 */
function buildHandle({ env, resource, tracer, logger, meter, runtimeMetrics }) {
  // @ref LLP 0021#shutdown-and-flush [implements]: dev gets a 5s budget and a forceFlush before the close (the order that section recorded is now LLP 0343's)
  async function shutdown() {
    runtimeMetrics?.stop()
    // @ref LLP 0339#budget-derived [implements]: the non-dev budget sits above the OTLP export timeout by construction, so an in-flight export settles before the budget can abandon it
    const timeoutMs = env.devTelemetry ? 5_000 : SHUTDOWN_BUDGET_MS
    // Per shutdown invocation, like the exporter guard's own set: a process
    // that installs a second provider after tearing the first one down
    // starts clean.
    /** @type {Set<string>} */
    const reportedCloseTimeouts = new Set()
    // Still on the silent `safe()`, knowingly: both return paths in
    // `installMeterProvider` return `readers: []`, so this loop is
    // unreachable and a report added here could not be run, let alone tested
    // (hyparam/hypaware#1137 item 2). The day a real `MetricReader` lands, it
    // gets `closeStep` like every provider below (LLP 0337#budget-report).
    for (const reader of meter.readers ?? []) {
      if (env.devTelemetry) await safe(() => withTimeout(reader.forceFlush(), timeoutMs))
      await safe(() => withTimeout(reader.shutdown(), timeoutMs))
    }
    // The budget is per channel, so closing the channels one after another
    // made the ceiling three budgets rather than one, and the daemon still
    // has to be gone inside `DAEMON_STOP_TIMEOUT_MS`. Concurrently the same
    // three hangs cost one budget, and a slow-but-answering channel no longer
    // has to wait out the channel closed before it.
    // @ref LLP 0343#one-budget [implements]: the channels close concurrently, so a hang costs one budget rather than one per channel
    await Promise.all([
      closeChannel('metrics', meter.provider, env.devTelemetry, timeoutMs, reportedCloseTimeouts),
      closeChannel('logs', logger.provider, env.devTelemetry, timeoutMs, reportedCloseTimeouts),
      closeChannel('traces', tracer.provider, env.devTelemetry, timeoutMs, reportedCloseTimeouts),
    ])
    resetKernelInstruments()
    installed = null
  }
  return { env, resource, tracer, logger, meter, runtimeMetrics, shutdown }
}

/**
 * Close one channel's provider: the dev flush first, then the close, each
 * under its own budget.
 *
 * Ordered within the channel, because a flush after the close has nothing
 * left to flush. Unordered against the other two, because the channels share
 * nothing that could make one wait for another: each holds its own exporters,
 * its own pending posts, and its own global registration, and the timed-out
 * report writes straight to `process.stderr` rather than back through any
 * provider (LLP 0335#one-line). That is what lets the three run at once.
 *
 * @param {'traces'|'logs'|'metrics'} channel
 * @param {{ forceFlush(): Promise<void>|void, shutdown(): Promise<void>|void }|null} provider
 * @param {boolean} devTelemetry
 * @param {number} timeoutMs
 * @param {Set<string>} reported
 */
async function closeChannel(channel, provider, devTelemetry, timeoutMs, reported) {
  if (!provider) return
  if (devTelemetry) await closeStep(channel, 'flush', () => provider.forceFlush(), timeoutMs, reported)
  await closeStep(channel, 'shutdown', () => provider.shutdown(), timeoutMs, reported)
}

/**
 * Run one provider's flush or close under the shutdown budget, and say once
 * on stderr when the budget ran out.
 *
 * A provider whose close never settles loses the race in {@link withTimeout},
 * the process exits, and whatever that provider still buffered is gone. That
 * outcome used to be indistinguishable from a clean shutdown, which is the
 * same silence LLP 0335#close-failures ended for a close that rejects; the
 * hang was left as a named boundary there. It is not a false alarm on a
 * merely slow close: when the budget expires the shutdown moves on regardless,
 * so the records at stake are lost either way and the line says so.
 *
 * Like every other report on this path, it must not throw: a shutdown that
 * rejects here would skip the teardown after it.
 *
 * @ref LLP 0337#budget-report [implements]: a close that outruns the shutdown budget is reported, not silently abandoned.
 * @param {'traces'|'logs'|'metrics'} channel
 * @param {'flush'|'shutdown'} operation
 * @param {() => Promise<unknown>|unknown} run
 * @param {number} timeoutMs
 * @param {Set<string>} reported
 */
async function closeStep(channel, operation, run, timeoutMs, reported) {
  try {
    const outcome = await withTimeout(run(), timeoutMs)
    if (outcome !== TIMED_OUT) return
    const source = `${channel}_provider`
    reportTelemetryFailure({
      channel,
      source,
      key: `${source}#${operation}`,
      error: `no result within the ${timeoutMs}ms shutdown budget`,
      reported,
      operation,
      outcome: 'timed_out',
    })
  } catch { /* shutdown should not throw */ }
}

/**
 * @param {Promise<unknown>|unknown} operation
 * @param {number} timeoutMs
 * @returns {Promise<unknown>} the operation's result, or {@link TIMED_OUT}
 */
function withTimeout(operation, timeoutMs) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  return Promise.race([
    Promise.resolve(operation),
    // The budget timer stays referenced, and the `finally` below clears it the
    // instant the close settles, so a shutdown that finishes pays nothing for
    // it. Unreferenced it can only fire while some other handle holds the loop
    // open, and the one handle that used to - a pending OTLP fetch - is now
    // gone first by construction, because the budget is derived to outlast the
    // exporter's own abort (LLP 0339#budget-derived). On the single case the
    // budget exists for, a close hanging on something with no timer of its
    // own, the loop drains, this race never settles, and the process leaves
    // through Node's unsettled-top-level-await path instead: no report, and
    // `bin/hypaware.js`'s exit code and stream flush both skipped. That is the
    // residue `containment-refusal-stderr.test.js` names beside its own hung
    // close, and holding the timer is what closes it.
    // @ref LLP 0337#budget-report [implements]: the report can only fire if the budget can hold the loop open long enough to reach it
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** @param {() => Promise<unknown>|unknown} fn */
async function safe(fn) {
  try { await fn() } catch { /* shutdown should not throw */ }
}

export { readObservabilityEnv } from './env.js'
export { buildResource } from './resource.js'
export { getTracer } from './tracer.js'
export { getLogger } from './logger.js'
export { getMeter, getKernelInstruments } from './meter.js'
export { markSpanStatus, withSpan, runRoot } from './span_helpers.js'
export { buildAttrs, normalizeKey, Attr } from './attrs.js'
export { context, ROOT_CONTEXT, SpanStatusCode, getActiveSpan } from './runtime.js'
