// @ts-check

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { createAiGatewayMessageProjector } from '../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createClaudeExchangeProjector } from '../hypaware-core/plugins-workspace/claude/src/projector.js'
import { createTranscriptLoader } from '../hypaware-core/plugins-workspace/claude/src/transcript-cache.js'
import { loadTranscript } from '../hypaware-core/plugins-workspace/claude/src/transcripts.js'

const PROFILES = Object.freeze({
  quick: { transcriptRows: 3_000, subagentFiles: 3, subagentRows: 100, warmCalls: 3, concurrentSessions: 0, concurrentRows: 0 },
  normal: { transcriptRows: 30_000, subagentFiles: 30, subagentRows: 1_000, warmCalls: 6, concurrentSessions: 4, concurrentRows: 30_000 },
  stress: { transcriptRows: 100_000, subagentFiles: 50, subagentRows: 2_000, warmCalls: 12, concurrentSessions: 10, concurrentRows: 100_000 },
})

const args = parseArgs(process.argv.slice(2))
const profile = { ...PROFILES[args.profile], ...args.overrides }
const implementations = args.implementation === 'both' ? ['uncached', 'incremental'] : [args.implementation]
const devRunId = process.env.DEV_RUN_ID ?? `normal-cpu-${Date.now()}-${process.pid}`
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-normal-cpu-'))
const output = {
  benchmark: 'hypaware_normal_usage_cpu',
  smoke_name: 'claude_projector_transcript_cpu',
  dev_run_id: devRunId,
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
  implementations: {},
  comparison: {},
  target: {},
}

try {
  const fixture = await stageFixture(root, profile)
  output.setup = fixture.setup
  for (const implementation of implementations) {
    output.implementations[implementation] = await measureImplementation(fixture, profile, implementation)
  }
  output.comparison = compareImplementations(output.implementations)
  output.target = assessTarget(output.implementations)
  output.process_peak_rss_mib = round(process.resourceUsage().maxRSS / 1024, 1)
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  if (args.assertTarget && !output.target.pass) process.exitCode = 1
} finally {
  if (!args.keep) await fsp.rm(root, { recursive: true, force: true })
  else process.stderr.write(`kept benchmark fixture at ${root}\n`)
}

/**
 * Stage a real Claude session transcript plus its sibling subagent tree. The
 * main file and every subagent file are part of each projector load, matching
 * the live path described in LLP 0026 and the PR 1046 hot-path claim.
 *
 * @param {string} rootDir
 * @param {typeof PROFILES.normal} config
 */
async function stageFixture(rootDir, config) {
  const homeDir = path.join(rootDir, 'home')
  const projectsDir = path.join(homeDir, '.claude', 'projects', 'bench')
  const stateFile = path.join(rootDir, 'state', 'session-context.jsonl')
  const sessionId = 'normal-cpu-session'
  const transcriptPath = path.join(projectsDir, `${sessionId}.jsonl`)
  await fsp.mkdir(projectsDir, { recursive: true })
  await fsp.mkdir(path.dirname(stateFile), { recursive: true })

  const started = performance.now()
  await writeTranscript(transcriptPath, sessionId, config.transcriptRows)
  const subagentDir = path.join(projectsDir, sessionId, 'subagents')
  await fsp.mkdir(subagentDir, { recursive: true })
  for (let file = 0; file < config.subagentFiles; file++) {
    await writeTranscript(
      path.join(subagentDir, `agent-${file}.jsonl`),
      sessionId,
      config.subagentRows,
      { agentId: `agent-${file}`, start: config.transcriptRows + file * config.subagentRows },
    )
  }

  const concurrent = []
  for (let index = 0; index < config.concurrentSessions; index++) {
    const concurrentSessionId = `cold-session-${index}`
    const filePath = path.join(projectsDir, `${concurrentSessionId}.jsonl`)
    await writeTranscript(filePath, concurrentSessionId, config.concurrentRows)
    concurrent.push({ sessionId: concurrentSessionId, transcriptPath: filePath })
  }
  const records = [
    { session_id: sessionId, transcript_path: transcriptPath, cwd: '/benchmark', ts: '2026-08-27T00:00:00.000Z' },
    ...concurrent.map((entry, index) => ({
      session_id: entry.sessionId,
      transcript_path: entry.transcriptPath,
      cwd: '/benchmark',
      ts: new Date(Date.UTC(2026, 7, 27, 0, 0, index + 1)).toISOString(),
    })),
  ]
  await fsp.writeFile(stateFile, records.map((record) => JSON.stringify(record)).join('\n') + '\n')

  const sessionFiles = (await listJsonlFiles(projectsDir)).filter((file) =>
    file === transcriptPath || file.startsWith(path.join(projectsDir, sessionId) + path.sep)
  )
  const originalTranscriptSize = (await fsp.stat(transcriptPath)).size
  return {
    homeDir,
    projectsDir,
    stateFile,
    transcriptRoot: projectsDir,
    sessionId,
    transcriptPath,
    originalTranscriptSize,
    concurrent,
    setup: {
      smoke_step: 'stage',
      transcript_rows: config.transcriptRows,
      subagent_files: config.subagentFiles,
      subagent_rows: config.subagentFiles * config.subagentRows,
      transcript_bytes: await totalBytes(sessionFiles),
      concurrent_sessions: config.concurrentSessions,
      concurrent_rows_per_session: config.concurrentRows,
      elapsed_ms: round(performance.now() - started, 1),
    },
  }
}

