// @ts-check

import { JsonlMetricExporter } from './jsonl_exporters.js'
import { devTelemetryDir } from './env.js'
import { MeterProvider, metrics } from './runtime.js'
import { OtlpMetricExporter } from './otlp_exporters.js'

/**
 * @import { ObservabilityEnv } from './types.d.ts'
 */

const OTLP_EXPORT_TIMEOUT_MS = 1_000

/**
 * Install a MeterProvider with the same JSONL/OTLP strategy as the
 * tracer. Metric exports are pushed on a 250ms interval in dev mode
 * so smoke flows can flush + assert quickly without waiting for the
 * default 60s push.
 *
 * @param {object} args
 * @param {ObservabilityEnv} args.env
 * @param {{ attributes: Record<string, string|number|boolean> }} args.resource
 * @returns {{ provider: MeterProvider|null, exporters: object[], readers: object[] }}
 */
export function installMeterProvider({ env, resource }) {
  /** @type {object[]} */
  const exporters = []

  if (env.devTelemetry) {
    const dir = devTelemetryDir(env.stateDir)
    const jsonlExporter = new JsonlMetricExporter({ dir })
    exporters.push(jsonlExporter)
  }

  if (!env.devTelemetry && env.otlpEndpoint) {
    const otlpExporter = new OtlpMetricExporter({
      url: env.otlpEndpoint.replace(/\/$/, '') + '/v1/metrics',
      timeoutMillis: OTLP_EXPORT_TIMEOUT_MS,
    })
    exporters.push(otlpExporter)
  }

  if (exporters.length === 0) {
    return { provider: null, exporters: [], readers: [] }
  }

  const provider = new MeterProvider({ resource, exporters })
  metrics.setGlobalMeterProvider(provider)
  return { provider, exporters, readers: [] }
}

/**
 * Pre-declared kernel-level counters from the self-instrumentation
 * contract. Plugins declare their own meters; this set is reserved
 * for things the kernel itself emits.
 *
 * @param {{ createCounter(name: string, opts?: object): object, createUpDownCounter(name: string, opts?: object): object, createGauge(name: string, opts?: object): object, createHistogram(name: string, opts?: object): object }} meter
 */
function buildKernelInstruments(meter) {
  return {
    pluginsLoaded: meter.createCounter('hyp_plugins_loaded', {
      description: 'Number of plugins activated this kernel boot',
    }),
    capabilitiesProvided: meter.createUpDownCounter('hyp_capabilities_provided', {
      description: 'Distinct (capability, version) pairs registered',
    }),
    sourcesStarted: meter.createUpDownCounter('hyp_sources_started', {
      description: 'Active sources, by source name',
    }),
    rowsWritten: meter.createCounter('hyp_rows_written', {
      description: 'Rows materialized into the cache, by dataset/plugin',
    }),
    sinksRegistered: meter.createCounter('hyp_sinks_registered', {
      description: 'Sink instances registered with the kernel, by sink_instance/sink_kind',
    }),
    sinkExportsTotal: meter.createCounter('hyp_sink_exports_total', {
      description: 'Sink export attempts, by sink_instance/status',
    }),
    sinkExportBytes: meter.createCounter('hyp_sink_export_bytes', {
      description: 'Bytes written by sink exports, by sink_instance',
    }),
    sinkExportFailuresTotal: meter.createCounter('hyp_sink_export_failures_total', {
      description: 'Sink export batches that landed in the outbox, by sink_instance',
    }),
    sinkTicksTotal: meter.createCounter('hyp_sink_ticks_total', {
      description: 'Sink driver tick invocations, by source (daemon/manual)',
    }),
    daemonUptimeMs: meter.createGauge('hyp_daemon_uptime_ms', {
      description: 'Milliseconds since the running daemon reached `healthy` (0 when not running)',
      unit: 'ms',
    }),
    commandRunsTotal: meter.createCounter('hyp_command_runs_total', {
      description: 'Command invocations, by command/exit_code',
    }),
    commandDurationMs: meter.createHistogram('hyp_command_duration_ms', {
      description: 'Command duration in milliseconds',
      unit: 'ms',
    }),
    queryRunsTotal: meter.createCounter('hyp_query_runs_total', {
      description: 'Query runs, by status',
    }),
    queryDurationMs: meter.createHistogram('hyp_query_duration_ms', {
      description: 'Query duration in milliseconds',
      unit: 'ms',
    }),
    queryCacheHitsTotal: meter.createCounter('hyp_query_cache_hits_total', {
      description: 'Query cache hits',
    }),
    queryCacheMissesTotal: meter.createCounter('hyp_query_cache_misses_total', {
      description: 'Query cache misses',
    }),
    pluginInstallsTotal: meter.createCounter('hyp_plugin_installs_total', {
      description: 'Plugin install attempts, by status',
    }),
    pluginUpdatesAvailable: meter.createGauge('hyp_plugin_updates_available', {
      description: 'Whether an update is available for each installed plugin (0 or 1, keyed by hyp_plugin)',
    }),
  }
}

/** @type {ReturnType<typeof buildKernelInstruments> | null} */
let cachedInstruments = null

/**
 * Lazily resolve the kernel meter so a caller that never invokes a
 * kernel instrument doesn't pay for one. The instruments are
 * registered against the active global MeterProvider, which means
 * they participate in whatever exporter strategy was installed.
 */
export function getKernelInstruments() {
  if (cachedInstruments) return cachedInstruments
  const meter = metrics.getMeter('hypaware.kernel')
  cachedInstruments = buildKernelInstruments(meter)
  return cachedInstruments
}

/**
 * Reset the cached instruments (test affordance — kernel boot resets
 * state when reinitializing the observability layer).
 */
export function resetKernelInstruments() {
  cachedInstruments = null
}

/**
 * @param {string} component
 */
export function getMeter(component) {
  return metrics.getMeter(`hypaware.${component}`)
}
