// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  DATASET_NAME,
  aiGatewayDatasetRegistration,
  dedupeStoredPartIds,
} from '../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import {
  SESSION_INDEX_REBUILD_MS,
  createAiGatewayMessageProjector,
} from '../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createClaudeSettlementEnricher } from '../hypaware-core/plugins-workspace/claude/src/settle.js'
import { matchKey } from '../hypaware-core/plugins-workspace/claude/src/transcripts.js'
import { createQueryStorageService } from '../src/core/cache/storage.js'

const PROFILES = Object.freeze({
  quick: {
    cacheRows: 30_000,
    ingestBatches: 3,
    incomingRows: 8,
    transcriptRows: 3_000,
    settlementCalls: 3,
    settlementRows: 8,
  },
  normal: {
    cacheRows: 300_000,
    ingestBatches: 6,
    incomingRows: 8,
    transcriptRows: 30_000,
    settlementCalls: 6,
    settlementRows: 8,
  },
  stress: {
    cacheRows: 1_000_000,
    ingestBatches: 12,
    incomingRows: 8,
    transcriptRows: 100_000,
    settlementCalls: 12,
    settlementRows: 8,
  },
})

const CACHE_COLUMNS = Object.freeze([
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'conversation_id', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'conversation_source', type: 'STRING', nullable: true },
  { name: 'provider', type: 'STRING', nullable: true },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'part_index', type: 'INT32', nullable: false },
])

const args = parseArgs(process.argv.slice(2))
const profile = { ...PROFILES[args.profile], ...args.overrides }
const scenarios = args.scenario === 'all'
  ? ['otel-dedupe', 'session-index', 'settlement']
  : [args.scenario]

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-normal-cpu-'))
const output = {
  benchmark: 'hypaware_normal_usage_cpu',
  profile: args.profile,
  config: profile,
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    cpu_model: os.cpus()[0]?.model ?? 'unknown',
  },
  setup: {},
  scenarios: {},
  target: {},
}

try {
  let cache
  if (scenarios.some((name) => name === 'otel-dedupe' || name === 'session-index')) {
    cache = await stageCache(root, profile.cacheRows)
    output.setup = cache.setup
  }

  if (scenarios.includes('otel-dedupe')) {
    output.scenarios['otel-dedupe'] = await measureOtelDedupe(cache.storage, profile)
  }
  if (scenarios.includes('session-index')) {
    output.scenarios['session-index'] = await measureSessionIndex(cache.storage, profile)
  }
  if (scenarios.includes('settlement')) {
    output.scenarios.settlement = await measureSettlement(root, profile)
  }

  output.target = assessTarget(output.scenarios)
  output.process_peak_rss_mib = round(process.resourceUsage().maxRSS / 1024, 1)
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  if (args.assertTarget && !output.target.pass) process.exitCode = 1
} finally {
  if (!args.keep) await fs.rm(root, { recursive: true, force: true })
  else process.stderr.write(`kept benchmark fixture at ${root}\n`)
}

/**
 * Stage a real Iceberg cache. Setup is excluded from scenario timings.
 *
 * @param {string} root
 * @param {number} rowCount
 */
async function stageCache(root, rowCount) {
  const cacheRoot = path.join(root, 'cache')
  const declaration = aiGatewayDatasetRegistration().cachePartitioning
  const storage = createQueryStorageService({
    cacheRoot,
    getDeclaration: (dataset) => dataset === DATASET_NAME ? declaration : undefined,
  })
  const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v5'])
  const chunkSize = 10_000
  const started = performance.now()
  for (let base = 0; base < rowCount; base += chunkSize) {
    const length = Math.min(chunkSize, rowCount - base)
    const rows = Array.from({ length }, (_, offset) => {
      const index = base + offset
      const messageId = `old-${index}`
      return {
        session_id: `session-${Math.floor(index / 100)}`,
        conversation_id: null,
        cwd: '/benchmark',
        date: benchmarkDate(index),
        client_name: 'claude',
        conversation_source: 'otel',
        provider: 'anthropic',
        message_id: messageId,
        part_id: `${messageId}#0`,
        part_index: 0,
      }
    })
    await storage.appendRows(tablePath, [...CACHE_COLUMNS], rows)
  }
  await storage.flushAll({ force: true, reason: 'normal_usage_cpu_fixture' })
  const partitions = await storage.discoverCachePartitions({ datasets: [DATASET_NAME] })
  return {
    storage,
    setup: {
      cache_rows: rowCount,
      cache_partitions: partitions.length,
      elapsed_ms: round(performance.now() - started, 1),
    },
  }
}

