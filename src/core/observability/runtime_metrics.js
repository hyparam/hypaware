// @ts-check

import os from 'node:os'
import process from 'node:process'
import v8 from 'node:v8'
import {
  constants,
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from 'node:perf_hooks'

import { nsToHrTime, nowUnixNano } from './runtime.js'

/**
 * @import { MetricRecord, ObservabilityEnv } from '../../../src/core/observability/types.js'
 * @import { MeterProvider } from './runtime.js'
 */

const EVENT_LOOP_DELAY_RESOLUTION_MS = 100
const NS_PER_MS = 1_000_000
const US_PER_MS = 1_000
const MS_PER_SECOND = 1_000

const GC_KINDS = new Map([
  [constants.NODE_PERFORMANCE_GC_MAJOR, 'major'],
  [constants.NODE_PERFORMANCE_GC_MINOR, 'minor'],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, 'incremental'],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, 'weak_callback'],
])

/**
 * Install the opt-in process sampler only after a meter provider exists. A
 * flag without an exporter must cost nothing: no timer, event-loop histogram,
 * or GC observer.
 *
 * @param {{ env: ObservabilityEnv, provider: MeterProvider|null }} args
 * @returns {{ active: true, intervalMs: number, stop: () => void }|null}
 * @ref LLP 0318#activation [implements]: the flag samples only into an installed exporter, with a five-second floor
 */
export function installRuntimeMetrics({ env, provider }) {
  if (!env.runtimeMetrics || !provider) return null

  const delay = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_RESOLUTION_MS })
  delay.enable()

  /** @type {Map<string, { count: number, durationMs: number }>} */
  const gc = new Map()
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const detail = /** @type {{ kind?: number }} */ (Reflect.get(entry, 'detail') ?? {})
      const kind = GC_KINDS.get(detail.kind ?? -1) ?? 'other'
      const prior = gc.get(kind) ?? { count: 0, durationMs: 0 }
      prior.count += 1
      prior.durationMs += entry.duration
      gc.set(kind, prior)
    }
  })
  gcObserver.observe({ entryTypes: ['gc'] })

  let priorCpu = process.cpuUsage()
  let priorWallMs = performance.now()
  let priorElu = performance.eventLoopUtilization()
  let stopped = false

  const sample = () => {
    if (stopped) return
    try {
      const collectedAt = nowUnixNano()
      const currentCpu = process.cpuUsage()
      const currentWallMs = performance.now()
      const currentElu = performance.eventLoopUtilization()
      const records = collectRuntimeMetrics({
        provider,
        collectedAt,
        priorCpu,
        priorWallMs,
        priorElu,
        currentCpu,
        currentWallMs,
        currentElu,
        delay,
        gc,
      })
      priorCpu = currentCpu
      priorWallMs = currentWallMs
      priorElu = currentElu
      delay.reset()
      gc.clear()
      // @ref LLP 0318#batching [implements]: a whole diagnostic tick is one exporter batch and therefore one OTLP request
      provider.exportRecords(records)
    } catch {
      // Runtime diagnostics must never become a failure path for HypAware.
    }
  }

  sample()
  const timer = setInterval(sample, env.runtimeMetricsIntervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    active: true,
    intervalMs: env.runtimeMetricsIntervalMs,
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      delay.disable()
      gcObserver.disconnect()
    },
  }
}

/**
 * @param {{
 *   provider: MeterProvider,
 *   collectedAt: bigint,
 *   priorCpu: NodeJS.CpuUsage,
 *   priorWallMs: number,
 *   priorElu: ReturnType<typeof performance.eventLoopUtilization>,
 *   currentCpu: NodeJS.CpuUsage,
 *   currentWallMs: number,
 *   currentElu: ReturnType<typeof performance.eventLoopUtilization>,
 *   delay: ReturnType<typeof monitorEventLoopDelay>,
 *   gc: Map<string, { count: number, durationMs: number }>,
 * }} args
 * @returns {MetricRecord[]}
 * @ref LLP 0318#surface [implements]: bounded runtime enums distinguish heap, native, GC, event-loop, host, and resource pressure
 */