/**
 * @param {Awaited<ReturnType<typeof stageFixture>>} fixture
 * @param {typeof PROFILES.normal} config
 * @param {string} implementation
 */
async function measureImplementation(fixture, config, implementation) {
  const transcriptLoader = implementation === 'uncached'
    ? { load: (opts) => loadTranscript(opts) }
    : createTranscriptLoader()
  const projector = createClaudeExchangeProjector({
    homeDir: fixture.homeDir,
    projectsDir: fixture.projectsDir,
    stateFile: fixture.stateFile,
    transcriptLoader,
  })
  const dispatcher = createAiGatewayMessageProjector({
    gatewayId: `cpu-benchmark-${implementation}`,
    projectors: [{ ...projector, _seq: 0 }],
  })

  const coldIndex = config.transcriptRows - config.warmCalls - 1
  const cold = await probeStep(fixture.transcriptRoot, 'cold', () =>
    dispatcher.projectExchange(exchange(fixture.sessionId, coldIndex)))
  assertNativeIdentity(cold.value, fixture.sessionId, coldIndex, 'cold')

  const warmSamples = []
  let warmBytes = 0
  for (let call = 0; call < config.warmCalls; call++) {
    const rowIndex = coldIndex + call + 1
    const warm = await probeStep(fixture.transcriptRoot, 'warm', () =>
      dispatcher.projectExchange(exchange(fixture.sessionId, rowIndex)))
    assertNativeIdentity(warm.value, fixture.sessionId, rowIndex, `warm-${call}`)
    warmSamples.push(warm.sample)
    warmBytes += warm.read.bytes
  }

  const appendedIndex = config.transcriptRows
  const appendedLine = `${JSON.stringify(transcriptLine(fixture.sessionId, appendedIndex))}\n`
  await fsp.appendFile(fixture.transcriptPath, appendedLine)
  const appended = await probeStep(fixture.transcriptRoot, 'append', () =>
    dispatcher.projectExchange(exchange(fixture.sessionId, appendedIndex)))
  assertNativeIdentity(appended.value, fixture.sessionId, appendedIndex, 'append')
  await fsp.truncate(fixture.transcriptPath, fixture.originalTranscriptSize)

  let concurrent = null
  if (fixture.concurrent.length > 0) {
    const concurrentProbe = await probeStep(fixture.transcriptRoot, 'concurrent', () =>
      Promise.all(fixture.concurrent.map((entry) =>
        dispatcher.projectExchange(exchange(entry.sessionId, config.concurrentRows - 1))
      )))
    for (let index = 0; index < concurrentProbe.value.length; index++) {
      assertNativeIdentity(
        concurrentProbe.value[index],
        fixture.concurrent[index].sessionId,
        config.concurrentRows - 1,
        `concurrent-${index}`,
      )
    }
    concurrent = {
      sessions: fixture.concurrent.length,
      transcript_bytes_read: concurrentProbe.read.bytes,
      max_concurrent_reads: concurrentProbe.read.maxConcurrent,
      wall_ms: round(concurrentProbe.sample.wallMs, 2),
      cpu_ms: round(concurrentProbe.sample.cpuMs, 2),
    }
  }

  const warmCpu = summarize(warmSamples.map((sample) => sample.cpuMs))
  return {
    implementation,
    cold: resultStep(cold),
    warm: {
      smoke_step: 'warm',
      calls: config.warmCalls,
      transcript_bytes_read: warmBytes,
      timing_ms: summarize(warmSamples.map((sample) => sample.wallMs)),
      cpu_ms: warmCpu,
      median_to_cold_cpu_ratio: ratio(warmCpu.median, cold.sample.cpuMs),
    },
    append: {
      ...resultStep(appended),
      appended_bytes: Buffer.byteLength(appendedLine),
      cpu_to_cold_ratio: ratio(appended.sample.cpuMs, cold.sample.cpuMs),
    },
    concurrent,
  }
}

