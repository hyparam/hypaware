// @ts-check

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { COMMANDS, ERROR_CODES, METRICS, validateBatch } from './contract.js'

export const PRODUCT_VERSION = createRequire(import.meta.url)(
  '../../../package.json'
).version
const PROCESS_ID = randomUUID()
const ADAPTERS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'opencode',
  'openclaw',
  'hermes',
  'other'
]
/** @param {unknown} value @param {readonly string[]} allowed @param {string} [fallback] */
function label(value, allowed, fallback = 'other') {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}
/** @param {unknown} value @param {number} [max] */
function bounded(value, max = 86_400_000) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(value, max))
    : 0
}

/**
 * No user resource attributes enter this projection. Versions come from the
 * loaded package, and the server supplies its own loaded application version.
 * @param {{role?: 'cli'|'daemon'|'server', version?: string, kernelVersion?: string, env?: NodeJS.ProcessEnv, processId?: string}} [options]
 */
export function createProductResource({
  role = 'cli',
  version = PRODUCT_VERSION,
  kernelVersion = PRODUCT_VERSION,
  env = process.env,
  processId = PROCESS_ID
} = {}) {
  return {
    'service.name': role === 'server' ? 'hypaware-server' : 'hypaware',
    'service.version': version,
    'service.role': role,
    'process.id': processId,
    'os.type':
      process.platform === 'win32'
        ? 'windows'
        : label(process.platform, ['darwin', 'linux']),
    'host.arch': label(process.arch, ['arm64', 'x64']),
    'node.major': Number(process.versions.node.split('.')[0]),
    'deployment.environment':
      env.HYP_DEV_TELEMETRY === '1' ||
      env.HYP_DEV_TELEMETRY === 'true' ||
      env.DEV_RUN_ID ||
      env.NODE_ENV === 'test'
        ? 'test'
        : env.NODE_ENV === 'development'
          ? 'development'
          : 'production',
    'hypaware.self': true,
    ...(role === 'server' ? { 'hypaware.version': kernelVersion } : {})
  }
}

/**
 * Construct only declared keys, before anything reaches storage. Caller error
 * messages, argv and extension fields are never spread into the payload.
 * @ref LLP 0393#contract [implements]: product events are a separate finite projection
 * @param {string} name @param {Record<string, any>} [input] @param {number} [now]
 * @returns {Record<string, any> | null}
 */
export function productEvent(name, input = {}, now = Date.now()) {
  const outcome = label(
    input.outcome,
    ['success', 'failure', 'degraded', 'cancelled'],
    'failure'
  )
  const error_code = label(input.error_code, ERROR_CODES)
  let attributes
  switch (name) {
    case 'cli.invocation':
      attributes = {
        command: label(input.command, COMMANDS, 'unknown'),
        invocation_kind: label(
          input.invocation_kind,
          ['execution', 'help', 'version', 'unknown'],
          'unknown'
        ),
        outcome,
        exit_class: label(
          input.exit_class,
          ['zero', 'nonzero', 'signal', 'cancelled'],
          'nonzero'
        ),
        duration_ms: bounded(input.duration_ms)
      }
      break
    case 'installation.inventory':
      attributes = {
        adapters: [
          ...new Set(
            (Array.isArray(input.adapters) ? input.adapters : [])
              .slice(0, 32)
              .map((v) => label(v, ADAPTERS))
          )
        ]
      }
      break
    case 'setup.step':
      attributes = {
        step: label(input.step, [
          'install',
          'configure',
          'attach',
          'enroll',
          'verify',
          'complete',
          'other'
        ]),
        outcome,
        error_code,
        duration_ms: bounded(input.duration_ms)
      }
      break
    case 'client.attachment':
      attributes = {
        adapter: label(input.adapter, ADAPTERS),
        operation: label(input.operation, ['attach', 'detach'], 'attach'),
        outcome,
        error_code
      }
      break
    case 'enrollment':
      attributes = {
        operation: label(input.operation, ['join', 'leave'], 'join'),
        outcome
      }
      break
    case 'daemon.lifecycle':
      attributes = {
        transition: label(
          input.transition,
          ['start', 'ready', 'stop', 'update'],
          'start'
        ),
        outcome,
        error_code
      }
      break
    case 'installation.milestone':
      attributes = {
        milestone: label(
          input.milestone,
          ['first_capture', 'first_query'],
          'first_capture'
        )
      }
      break
    case 'heartbeat':
      attributes = { uptime_s: bounded(input.uptime_s, 365 * 86400) }
      break
    case 'coded.failure':
      attributes = {
        component: label(input.component, [
          'cli',
          'daemon',
          'capture',
          'cache',
          'export',
          'identity',
          'query',
          'server',
          'telemetry',
          'other'
        ]),
        operation: label(input.operation, [
          'start',
          'stop',
          'read',
          'write',
          'capture',
          'export',
          'query',
          'enroll',
          'refresh',
          'send',
          'other'
        ]),
        error_code,
        occurrence_count: Math.max(
          1,
          Math.floor(bounded(input.occurrence_count, 1000))
        )
      }
      break
    default:
      return null
  }
  return {
    kind: 'event',
    timestamp: new Date(now).toISOString(),
    name,
    attributes
  }
}