function collectRuntimeMetrics({
  provider,
  collectedAt,
  priorCpu,
  priorWallMs,
  priorElu,
  currentCpu,
  currentWallMs,
  currentElu,
  delay,
  gc,
}) {
  const collectionStart = performance.now()
  /** @type {MetricRecord[]} */
  const records = []
  const record = (name, value, unit, attributes = {}, description = undefined) => {
    if (!Number.isFinite(value)) return
    records.push(metricRecord({
      provider,
      collectedAt,
      name,
      value,
      unit,
      attributes,
      description,
    }))
  }

  const memory = process.memoryUsage()
  for (const [area, value] of Object.entries(memory)) {
    record('hyp_runtime_memory_bytes', value, 'By', { area })
  }

  const heap = v8.getHeapStatistics()
  record('hyp_runtime_memory_bytes', heap.heap_size_limit, 'By', { area: 'heap_limit' })
  record('hyp_runtime_memory_bytes', heap.total_available_size, 'By', { area: 'heap_available' })
  record('hyp_runtime_memory_bytes', heap.malloced_memory, 'By', { area: 'malloced' })
  record('hyp_runtime_memory_bytes', heap.peak_malloced_memory, 'By', { area: 'malloced_peak' })

  for (const space of v8.getHeapSpaceStatistics()) {
    const attrs = { space: space.space_name }
    record('hyp_runtime_heap_space_bytes', space.space_used_size, 'By', { ...attrs, area: 'used' })
    record('hyp_runtime_heap_space_bytes', space.space_available_size, 'By', { ...attrs, area: 'available' })
  }

  const elapsedMs = currentWallMs - priorWallMs
  const cpuUs = (currentCpu.user - priorCpu.user) + (currentCpu.system - priorCpu.system)
  if (elapsedMs >= 1 && cpuUs >= 0) {
    record('hyp_runtime_cpu_cores', cpuUs / (elapsedMs * US_PER_MS), '{core}')
  }

  const activeMs = currentElu.active - priorElu.active
  const idleMs = currentElu.idle - priorElu.idle
  if (activeMs >= 0 && idleMs >= 0 && activeMs + idleMs > 0) {
    record('hyp_runtime_event_loop_utilization', activeMs / (activeMs + idleMs), '1')
  }

  const delayStats = [
    ['mean', delay.mean],
    ['p50', delay.percentile(50)],
    ['p95', delay.percentile(95)],
    ['p99', delay.percentile(99)],
    ['max', delay.max],
  ]
  for (const [stat, nanos] of delayStats) {
    record('hyp_runtime_event_loop_delay_ms', Number(nanos) / NS_PER_MS, 'ms', { statistic: stat })
  }

  for (const [kind, values] of gc) {
    record('hyp_runtime_gc_events', values.count, '{event}', { kind })
    record('hyp_runtime_gc_duration_ms', values.durationMs, 'ms', { kind })
  }

  record('hyp_runtime_host_memory_bytes', os.totalmem(), 'By', { area: 'total' })
  record('hyp_runtime_host_memory_bytes', os.freemem(), 'By', { area: 'free' })
  const load = os.loadavg()
  for (const [index, window] of ['1m', '5m', '15m'].entries()) {
    record('hyp_runtime_load_average', load[index], '{process}', { window })
  }

  const resourceCounts = countValues(process.getActiveResourcesInfo())
  for (const [resource, count] of resourceCounts) {
    record('hyp_runtime_active_resources', count, '{resource}', { resource })
  }

  record('hyp_runtime_uptime_ms', process.uptime() * MS_PER_SECOND, 'ms')
  record('hyp_runtime_sampler_collect_duration_ms', performance.now() - collectionStart, 'ms')
  return records
}

/**
 * @param {{
 *   provider: MeterProvider,
 *   collectedAt: bigint,
 *   name: string,
 *   value: number,
 *   unit: string,
 *   attributes: Record<string, unknown>,
 *   description?: string,
 * }} args
 * @returns {MetricRecord}
 */
function metricRecord({ provider, collectedAt, name, value, unit, attributes, description }) {
  const timestamp = nsToHrTime(collectedAt)
  return {
    meterName: 'hypaware.runtime',
    meterVersion: undefined,
    resource: provider.resource,
    name,
    description,
    unit,
    kind: 'gauge',
    monotonic: false,
    value,
    attributes,
    startTime: timestamp,
    endTime: timestamp,
  }
}

/** @param {string[]} values */
function countValues(values) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}