/**
 * Exercise the exact pre-write membership function used by the Claude OTEL
 * projected-exchange writer. Every batch uses new keys, the normal ingest
 * case and the worst case for an early-stop scan.
 *
 * @param {ReturnType<typeof createQueryStorageService>} storage
 * @param {typeof PROFILES.normal} profile
 */
async function measureOtelDedupe(storage, profile) {
  const observed = instrumentStorage(storage)
  const samples = []
  let rowsReturned = 0
  for (let batchIndex = 0; batchIndex < profile.ingestBatches; batchIndex++) {
    const rows = Array.from({ length: profile.incomingRows }, (_, rowIndex) => {
      // One duplicate is deliberately far outside a recent-date window. The
      // optimized lookup must still find it through the session sort key;
      // every other row is a fresh key, the steady-state ingest case.
      const historicalDuplicate = batchIndex === 0 && rowIndex === 0
      const messageId = historicalDuplicate ? 'old-0' : `otel-new-${batchIndex}-${rowIndex}`
      return {
        session_id: historicalDuplicate ? 'session-0' : `otel-session-${batchIndex}`,
        conversation_id: null,
        cwd: '/benchmark',
        date: '2026-08-27',
        client_name: 'claude',
        conversation_source: 'otel',
        provider: 'anthropic',
        message_id: messageId,
        part_id: `${messageId}#0`,
        part_index: 0,
      }
    })
    const measured = await measure(async () => dedupeStoredPartIds(rows, observed.storage))
    rowsReturned += measured.value.length
    samples.push(measured.sample)
  }
  const committedRowsRead = observed.counts.committedRows
  return {
    batches: profile.ingestBatches,
    incoming_rows: profile.ingestBatches * profile.incomingRows,
    rows_returned: rowsReturned,
    historical_duplicate_rows_skipped:
      profile.ingestBatches * profile.incomingRows - rowsReturned,
    committed_rows_read: committedRowsRead,
    spooled_rows_read: observed.counts.spooledRows,
    targeted_reads: observed.counts.targetedReads,
    committed_table_passes: ratio(committedRowsRead, profile.cacheRows),
    scan_amplification: ratio(committedRowsRead, profile.ingestBatches * profile.incomingRows),
    timing_ms: summarize(samples.map((sample) => sample.wallMs)),
    cpu_ms: summarize(samples.map((sample) => sample.cpuMs)),
  }
}

/**
 * Exercise the public projector path that owns the committed-session index.
 * Two fresh-session misses are separated by the ten-minute rebuild window.
 *
 * @param {ReturnType<typeof createQueryStorageService>} storage
 * @param {typeof PROFILES.normal} profile
 */
async function measureSessionIndex(storage, profile) {
  const observed = instrumentStorage(storage)
  let clockMs = 0
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'cpu-benchmark',
    projectors: [benchmarkProjector()],
    storage: observed.storage,
    now: () => clockMs,
  })
  const first = await measure(() => projector.projectExchange(benchmarkExchange('fresh-before-window')))
  clockMs = SESSION_INDEX_REBUILD_MS + 1
  const second = await measure(() => projector.projectExchange(benchmarkExchange('fresh-after-window')))
  const samples = [first.sample, second.sample]
  return {
    fresh_session_misses: 2,
    rebuild_window_ms: SESSION_INDEX_REBUILD_MS,
    rows_returned: first.value.length + second.value.length,
    committed_rows_read: observed.counts.committedRows,
    committed_table_passes: ratio(observed.counts.committedRows, profile.cacheRows),
    requested_columns: observed.counts.requestedColumns,
    targeted_reads: observed.counts.targetedReads,
    timing_ms: summarize(samples.map((sample) => sample.wallMs)),
    cpu_ms: summarize(samples.map((sample) => sample.cpuMs)),
  }
}

