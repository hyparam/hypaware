// @ts-check

import { JsonlSpanExporter } from './jsonl_exporters.js'
import { devTelemetryDir } from './env.js'
import { OtlpSpanExporter } from './otlp_exporters.js'
import { trace, TracerProvider } from './runtime.js'

/**
 * @import { ObservabilityEnv } from './env.js'
 */

const OTLP_EXPORT_TIMEOUT_MS = 1_000

/**
 * Install a NodeTracerProvider with the exporter strategy described in
 * the Phase 0 contract:
 *
 * - With `HYP_DEV_TELEMETRY=1`: install a JSONL exporter under
 *   `<state>/dev-telemetry/traces-<pid>.jsonl` so smoke flows can
 *   assert against on-disk artifacts without a live OTLP receiver.
 * - With an explicitly configured `OTEL_EXPORTER_OTLP_ENDPOINT` (and dev telemetry
 *   off): install the OTLP HTTP exporter pointed at the endpoint.
 * - When neither is configured: no exporter is registered; the global
 *   tracer remains a no-op.
 *
 * @param {object} args
 * @param {ObservabilityEnv} args.env
 * @param {{ attributes: Record<string, string|number|boolean> }} args.resource
 * @returns {{ provider: TracerProvider|null, exporters: object[] }}
 */
export function installTracerProvider({ env, resource }) {
  /** @type {object[]} */
  const exporters = []

  if (env.devTelemetry) {
    const dir = devTelemetryDir(env.stateDir)
    const jsonlExporter = new JsonlSpanExporter({ dir })
    exporters.push(jsonlExporter)
  }

  if (!env.devTelemetry && env.otlpEndpoint) {
    const otlpExporter = new OtlpSpanExporter({
      url: env.otlpEndpoint.replace(/\/$/, '') + '/v1/traces',
      timeoutMillis: OTLP_EXPORT_TIMEOUT_MS,
    })
    exporters.push(otlpExporter)
  }

  if (exporters.length === 0) {
    return { provider: null, exporters: [] }
  }

  const provider = new TracerProvider({
    resource,
    exporters,
  })
  provider.register()
  return { provider, exporters }
}

/**
 * Resolve the active tracer for a component. Always safe to call —
 * returns the global no-op tracer when no provider is installed.
 * @param {string} component
 */
export function getTracer(component) {
  return trace.getTracer(`hypaware.${component}`)
}

/** @returns {object} */
export function getActiveProvider() {
  return trace.getTracerProvider()
}
