// The precise return of `installObservability` (with concrete provider
// classes) is what consumers see via the generated `index.d.ts`. This named
// handle is the self-contained shape of that return; it intentionally avoids
// importing the JSDoc-only `index.js`/`runtime.js` modules so it resolves from
// the published `.d.ts` without a paired declaration for those modules.
export interface ObservabilityHandle {
  env: ObservabilityEnv
  resource: { attributes: Record<string, string | number | boolean> }
  tracer: { provider: unknown }
  logger: { provider: unknown }
  meter: { provider: unknown; readers: object[] }
  shutdown: () => Promise<void>
}

export interface ObservabilityEnv {
  devTelemetry: boolean
  otlpEndpoint: string
  serviceName: string
  hypHome: string
  stateDir: string
  devRunId: string | undefined
  resourceAttributes: string
}

export interface LogRecord {
  loggerName: string
  loggerVersion: string | undefined
  resource: { attributes: Record<string, string | number | boolean> }
  hrTime: [number, number]
  hrTimeObserved: [number, number]
  spanContext: { traceId: string; spanId: string; traceFlags?: number } | undefined
  severityNumber: number | undefined
  severityText: string | undefined
  body: unknown
  attributes: Record<string, unknown>
}

export interface MetricRecord {
  meterName: string
  meterVersion: string | undefined
  resource: { attributes: Record<string, string | number | boolean> }
  name: string
  description: string | undefined
  unit: string | undefined
  kind: 'counter' | 'upDownCounter' | 'gauge' | 'histogram'
  monotonic: boolean
  value: number
  attributes: Record<string, unknown>
  startTime: [number, number]
  endTime: [number, number]
}