/** @param {Record<string, any>} resource @param {Record<string, any>[]} records @param {number} [now] */
export function productBatch(resource, records, now = Date.now()) {
  const batch = { schema_version: 1, batch_id: randomUUID(), resource, records }
  return validateBatch(batch, now, resource['service.role'] === 'server') ===
    null
    ? batch
    : null
}

/**
 * No timer, observer, histogram or per-label map. Hosts sample every 30s and
 * flush every five minutes. CPU is interval cores, not lifetime CPU percent.
 * @ref LLP 0393#runtime [implements]: weighted averages, observed peaks and latest values with explicit missing coverage
 * @param {{now?:()=>number, monotonicNow?:()=>number, cpuUsage?: typeof process.cpuUsage, memoryUsage?:()=>{rss:number,heapUsed:number}}} [options]
 */
export function createRuntimeSummary({
  now = Date.now,
  monotonicNow = () => performance.now(),
  cpuUsage = process.cpuUsage,
  memoryUsage = process.memoryUsage
} = {}) {
  let start = now()
  let previousTime = monotonicNow()
  let previousCpu = cpuUsage()
  /** @type {Map<string, {sum:number,max:number,value:number,count:number,coverage:number}>} */
  const gauges = new Map()
  function sample() {
    const time = monotonicNow()
    const cpu = cpuUsage()
    const elapsed = time - previousTime
    const cores =
      (cpu.user - previousCpu.user + cpu.system - previousCpu.system) /
      (elapsed * 1000)
    previousTime = time
    previousCpu = cpu
    if (elapsed <= 0 || elapsed > 60_000 || now() - start > 600_000) {
      gauges.clear()
      start = now()
      return
    }
    const mem = memoryUsage()
    const coverage = Math.min(elapsed, 30_000)
    for (const [name, value] of [
      ['process.rss', mem.rss],
      ['process.heap_used', mem.heapUsed],
      ['process.cpu', cores]
    ]) {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0 || n > METRICS[name].max) continue
      const state = gauges.get(String(name)) ?? {
        sum: 0,
        max: 0,
        value: 0,
        count: 0,
        coverage: 0
      }
      if (state.count >= 11) continue
      state.sum += n * coverage
      state.coverage += coverage
      state.max = Math.max(state.max, n)
      state.value = n
      state.count++
      gauges.set(String(name), state)
    }
  }
  function flush() {
    const end = now()
    const duration = end - start
    const records =
      duration > 0 && duration <= 600_000
        ? [...gauges].map(([name, g]) => ({
            kind: 'metric',
            timestamp: new Date(end).toISOString(),
            startTimestamp: new Date(start).toISOString(),
            name,
            type: 'gauge',
            unit: METRICS[name].unit,
            attributes: {},
            value: g.value,
            average: g.sum / g.coverage,
            max: g.max,
            sampleCount: g.count,
            coverageMs: Math.min(g.coverage, duration)
          }))
        : []
    gauges.clear()
    start = end
    return records
  }
  return { sample, flush }
}