/**
 * Exercise Claude settlement with many rows from one session. The enricher
 * groups them and loads the transcript once per settle call, not once per row.
 * Repeating the call exposes whether unchanged transcripts are reread.
 *
 * @param {string} root
 * @param {typeof PROFILES.normal} profile
 */
async function measureSettlement(root, profile) {
  const homeDir = path.join(root, 'home')
  const transcriptDir = path.join(homeDir, '.claude', 'projects', 'bench')
  const transcriptPath = path.join(transcriptDir, 'settlement-session.jsonl')
  const stateFile = path.join(root, 'state', 'session-context.jsonl')
  await fs.mkdir(transcriptDir, { recursive: true })
  await fs.mkdir(path.dirname(stateFile), { recursive: true })

  const handle = await fs.open(transcriptPath, 'w')
  try {
    for (let index = 0; index < profile.transcriptRows; index++) {
      await handle.write(`${JSON.stringify(transcriptLine(index))}\n`)
    }
  } finally {
    await handle.close()
  }
  await fs.writeFile(stateFile, `${JSON.stringify({
    session_id: 'settlement-session',
    transcript_path: transcriptPath,
    cwd: '/benchmark',
    ts: '2026-08-27T00:00:00.000Z',
  })}\n`, 'utf8')

  const enricher = createClaudeSettlementEnricher({ homeDir, stateFile })
  const rows = Array.from({ length: profile.settlementRows }, (_, index) => settlementRow(index))
  const cold = await measure(() => enricher.settle(rows, /** @type {any} */ ({})))
  const samples = []
  let upgradedRows = 0
  for (let call = 0; call < profile.settlementCalls; call++) {
    const measured = await measure(() => enricher.settle(rows, /** @type {any} */ ({})))
    upgradedRows += measured.value.filter((row, index) => row !== rows[index]).length
    samples.push(measured.sample)
  }
  await fs.appendFile(
    transcriptPath,
    `${JSON.stringify(transcriptLine(profile.transcriptRows))}\n`,
    'utf8',
  )
  const appendedRow = settlementRow(profile.transcriptRows)
  const appended = await measure(() => enricher.settle([appendedRow], /** @type {any} */ ({})))
  const appendedUpgraded = appended.value[0] !== appendedRow
  const transcriptBytes = (await fs.stat(transcriptPath)).size
  return {
    transcript_rows: profile.transcriptRows,
    transcript_bytes: transcriptBytes,
    settle_calls: profile.settlementCalls,
    rows_per_call: profile.settlementRows,
    rows_settled: profile.settlementCalls * profile.settlementRows,
    rows_upgraded: upgradedRows,
    cold_timing_ms: round(cold.sample.wallMs, 2),
    cold_cpu_ms: round(cold.sample.cpuMs, 2),
    warm_median_to_cold_cpu_ratio: ratio(
      summarize(samples.map((sample) => sample.cpuMs)).median,
      cold.sample.cpuMs,
    ),
    appended_row_upgraded: appendedUpgraded,
    appended_tail_cpu_ms: round(appended.sample.cpuMs, 2),
    appended_tail_to_cold_cpu_ratio: ratio(appended.sample.cpuMs, cold.sample.cpuMs),
    current_design_equivalent_transcript_bytes: transcriptBytes * profile.settlementCalls,
    timing_ms: summarize(samples.map((sample) => sample.wallMs)),
    cpu_ms: summarize(samples.map((sample) => sample.cpuMs)),
  }
}

/** @param {number} index */
function transcriptLine(index) {
  return {
    sessionId: 'settlement-session',
    uuid: `native-${index}`,
    parentUuid: index > 0 ? `native-${index - 1}` : null,
    type: 'assistant',
    message: {
      id: `api-${index}`,
      role: 'assistant',
      content: [{ type: 'text', text: `answer-${index}` }],
    },
    timestamp: new Date(1_777_500_000_000 + index).toISOString(),
  }
}

/** @param {number} index */
function settlementRow(index) {
  const text = `answer-${index}`
  return {
    session_id: 'settlement-session',
    client_name: 'claude',
    message_id: `fallback-${index}`,
    part_id: `fallback-${index}#0`,
    part_index: 0,
    role: 'assistant',
    cwd: '/benchmark',
    attributes: {
      gateway: { identity_source: 'gateway_fallback' },
      claude: { match_key: matchKey('assistant', [{ type: 'text', text }]) },
    },
  }
}