/**
 * Count bytes crossing the real transcript stream boundary while the real
 * projector and gateway dispatcher run. Timing varies, but an unchanged
 * incremental load must read no bytes and an append must read only its tail.
 *
 * @template T
 * @param {string} transcriptRoot
 * @param {string} smokeStep
 * @param {() => Promise<T>} fn
 */
async function probeStep(transcriptRoot, smokeStep, fn) {
  const realCreateReadStream = fs.createReadStream
  let bytes = 0
  let active = 0
  let maxConcurrent = 0
  fs.createReadStream = (/** @type {any[]} */ ...streamArgs) => {
    const stream = Reflect.apply(realCreateReadStream, fs, streamArgs)
    const filePath = String(streamArgs[0])
    if (!filePath.startsWith(transcriptRoot + path.sep) || !filePath.endsWith('.jsonl')) return stream
    active++
    maxConcurrent = Math.max(maxConcurrent, active)
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      active--
    }
    stream.on('data', (chunk) => { bytes += chunk.length })
    stream.once('end', finish)
    stream.once('close', finish)
    stream.once('error', finish)
    return stream
  }
  try {
    const measured = await measure(fn)
    return { ...measured, smokeStep, read: { bytes, maxConcurrent } }
  } finally {
    fs.createReadStream = realCreateReadStream
  }
}

/** @param {Awaited<ReturnType<typeof probeStep>>} step */
function resultStep(step) {
  return {
    smoke_step: step.smokeStep,
    transcript_bytes_read: step.read.bytes,
    max_concurrent_reads: step.read.maxConcurrent,
    wall_ms: round(step.sample.wallMs, 2),
    cpu_ms: round(step.sample.cpuMs, 2),
  }
}

/** @param {Record<string, any>} measured */
function assessTarget(measured) {
  const checks = []
  const incremental = measured.incremental
  if (incremental) {
    checks.push({
      name: 'unchanged_transcript_reads_zero_bytes',
      actual: incremental.warm.transcript_bytes_read,
      limit: 0,
      pass: incremental.warm.transcript_bytes_read === 0,
    })
    checks.push({
      name: 'append_reads_only_the_appended_tail',
      actual: incremental.append.transcript_bytes_read,
      limit: incremental.append.appended_bytes,
      pass: incremental.append.transcript_bytes_read === incremental.append.appended_bytes,
    })
    if (incremental.concurrent) {
      checks.push({
        name: 'large_cold_transcript_reads_are_gated',
        actual: incremental.concurrent.max_concurrent_reads,
        limit: 2,
        pass: incremental.concurrent.max_concurrent_reads <= 2,
      })
    }
  }
  return { pass: checks.every((check) => check.pass), checks }
}

/** @param {Record<string, any>} measured */
function compareImplementations(measured) {
  const uncached = measured.uncached
  const incremental = measured.incremental
  if (!uncached || !incremental) return {}
  return {
    warm_transcript_read_reduction: ratio(uncached.warm.transcript_bytes_read - incremental.warm.transcript_bytes_read, uncached.warm.transcript_bytes_read),
    warm_median_cpu_speedup: ratio(uncached.warm.cpu_ms.median, incremental.warm.cpu_ms.median),
    append_transcript_read_reduction: ratio(uncached.append.transcript_bytes_read - incremental.append.transcript_bytes_read, uncached.append.transcript_bytes_read),
    append_cpu_speedup: ratio(uncached.append.cpu_ms, incremental.append.cpu_ms),
  }
}

/**
 * @param {string} filePath
 * @param {string} sessionId
 * @param {number} rows
 * @param {{ agentId?: string, start?: number }} [opts]
 */
async function writeTranscript(filePath, sessionId, rows, opts) {
  const handle = await fsp.open(filePath, 'w')
  try {
    for (let offset = 0; offset < rows; offset++) {
      const index = (opts?.start ?? 0) + offset
      await handle.write(`${JSON.stringify(transcriptLine(sessionId, index, opts?.agentId))}\n`)
    }
  } finally {
    await handle.close()
  }
}

/** @param {string} sessionId @param {number} index @param {string} [agentId] */
function transcriptLine(sessionId, index, agentId) {
  return {
    sessionId,
    uuid: nativeId(sessionId, index),
    parentUuid: index > 0 ? nativeId(sessionId, index - 1) : null,
    type: 'assistant',
    ...(agentId ? { agentId, isSidechain: true } : {}),
    message: {
      id: `api-${index}`,
      role: 'assistant',
      content: [{ type: 'text', text: `answer-${index}` }],
    },
    timestamp: new Date(1_777_500_000_000 + index).toISOString(),
  }
}

