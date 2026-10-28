// @ts-check

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import {
  AGENT_SHELL_MARKERS,
  COMMANDS,
  MAX_QUERY_DATASETS,
  MCP_TOOLS,
  METRICS,
  QUERY_DATASETS,
  QUERY_FIELDS,
  QUERY_LOCATIONS,
  QUERY_SURFACES,
  QUERY_TOOLS,
  V2_ERROR_CODES,
  isQueryCommand,
  validateBatch
} from './contract.js'

export const PRODUCT_VERSION = createRequire(import.meta.url)(
  '../../../package.json'
).version
const PROCESS_ID = randomUUID()
const ADAPTERS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'opencode',
  'antigravity',
  'antigravity-desktop',
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
  const error_code = label(input.error_code, V2_ERROR_CODES)
  let attributes
  switch (name) {
    case 'cli.invocation': {
      const command = label(input.command, COMMANDS, 'unknown')
      attributes = {
        command,
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
        duration_ms: bounded(input.duration_ms),
        ...(input.query && isQueryCommand(command) ? queryFields(input.query) : {})
      }
      break
    }
    case 'mcp.tool_call': {
      const tool = label(input.tool, MCP_TOOLS)
      attributes = {
        tool,
        outcome,
        error_code,
        duration_ms: Math.round(bounded(input.duration_ms)),
        ...(input.query && QUERY_TOOLS.includes(tool) ? queryFields(input.query) : {})
      }
      break
    }
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

/**
 * The four query fields, each from its fixed list. Table names outside the
 * list become `other`; nothing else about the query is read.
 * @ref LLP 0561#query [implements]: bounded answers only, never query text, columns, filters or rows
 * @param {{datasets?: unknown, location?: unknown, rows?: unknown, surface?: unknown}} input
 */
export function queryFields(input) {
  const datasets = []
  if (Array.isArray(input.datasets)) {
    for (const value of input.datasets) {
      const name = label(value, QUERY_DATASETS)
      if (!datasets.includes(name)) datasets.push(name)
      if (datasets.length === MAX_QUERY_DATASETS) break
    }
  }
  return {
    datasets,
    location: label(input.location, QUERY_LOCATIONS, 'local'),
    rows: rowsBucket(input.rows),
    surface: label(input.surface, QUERY_SURFACES, 'unknown')
  }
}

// Tools whose result names no dataset read a fixed one.
const TOOL_DATASETS = /** @type {Record<string, string[]>} */ ({
  grep_search: ['ai_gateway_messages'],
  graph_neighbors: ['node', 'edge']
})

/**
 * Query fields for a finished query, read from its result's shape only: the
 * datasets it lists (else the tool's own) and the length of its row list.
 * @param {string} tool @param {unknown} value @param {'local'|'remote'} location @param {string} surface
 */
export function queryResult(tool, value, location, surface) {
  const r = /** @type {Record<string, unknown>} */ (
    value && typeof value === 'object' ? value : {}
  )
  const list = Array.isArray(r.rows)
    ? r.rows
    : Array.isArray(r.hits)
      ? r.hits
      : Array.isArray(r.neighbors)
        ? r.neighbors
        : null
  return {
    datasets: Array.isArray(r.datasets) ? r.datasets : (TOOL_DATASETS[tool] ?? []),
    location,
    rows: list ? list.length : undefined,
    surface
  }
}

/** @param {unknown} count */
export function rowsBucket(count) {
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
    return 'unknown'
  if (count === 0) return '0'
  if (count <= 10) return '1-10'
  if (count <= 100) return '11-100'
  if (count <= 1000) return '101-1000'
  return '>1000'
}

/**
 * `agent_shell` when a known agent harness marker is set, else `cli`.
 * @param {NodeJS.ProcessEnv} env
 */
export function cliSurface(env) {
  for (const marker of AGENT_SHELL_MARKERS) if (env[marker]) return 'agent_shell'
  return 'cli'
}

const ERRNO_CODES = /** @type {Record<string, string>} */ ({
  ENOSPC: 'disk_full',
  EDQUOT: 'disk_full',
  ETIMEDOUT: 'timeout',
  ECONNREFUSED: 'unavailable',
  ECONNRESET: 'unavailable',
  ENOTFOUND: 'unavailable',
  EAI_AGAIN: 'unavailable',
  EHOSTUNREACH: 'unavailable',
  ENETUNREACH: 'unavailable',
  // Typed errors raised in this repo, by their stable `code`.
  query_budget_exceeded: 'budget_exceeded',
  timestamp_literal_uncoercible: 'query_failed',
  invalid_grant: 'unauthorized',
  service_token_revoked: 'revoked',
  service_account_disabled: 'revoked'
})
const ERROR_NAMES = /** @type {Record<string, string>} */ ({
  TimeoutError: 'timeout',
  ServiceCommandTimeoutError: 'timeout',
  GrepQueryError: 'query_failed',
  QueryExecutionBudgetError: 'budget_exceeded'
})

/**
 * Map a thrown value onto the finite error codes by its class name or `code`
 * (its own, then its `cause`'s), never by message text. Unclassified is null so
 * the caller picks its own fallback.
 * @ref LLP 0561#errors [implements]: classify by error class or code, never message text
 * @param {unknown} error @returns {string | null}
 */
export function errorCode(error) {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const err = /** @type {{code?: unknown, name?: unknown, cause?: unknown}} */ (e)
    if (typeof err.code === 'string' && Object.hasOwn(ERRNO_CODES, err.code))
      return ERRNO_CODES[err.code]
    if (typeof err.name === 'string' && Object.hasOwn(ERROR_NAMES, err.name))
      return ERROR_NAMES[err.name]
    e = err.cause
  }
  return null
}

/**
 * The v1 projection of records built in the v2 shape: no `mcp.tool_call`, no
 * query fields, and `budget_exceeded` folded to `query_failed`.
 * @param {Record<string, any>[]} records
 */
function asV1(records) {
  const out = []
  for (const record of records) {
    if (record.kind !== 'event') {
      out.push(record)
      continue
    }
    if (record.name === 'mcp.tool_call') continue
    let attributes = record.attributes
    if (record.name === 'cli.invocation' && Object.hasOwn(attributes, 'rows')) {
      attributes = { ...attributes }
      for (const key of QUERY_FIELDS) delete attributes[key]
    }
    if (attributes.error_code === 'budget_exceeded')
      attributes = { ...attributes, error_code: 'query_failed' }
    out.push(attributes === record.attributes ? record : { ...record, attributes })
  }
  return out
}

/**
 * @param {Record<string, any>} resource @param {Record<string, any>[]} records @param {number} [now]
 * @param {1|2} [version] 2 only once the receiver has advertised it
 */
export function productBatch(resource, records, now = Date.now(), version = 1) {
  const wire = version === 2 ? records : asV1(records)
  if (wire.length === 0) return null
  const batch = {
    schema_version: version,
    batch_id: randomUUID(),
    resource,
    records: wire
  }
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
            // A weighted mean of the samples cannot exceed the largest one,
            // but summing equal products and dividing can land one ulp above
            // it, and the contract rejects average > max. A flat idle RSS
            // window is the common case, so the unclamped form would discard
            // the whole five-minute batch rather than one series.
            average: Math.min(g.max, g.sum / g.coverage),
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
