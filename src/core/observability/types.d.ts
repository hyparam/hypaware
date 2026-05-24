import type { installObservability } from './index.js'

export type ObservabilityHandle = Awaited<ReturnType<typeof installObservability>>

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
