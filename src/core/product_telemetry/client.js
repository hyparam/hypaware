// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  cliSurface,
  createProductResource,
  createRuntimeSummary,
  errorCode,
  productBatch,
  productEvent
} from './collection.js'
import { createOutbox, readSmallJson } from './outbox.js'
import { createDelivery, receiverVersions } from './delivery.js'
import { effectivePolicy, productRoot } from './policy.js'
import { COMMANDS, MAX_BATCH_BYTES, MAX_RECORDS, QUERY_TOOLS } from './contract.js'
import { isHelpFlag } from '../cli/group_help.js'
import { atomicWriteJsonSync } from '../util/fs_atomic.js'

// Commands that read captured data. `query schema` only describes tables.
const QUERY_COMMANDS = [
  'query graph neighbors',
  'query grep',
  'query overview',
  'query sql',
  'query vector search'
]

/** @type {AsyncLocalStorage<{invocation: {command:string,kind:string,degraded:boolean,query:Record<string,any>|null,errorCode:string|null,records:Record<string,any>[],flushers:(()=>void)[],surface:string,emit:(records:Record<string,any>[])=>void,milestone:(name:'first_capture'|'first_query')=>Record<string,any>|null,startDelivery:()=>void,setAdapters:(adapters:string[])=>void}, depth:number}>} */
const invocationContext = new AsyncLocalStorage()

/**
 * `query` carries a finished query's fields (see `queryResult`); `error` is a
 * failure the boundary classifies by class or code, with `fallback` used when
 * it cannot.
 * @param {{command?:string,kind?:string,degraded?:boolean,adapters?:string[],query?:Record<string,any>,error?:unknown,fallback?:string}} value
 */
export function noteInvocation(value) {
  const current = invocationContext.getStore()
  if (!current || current.depth > 1) return
  if (value.command !== undefined)
    current.invocation.command = COMMANDS.includes(value.command)
      ? value.command
      : 'other'
  if (value.kind !== undefined) current.invocation.kind = value.kind
  if (value.degraded) current.invocation.degraded = true
  if (value.adapters) current.invocation.setAdapters(value.adapters)
  if (value.query) current.invocation.query = value.query
  if (value.error !== undefined)
    current.invocation.errorCode =
      errorCode(value.error) ?? value.fallback ?? current.invocation.errorCode
}

/** The surface a query from this invocation reports: `cli` or `agent_shell`. */
export function invocationSurface() {
  return invocationContext.getStore()?.invocation.surface ?? 'unknown'
}

/** @param {number} code */
function outcome(code) {
  return code === 130 || code === 143
    ? 'cancelled'
    : code === 0
      ? 'success'
      : 'failure'
}

/**
 * Explicit outer boundary includes help, version and boot failure. Nested
 * dispatch is a bounded setup step, never another invocation event.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {()=>Promise<number>} run
 * @param {{startedAt?:number, outer?:boolean}} [options]
 */
export async function withProductInvocation(
  argv,
  env,
  run,
  { startedAt = performance.now(), outer = false } = {}
) {
  const current = invocationContext.getStore()
  if (current) {
    const code = await invocationContext.run(
      { invocation: current.invocation, depth: current.depth + 1 },
      run
    )
    // A nested help render (setup routing a non-leading --help back through
    // the central interception) shows help and changes nothing, so it is not
    // a setup step.
    if (current.depth > 0 && !isHelpFlag(argv[1]) && current.invocation.records.length < 16) {
      const name = argv[0]
      const step =
        name === 'attach' || name === 'client attach'
          ? 'attach'
          : name === 'join'
            ? 'enroll'
            : name?.includes('install')
              ? 'install'
              : 'configure'
      const event = productEvent('setup.step', {
        step,
        outcome: outcome(code),
        duration_ms: performance.now() - startedAt
      })
      if (event) current.invocation.records.push(event)
    }
    return code
  }
  const client = createProductClient({ env })
  // Collection is off on standalone installs, and a disabled client discards every
  // record. Entering the async context is not free - it costs each `await`
  // continuation in the process, and `daemon run` spends its whole life inside
  // this frame - so an off installation skips the boundary entirely.
  if (!client.enabled) return run()
  const state = {
    command: 'unknown',
    kind: 'unknown',
    degraded: false,
    query: /** @type {Record<string,any>|null} */ (null),
    errorCode: /** @type {string|null} */ (null),
    records: /** @type {Record<string,any>[]} */ ([]),
    flushers: /** @type {(()=>void)[]} */ ([]),
    surface: cliSurface(env),
    emit: client.emit,
    milestone: client.milestone,
    startDelivery: client.startDelivery,
    setAdapters: client.setAdapters
  }
  let code = 1
  try {
    code = await invocationContext.run(
      { invocation: state, depth: outer ? 0 : 1 },
      run
    )
    return code
  } finally {
    const result = outcome(code)
    const summary = productEvent('cli.invocation', {
      command: state.command,
      invocation_kind: state.kind,
      outcome: result === 'success' && state.degraded ? 'degraded' : result,
      exit_class:
        result === 'cancelled' ? 'cancelled' : code === 0 ? 'zero' : 'nonzero',
      duration_ms: performance.now() - startedAt,
      query: state.query
    })
    if (summary) state.records.push(summary)
    if (
      result === 'success' &&
      state.kind === 'execution' &&
      QUERY_COMMANDS.includes(state.command)
    ) {
      const reached = client.milestone('first_query')
      if (reached) state.records.push(reached)
    }
    if (code !== 0 && result !== 'cancelled') {
      const failure = productEvent('coded.failure', {
        component: 'cli',
        operation: 'start',
        error_code:
          state.kind === 'unknown' ? 'startup_failed' : (state.errorCode ?? 'other'),
        occurrence_count: 1
      })
      if (failure) state.records.push(failure)
    }
    for (const flush of state.flushers) flush()
    // @ref LLP 0561#hooks [implements]: a successful hook run queues nothing
    if (!(result === 'success' && state.command.startsWith('claude-hook ')))
      client.emit(state.records)
    client.close()
  }
}

