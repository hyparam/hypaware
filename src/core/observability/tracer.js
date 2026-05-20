// @ts-check

import { trace, ProxyTracerProvider } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

import { JsonlSpanExporter } from './jsonl_exporters.js'
import { devTelemetryDir } from './env.js'

/**
 * Install a NodeTracerProvider with the exporter strategy described in
 * the Phase 0 contract:
 *
 * - With `HYP_DEV_TELEMETRY=1`: install a JSONL exporter under
 *   `<state>/dev-telemetry/traces-<pid>.jsonl` so smoke flows can
 *   assert against on-disk artifacts without a live OTLP receiver.
 * - With a configured `OTEL_EXPORTER_OTLP_ENDPOINT` (and dev telemetry
 *   off): install the OTLP HTTP exporter pointed at the endpoint.
 * - When neither is configured: no exporter is registered; the global
 *   tracer remains a no-op.
 *
 * @param {object} args
 * @param {import('./env.js').ObservabilityEnv} args.env
 * @param {import('@opentelemetry/resources').Resource} args.resource
 * @returns {{ provider: NodeTracerProvider|null, exporters: object[] }}
 */
export function installTracerProvider({ env, resource }) {
  /** @type {object[]} */
  const exporters = []
  /** @type {import('@opentelemetry/sdk-trace-base').SpanProcessor[]} */
  const processors = []

  if (env.devTelemetry) {
    const dir = devTelemetryDir(env.stateDir)
    const jsonlExporter = new JsonlSpanExporter({ dir })
    processors.push(new SimpleSpanProcessor(jsonlExporter))
    exporters.push(jsonlExporter)
  }

  if (!env.devTelemetry && env.otlpEndpoint) {
    const otlpExporter = new OTLPTraceExporter({
      url: env.otlpEndpoint.replace(/\/$/, '') + '/v1/traces',
    })
    processors.push(new SimpleSpanProcessor(otlpExporter))
    exporters.push(otlpExporter)
  }

  if (processors.length === 0) {
    return { provider: null, exporters: [] }
  }

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: processors,
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

/** @returns {ProxyTracerProvider} */
export function getActiveProvider() {
  const provider = trace.getTracerProvider()
  return /** @type {ProxyTracerProvider} */ (provider)
}