/** @param {string} sessionId @param {number} index */
function exchange(sessionId, index) {
  return {
    exchange_id: `exchange-${sessionId}-${index}`,
    ts_start: '2026-08-27T00:00:00.000Z',
    ts_end: '2026-08-27T00:00:00.100Z',
    duration_ms: 100,
    upstream: 'anthropic',
    provider: null,
    method: 'POST',
    path: '/v1/messages',
    status_code: 200,
    request_bytes: 100,
    response_bytes: 200,
    is_sse: false,
    stream_event_count: 0,
    request_headers: JSON.stringify({ 'anthropic-version': '2023-06-01', 'user-agent': 'claude-cli/1.0' }),
    request_body: JSON.stringify({
      model: 'claude-3-opus',
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
      messages: [],
    }),
    response_headers: JSON.stringify({ 'content-type': 'application/json' }),
    response_body: JSON.stringify({
      id: `api-${index}`,
      role: 'assistant',
      content: [{ type: 'text', text: `answer-${index}` }],
      stop_reason: 'end_turn',
    }),
    error: null,
    metadata: JSON.stringify({ dev_run_id: devRunId, smoke_name: 'claude_projector_transcript_cpu' }),
    stream_events: [],
  }
}

/** @param {string} sessionId @param {number} index */
function nativeId(sessionId, index) {
  return `native-${sessionId}-${index}`
}

/** @param {Record<string, unknown>[]} rows @param {string} sessionId @param {number} index @param {string} step */
function assertNativeIdentity(rows, sessionId, index, step) {
  const expected = nativeId(sessionId, index)
  if (!rows.some((row) => row.message_id === expected)) {
    throw new Error(`${step}: projector did not preserve transcript identity ${expected}`)
  }
}

/** @template T @param {() => Promise<T>} fn */
async function measure(fn) {
  const cpuStart = process.cpuUsage()
  const wallStart = performance.now()
  const value = await fn()
  const wallMs = performance.now() - wallStart
  const cpu = process.cpuUsage(cpuStart)
  return { value, sample: { wallMs, cpuMs: (cpu.user + cpu.system) / 1000 } }
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

/** @param {string} rootDir */
async function listJsonlFiles(rootDir) {
  const found = []
  for (const entry of await fsp.readdir(rootDir, { withFileTypes: true })) {
    const filePath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) found.push(...await listJsonlFiles(filePath))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(filePath)
  }
  return found
}

/** @param {string[]} files */
async function totalBytes(files) {
  let bytes = 0
  for (const file of files) bytes += (await fsp.stat(file)).size
  return bytes
}

/** @param {string[]} argv */
function parseArgs(argv) {
  let profile = 'normal'
  let implementation = 'both'
  let keep = false
  let assertTarget = false
  const overrides = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--profile') profile = requiredValue(argv, ++index, arg)
    else if (arg === '--implementation') implementation = requiredValue(argv, ++index, arg)
    else if (arg === '--transcript-rows') overrides.transcriptRows = positiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--subagent-files') overrides.subagentFiles = nonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--subagent-rows') overrides.subagentRows = positiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--warm-calls') overrides.warmCalls = positiveInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--concurrent-sessions') overrides.concurrentSessions = nonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--concurrent-rows') overrides.concurrentRows = nonNegativeInteger(requiredValue(argv, ++index, arg), arg)
    else if (arg === '--keep') keep = true
    else if (arg === '--assert-target') assertTarget = true
    else if (arg === '--help') { process.stdout.write(usage()); process.exit(0) }
    else throw new Error(`unknown argument: ${arg}\n${usage()}`)
  }
  if (!Object.hasOwn(PROFILES, profile)) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join('|')}`)
  if (!['both', 'uncached', 'incremental'].includes(implementation)) throw new Error('--implementation must be one of both|uncached|incremental')
  return { profile, implementation, keep, assertTarget, overrides }
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

/** @param {string} value @param {string} flag */
function nonNegativeInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} requires a non-negative integer`)
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
    `  --profile NAME              quick|normal|stress (default: normal)\n` +
    `  --implementation NAME       both|uncached|incremental (default: both)\n` +
    `  --transcript-rows N         override main transcript rows\n` +
    `  --subagent-files N          override subagent file count\n` +
    `  --subagent-rows N           override rows per subagent file\n` +
    `  --warm-calls N              override repeated projector calls\n` +
    `  --concurrent-sessions N     override simultaneous cold sessions\n` +
    `  --concurrent-rows N         override rows per cold session\n` +
    `  --assert-target             assert structural read bounds\n` +
    `  --keep                      preserve the generated fixture\n`
}