/**
 * Spread fixture history across 30 days while keeping 2026-08-27 as the live
 * edge. A date-scoped fix can therefore prove its work is bounded by recent
 * data instead of accidentally benchmarking one giant historical partition.
 *
 * @param {number} index
 */
function benchmarkDate(index) {
  const day = 29 + (index % 30)
  return new Date(Date.UTC(2026, 6, day)).toISOString().slice(0, 10)
}

function benchmarkProjector() {
  return {
    name: 'cpu-benchmark',
    priority: 0,
    _seq: 0,
    match: () => true,
    project: (input) => ({
      provider: 'benchmark',
      session_id: String(input.path),
      messages: [{
        role: 'user',
        content: 'normal usage',
        message_id: `native-${input.path}`,
      }],
    }),
  }
}

/** @param {string} sessionId */
function benchmarkExchange(sessionId) {
  return {
    exchange_id: `exchange-${sessionId}`,
    method: 'POST',
    path: sessionId,
    request_headers: {},
    request_body: '{}',
    status_code: 200,
    response_headers: {},
    response_body: '{}',
    is_sse: false,
  }
}

/**
 * Count rows crossing the storage API while preserving the real implementation.
 *
 * @param {ReturnType<typeof createQueryStorageService>} storage
 */
function instrumentStorage(storage) {
  const counts = {
    committedRows: 0,
    spooledRows: 0,
    targetedReads: 0,
    /** @type {Record<string, number>} */
    requestedColumns: {},
  }
  const wrapped = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'readRows') {
        return async function* (...readArgs) {
          const columns = Array.isArray(readArgs[1]) ? readArgs[1] : []
          const key = columns.join(',') || '*'
          counts.requestedColumns[key] = (counts.requestedColumns[key] ?? 0) + 1
          for await (const row of target.readRows(...readArgs)) {
            counts.committedRows++
            yield row
          }
        }
      }
      if (property === 'readRowsWhere') {
        if (typeof target.readRowsWhere !== 'function') return undefined
        return async function* (...readArgs) {
          const columns = Array.isArray(readArgs[1]) ? readArgs[1] : []
          const key = columns.join(',') || '*'
          counts.requestedColumns[key] = (counts.requestedColumns[key] ?? 0) + 1
          counts.targetedReads++
          for await (const row of target.readRowsWhere(...readArgs)) {
            counts.committedRows++
            yield row
          }
        }
      }
      if (property === 'readSpooledRows') {
        return async function* (...readArgs) {
          for await (const row of target.readSpooledRows(...readArgs)) {
            counts.spooledRows++
            yield row
          }
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return { storage: wrapped, counts }
}

/** @template T @param {() => Promise<T>} fn */
async function measure(fn) {
  const cpuStart = process.cpuUsage()
  const wallStart = performance.now()
  const value = await fn()
  const wallMs = performance.now() - wallStart
  const cpu = process.cpuUsage(cpuStart)
  return {
    value,
    sample: {
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
    },
  }
}

/** @param {number[]} values */
function summarize(values) {
  const ordered = [...values].sort((a, b) => a - b)
  const total = ordered.reduce((sum, value) => sum + value, 0)
  return {
    samples: values.length,
    total: round(total, 2),
    min: round(ordered[0] ?? 0, 2),
    median: round(percentile(ordered, 0.5), 2),
    p95: round(percentile(ordered, 0.95), 2),
    max: round(ordered.at(-1) ?? 0, 2),
  }
}

/** @param {number[]} ordered @param {number} quantile */
function percentile(ordered, quantile) {
  if (ordered.length === 0) return 0
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)
  return ordered[Math.max(0, index)]
}