/**
 * A client is cheap and inert while disabled. Its initial binding is immutable;
 * a change observed later stops collection until a fresh client is constructed.
 * @param {{env?:NodeJS.ProcessEnv,role?:'cli'|'daemon',now?:()=>number}} [options]
 */
export function createProductClient({
  env = process.env,
  role = 'cli',
  now = Date.now
} = {}) {
  const root = productRoot(env)
  const initial = effectivePolicy(root)
  const resource = createProductResource({ role, env })
  const queue = createOutbox(root, { now })
  const delivery = createDelivery(root, { now })
  let closed = false
  let inventoryDue = true
  let adapters = /** @type {string[]} */ ([])
  // Organization queues are maintained by eligible sends and the daemon's
  // five-minute flush, so foreground startup never duplicates that scan.
  if (initial.mode === 'local') {
    try {
      queue.prune(initial.binding)
    } catch {}
  }
  /** @type {NodeJS.Timeout|null} */
  let timer = null
  /** Milestones this process has seen recorded, so a reached one costs no read. */
  const reached = new Set()
  /**
   * The installation.milestone event the first time `name` is reached in this
   * consent generation, else null. The marker is re-read before each write so a
   * CLI and the daemon recording different milestones do not erase each other.
   * @ref LLP 0561#milestones [implements]: once per consent generation, marked before it is queued
   * @param {'first_capture'|'first_query'} name
   */
  function milestone(name) {
    if (closed || !initial.binding || reached.has(name)) return null
    try {
      const file = path.join(root, 'milestones.json')
      const saved = readSmallJson(file, 4096)
      const marked =
        saved?.binding === initial.binding && Array.isArray(saved.reached)
          ? saved.reached.filter((v) => typeof v === 'string').slice(0, 8)
          : []
      if (marked.includes(name)) {
        reached.add(name)
        return null
      }
      const event = productEvent('installation.milestone', { milestone: name }, now())
      if (!event) return null
      atomicWriteJsonSync(
        file,
        { version: 1, binding: initial.binding, reached: [...marked, name] },
        { mode: 0o600, dirMode: 0o700 }
      )
      reached.add(name)
      return event
    } catch {
      return null
    }
  }
  /** @param {Record<string,any>[]} records */
  function emit(records) {
    if (
      closed ||
      !initial.binding ||
      effectivePolicy(root).binding !== initial.binding
    )
      return
    try {
      const inventory = inventoryDue
        ? productEvent('installation.inventory', { adapters }, now())
        : null
      const all = inventory ? [inventory, ...records] : records
      // @ref LLP 0561#rollout [implements]: v2 records only once delivery saw this binding's receiver advertise v2
      const saved = queue.readDelivery()
      const version =
        saved?.binding === initial.binding &&
        receiverVersions(saved).includes(2)
          ? 2
          : 1
      // A buffered MCP flush can hold more than one slot's worth, so split
      // by records and, halving, by the slot's stored byte cap.
      for (let i = 0; i < all.length; ) {
        let n = Math.min(MAX_RECORDS, all.length - i)
        let batch = productBatch(resource, all.slice(i, i + n), now(), version)
        while (n > 1 && batch && storedBytes(batch) > MAX_BATCH_BYTES) {
          n = Math.ceil(n / 2)
          batch = productBatch(resource, all.slice(i, i + n), now(), version)
        }
        if (batch && queue.append(batch, initial.binding) && i === 0)
          inventoryDue = false
        i += n
      }
      if (effectivePolicy(root).binding !== initial.binding)
        queue.prune(effectivePolicy(root).binding)
    } catch {
      queue.noteDrop()
    }
  }
  function startDelivery() {
    if (initial.mode === 'organization') void delivery.drain()
  }
  if (role === 'daemon' && initial.binding) {
    activeCollectors++
    const runtime = createRuntimeSummary({ now })
    let lastFlush = now()
    let lastInventory = now()
    timer = setInterval(() => {
      try {
        if (effectivePolicy(root).binding !== initial.binding) {
          close()
          queue.prune(effectivePolicy(root).binding)
          return
        }
        runtime.sample()
        const time = now()
        if (time - lastInventory >= 86400_000) {
          inventoryDue = true
          lastInventory = time
        }
        if (time - lastFlush >= 300_000) {
          queue.prune(initial.binding)
          const heartbeat = productEvent(
            'heartbeat',
            { uptime_s: process.uptime() },
            time
          )
          const captured =
            pipeline.write.rows > 0 ? milestone('first_capture') : null
          emit([
            ...(captured ? [captured] : []),
            ...runtime.flush(),
            ...flushPipeline(lastFlush, time),
            ...(heartbeat ? [heartbeat] : [])
          ])
          lastFlush = time
        }
        startDelivery()
      } catch {
        /* Never interrupt capture or source lifecycle. */
      }
    }, 30_000)
    timer.unref()
    startDelivery()
  }
  function pause() {
    if (timer) {
      clearInterval(timer)
      activeCollectors--
      if (activeCollectors === 0) {
        for (const counts of Object.values(pipeline)) {
          counts.rows = 0
          counts.bytes = 0
          counts.failures = 0
        }
        pending.clear()
        for (const stage of Object.keys(lastSuccess)) delete lastSuccess[stage]
      }
    }
    timer = null
    delivery.close()
  }
  function close() {
    if (closed) return
    pause()
    closed = true
  }
  return {
    enabled: Boolean(initial.binding),
    emit,
    startDelivery,
    pause,
    milestone,
    setAdapters(values) {
      adapters = values.slice(0, 32)
      inventoryDue = true
    },
    close
  }
}