/** @param {Record<string, any>} measured */
function assessTarget(measured) {
  const checks = []
  const dedupe = measured['otel-dedupe']
  if (dedupe) {
    checks.push({
      name: 'otel_dedupe_uses_one_targeted_read_per_batch',
      actual: dedupe.targeted_reads,
      limit: dedupe.batches,
      pass: dedupe.targeted_reads === dedupe.batches,
    })
    checks.push({
      name: 'otel_dedupe_reads_only_the_matching_fixture_session',
      actual: dedupe.committed_rows_read,
      limit: 100,
      pass: dedupe.committed_rows_read <= 100,
    })
    checks.push({
      name: 'otel_dedupe_finds_same_session_duplicate_outside_recent_date_window',
      actual: dedupe.historical_duplicate_rows_skipped,
      limit: 1,
      pass: dedupe.historical_duplicate_rows_skipped === 1,
    })
  }
  const index = measured['session-index']
  if (index) {
    checks.push({
      name: 'session_seed_uses_one_targeted_read_per_fresh_session',
      actual: index.targeted_reads,
      limit: index.fresh_session_misses,
      pass: index.targeted_reads === index.fresh_session_misses,
    })
    checks.push({
      name: 'session_seed_reads_no_rows_for_fresh_sessions',
      actual: index.committed_rows_read,
      limit: 0,
      pass: index.committed_rows_read === 0,
    })
  }
  const settlement = measured.settlement
  if (settlement) {
    checks.push({
      name: 'unchanged_transcript_warm_cpu_at_most_quarter_of_cold',
      actual: settlement.warm_median_to_cold_cpu_ratio,
      limit: 0.25,
      pass: settlement.warm_median_to_cold_cpu_ratio <= 0.25,
    })
    checks.push({
      name: 'appended_transcript_tail_cpu_at_most_quarter_of_cold',
      actual: settlement.appended_tail_to_cold_cpu_ratio,
      limit: 0.25,
      pass: settlement.appended_row_upgraded && settlement.appended_tail_to_cold_cpu_ratio <= 0.25,
    })
  }
  return { pass: checks.every((check) => check.pass), checks }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  let profile = 'normal'
  let scenario = 'all'
  let keep = false
  let assertTarget = false
  /** @type {Record<string, number>} */
  const overrides = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--profile') profile = requiredValue(argv, ++index, arg)
    else if (arg === '--scenario') scenario = requiredValue(argv, ++index, arg)
    else if (arg === '--cache-rows') overrides.cacheRows = positiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--ingest-batches') overrides.ingestBatches = positiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--incoming-rows') overrides.incomingRows = positiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--transcript-rows') overrides.transcriptRows = positiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--settlement-calls') overrides.settlementCalls = positiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--settlement-rows') overrides.settlementRows = positiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--keep') keep = true
    else if (arg === '--assert-target') assertTarget = true
    else if (arg === '--help') {
      process.stdout.write(usage())
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`)
    }
  }
  if (!Object.hasOwn(PROFILES, profile)) {
    throw new Error(`--profile must be one of ${Object.keys(PROFILES).join('|')}`)
  }
  if (!['all', 'otel-dedupe', 'session-index', 'settlement'].includes(scenario)) {
    throw new Error('--scenario must be one of all|otel-dedupe|session-index|settlement')
  }
  return { profile, scenario, keep, assertTarget, overrides }
}

/** @param {string[]} argv @param {number} index @param {string} flag */
function requiredValue(argv, index, flag) {
  const value = argv[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

/** @param {string} value @param {string} flag */
function positiveInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

/** @param {number} numerator @param {number} denominator */
function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : round(numerator / denominator, 3)
}

/** @param {number} value @param {number} digits */
function round(value, digits) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function usage() {
  return `Usage: node benchmarks/normal-usage-cpu.mjs [options]\n\n` +
    `  --profile NAME           quick|normal|stress (default: normal)\n` +
    `  --scenario NAME          all|otel-dedupe|session-index|settlement\n` +
    `  --cache-rows N           override committed cache rows\n` +
    `  --ingest-batches N       override OTEL batches\n` +
    `  --incoming-rows N        override rows per OTEL batch\n` +
    `  --transcript-rows N      override Claude transcript rows\n` +
    `  --settlement-calls N     override bounded settlement calls\n` +
    `  --settlement-rows N      override rows per settlement call\n` +
    `  --assert-target          exit 1 until structural scan targets pass\n` +
    `  --keep                   preserve the generated fixture\n`
}