// Maintained counters, updated only where work already succeeded or failed.
// There are three stages and three sums, independent of datasets and plugins.
const pipeline = {
  capture: { rows: 0, bytes: 0, failures: 0 },
  write: { rows: 0, bytes: 0, failures: 0 },
  export: { rows: 0, bytes: 0, failures: 0 }
}
let activeCollectors = 0
/** @type {Map<string,{bytes:number,since:number}>} */
const pending = new Map()
/** @type {Record<string,number>} */
const lastSuccess = {}
/** Maintained observations only; never discover cache tables for telemetry.
 * @param {string} key @param {number} bytes */
export function noteProductPending(key, bytes) {
  if (!activeCollectors) return
  if (!Number.isFinite(bytes) || bytes < 0) return
  if (bytes === 0) {
    pending.delete(key)
    return
  }
  if (!pending.has(key) && pending.size >= 128) return
  pending.set(key, { bytes, since: pending.get(key)?.since ?? Date.now() })
}
/** @param {'capture'|'write'|'export'} stage @param {{rows?:number,bytes?:number,failures?:number}} values */
export function noteProductPipeline(stage, values) {
  if (!activeCollectors) return
  const target = pipeline[stage]
  if ((values.rows ?? 0) > 0 || (values.bytes ?? 0) > 0)
    lastSuccess[stage] = Date.now()
  for (const key of ['rows', 'bytes', 'failures']) {
    const value = values[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
      target[key] = Math.min(
        key === 'bytes' ? 1e12 : key === 'rows' ? 1e9 : 1e6,
        target[key] + Math.floor(value)
      )
  }
}
/** @param {number} start @param {number} end */
function flushPipeline(start, end) {
  const records = []
  for (const [stage, counts] of Object.entries(pipeline)) {
    for (const key of ['rows', 'bytes', 'failures']) {
      const value = counts[key]
      counts[key] = 0
      if (!value || end <= start || end - start > 600_000) continue
      records.push({
        kind: 'metric',
        timestamp: new Date(end).toISOString(),
        startTimestamp: new Date(start).toISOString(),
        name: `pipeline.${key}`,
        unit: key === 'rows' ? '{row}' : key === 'bytes' ? 'By' : '{failure}',
        type: 'sum',
        aggregationTemporality: 'delta',
        value,
        attributes: { stage }
      })
    }
  }
  if (end > start && end - start <= 600_000) {
    const gauge = (name, unit, stage, value) =>
      records.push({
        kind: 'metric',
        timestamp: new Date(end).toISOString(),
        startTimestamp: new Date(start).toISOString(),
        name,
        unit,
        type: 'gauge',
        attributes: { stage },
        value,
        average: value,
        max: value,
        sampleCount: 1,
        coverageMs: 1
      })
    if (pending.size) {
      const values = [...pending.values()]
      gauge(
        'pipeline.pending',
        'By',
        'write',
        Math.min(
          1e12,
          values.reduce((n, p) => n + p.bytes, 0)
        )
      )
      gauge(
        'pipeline.oldest_age',
        's',
        'write',
        Math.min(
          90 * 86400,
          Math.max(0, (end - Math.min(...values.map((p) => p.since))) / 1000)
        )
      )
    }
    for (const [stage, at] of Object.entries(lastSuccess))
      gauge(
        'pipeline.freshness',
        's',
        stage,
        Math.min(90 * 86400, Math.max(0, (end - at) / 1000))
      )
  }
  return records
}

/** The outbox slot's size for `batch`, as `append` measures it. @param {Record<string,any>} batch */
function storedBytes(batch) {
  return Buffer.byteLength(
    JSON.stringify({ binding: 'f'.repeat(64), wire: JSON.stringify(batch) })
  )
}

// @ref LLP 0561#mcp [implements]: buffered in the serving process, appended once a minute or every 100 records
export const MCP_FLUSH_MS = 60_000
export const MCP_FLUSH_RECORDS = 100

/**
 * A buffer for `mcp.tool_call` records in a long-lived `hyp mcp serve`, or null
 * when collection is off. Per call it builds one small record; the outbox is
 * touched only on flush, which the invocation boundary also runs on shutdown.
 * @param {{now?:()=>number}} [options]
 */
export function createMcpCallRecorder({ now = Date.now } = {}) {
  const current = invocationContext.getStore()
  if (!current || current.depth > 1) return null
  const invocation = current.invocation
  /** @type {Record<string,any>[]} */
  let buffer = []
  /** @type {NodeJS.Timeout|null} */
  let timer = null
  function flush() {
    if (timer) clearTimeout(timer)
    timer = null
    if (buffer.length === 0) return
    const records = buffer
    buffer = []
    invocation.emit(records)
  }
  invocation.flushers.push(flush)
  return {
    /** @param {{tool:string,outcome:string,error?:unknown,duration_ms:number,query?:Record<string,any>}} call */
    record(call) {
      const tool = QUERY_TOOLS.includes(call.tool) ? call.tool : null
      const event = productEvent(
        'mcp.tool_call',
        {
          tool: call.tool,
          outcome: call.outcome,
          error_code:
            call.error == null
              ? 'other'
              : (errorCode(call.error) ?? (tool ? 'query_failed' : 'other')),
          duration_ms: call.duration_ms,
          query: call.query
        },
        now()
      )
      if (!event) return
      buffer.push(event)
      // @ref LLP 0561#milestones [implements]: a successful MCP query counts toward first_query
      if (tool && call.outcome === 'success') {
        const reached = invocation.milestone('first_query')
        if (reached) buffer.push(reached)
      }
      if (buffer.length >= MCP_FLUSH_RECORDS) flush()
      else if (!timer) {
        timer = setTimeout(flush, MCP_FLUSH_MS)
        timer.unref()
      }
    },
    flush
  }
}

/** Called once ordinary dispatch has begun; help/version never start a send. */
export function startInvocationDelivery() {
  invocationContext.getStore()?.invocation.startDelivery()
}

/** @param {string} command @param {string[]} args @param {number} code */
export function noteCommandTransition(command, args, code) {
  const current = invocationContext.getStore()
  if (!current || current.invocation.records.length >= 16) return
  /** @type {Record<string,any>|null} */
  let event = null
  if (command === 'join' || command === 'leave')
    event = productEvent('enrollment', {
      operation: command,
      outcome: outcome(code)
    })
  if (command === 'client attach' || command === 'client detach') {
    const adapter = args.find((v) =>
      [
        'claude',
        'claude-code',
        'claude-desktop',
        'codex',
        'opencode',
        'openclaw',
        'hermes'
      ].includes(v)
    )
    event = productEvent('client.attachment', {
      operation: command.endsWith('detach') ? 'detach' : 'attach',
      adapter: adapter === 'claude' ? 'claude-code' : adapter,
      outcome: outcome(code)
    })
  }
  if (event) current.invocation.records.push(event)
}

/** @param {Array<{name:string,enabled?:boolean}>} plugins */
export function productAdapters(plugins) {
  const names = [
    'claude',
    'claude-desktop',
    'codex',
    'opencode',
    'openclaw',
    'hermes'
  ]
  return plugins
    .filter(
      (p) =>
        p.enabled !== false && names.some((n) => p.name === `@hypaware/${n}`)
    )
    .map((p) =>
      p.name === '@hypaware/claude'
        ? 'claude-code'
        : p.name.slice('@hypaware/'.length)
    )
}
