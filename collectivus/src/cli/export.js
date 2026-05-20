import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ConfigError, loadConfigAsync as defaultLoadConfig } from '../config.js'
import { resolveDefaultConfigPath } from './common.js'
import { rowsToParquet } from '../upload/parquet.js'
import { iterExchangesWithStreamEvents, readJsonlRows } from '../upload/reader.js'
import { loadClaudeContextLookup, sessionIdsFromExchanges } from './claude-transcripts.js'
import { messageRowsToParquet } from './messages-parquet.js'
import { walkExchanges } from './messages-walker.js'
import { reconstructAssistantMessage } from './stream-reconstruct.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import { ExportFileResult, ExportHooks, ExportJob, ExportParseResult, ProxyExportResult } from './types.d.ts'
 * @import { Signal } from '../upload/upload.d.ts'
 */

const USAGE = `Usage:
  ctvs export [--config <path|url>] [--out <dir>] [--date <YYYY-MM-DD>] [--gateway-id <id>] [--signal <s>]

Convert recorded JSONL under the configured sink dir into local Parquet files.
Runs once and exits. Does not invoke the daily upload pipeline.

Drains both:
  - <id>/proxy/<date>.jsonl     → <out>/proxy/messages.parquet
  - <id>/<signal>/<date>.jsonl  → <out>/<id>/<signal>/date=<date>/data.parquet

Options:
  --config <path|url> Path or http(s) URL to the collectivus JSON config
                      (default: ~/.hyp/collectivus.json)
  --out <dir>         Output directory (default: <sink.dir>/parquet)
  --date <date>       Only export this UTC date (YYYY-MM-DD; default: all). OTLP only.
  --gateway-id <id>   Only export this gateway_id (default: all). OTLP only.
  --signal <s>        Only export this signal: logs, traces, metrics (default: all). OTLP only.
  --help, -h          Show this help`

const DATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** @type {ReadonlyArray<Signal>} */
const VALID_SIGNALS = ['logs', 'traces', 'metrics']

/**
 * Parse the argument list of `collectivus export`.
 *
 * @param {string[]} argv
 * @returns {ExportParseResult}
 */
export function parseExportArgs(argv) {
  /** @type {ExportParseResult} */
  const r = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { r.help = true; return r }
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) { r.error = '--config requires a path'; return r }
      r.configPath = value
      continue
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg === '--out' ? argv[++i] : arg.slice('--out='.length)
      if (!value) { r.error = '--out requires a directory'; return r }
      r.outDir = value
      continue
    }
    if (arg === '--date' || arg.startsWith('--date=')) {
      const value = arg === '--date' ? argv[++i] : arg.slice('--date='.length)
      if (!value) { r.error = '--date requires YYYY-MM-DD'; return r }
      if (!DATE_PATTERN.test(value)) { r.error = `--date must be YYYY-MM-DD, got ${value}`; return r }
      r.date = value
      continue
    }
    if (arg === '--gateway-id' || arg.startsWith('--gateway-id=')) {
      const value = arg === '--gateway-id' ? argv[++i] : arg.slice('--gateway-id='.length)
      if (!value) { r.error = '--gateway-id requires an id'; return r }
      r.gatewayId = value
      continue
    }
    if (arg === '--signal' || arg.startsWith('--signal=')) {
      const value = arg === '--signal' ? argv[++i] : arg.slice('--signal='.length)
      if (!value) { r.error = '--signal requires logs|traces|metrics'; return r }
      if (!isSignal(value)) {
        r.error = `--signal must be logs, traces, or metrics; got ${value}`
        return r
      }
      r.signal = value
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * Run `collectivus export`. Walks `<sink.dir>/<id>/<signal>/<date>.jsonl`
 * and writes one Parquet file per (gateway_id, signal, date) into `<outDir>`.
 *
 * Output layout matches the upload object key shape so the same partition
 * layout works with engines that infer partitions from path segments:
 *   `<outDir>/<gateway_id>/<signal>/date=<YYYY-MM-DD>/data.parquet`
 *
 * @param {string[]} argv
 * @param {ExportHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runExport(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const loadConfigFn = hooks.loadConfig ?? defaultLoadConfig

  const parsed = parseExportArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  if (!parsed.configPath) {
    const fallback = resolveDefaultConfigPath(hooks.homeDir)
    if (fallback) {
      parsed.configPath = fallback
    } else {
      stderr.write(`error: --config is required\n\n${USAGE}\n`)
      return 2
    }
  }

  /** @type {CollectivusConfig} */
  let config
  try {
    config = await loadConfigFn(parsed.configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`config error: ${err.message}\n`)
      return 1
    }
    throw err
  }

  if (!config.sink) {
    stderr.write('error: config has no sink; nothing to export\n')
    return 1
  }

  const sinkDir = config.sink.dir
  const outDir = parsed.outDir ?? path.join(sinkDir, 'parquet')

  let written = 0
  let totalRows = 0
  let failures = 0

  const proxyJsonlFiles = discoverProxyJsonlFiles(sinkDir)
  if (proxyJsonlFiles.length > 0) {
    try {
      const result = await exportProxy(proxyJsonlFiles, outDir)
      for (const file of result.files) {
        written++
        totalRows += file.rows
        stdout.write(`wrote ${file.outPath} (${file.rows} rows, ${file.bytes} bytes)\n`)
      }
      if (result.skipped.length > 0) {
        for (const kind of result.skipped) {
          stdout.write(`skip proxy/${kind}: 0 rows\n`)
        }
      }
    } catch (err) {
      failures++
      stderr.write(`error: <id>/proxy/*.jsonl: ${formatError(err)}\n`)
    }
  }

  const jobs = discoverExportJobs(sinkDir, {
    date: parsed.date,
    gatewayId: parsed.gatewayId,
    signal: parsed.signal,
  })

  for (const job of jobs) {
    try {
      const result = await exportOne(job, outDir)
      if (result.rows === 0) {
        stdout.write(`skip ${job.gatewayId}/${job.signal}/${job.date}: 0 rows\n`)
        continue
      }
      written++
      totalRows += result.rows
      stdout.write(`wrote ${result.outPath} (${result.rows} rows, ${result.bytes} bytes)\n`)
    } catch (err) {
      failures++
      stderr.write(`error: ${job.gatewayId}/${job.signal}/${job.date}: ${formatError(err)}\n`)
    }
  }

  if (written === 0 && failures === 0) {
    stdout.write(`No JSONL files matched in ${sinkDir}.\n`)
    return 0
  }

  stdout.write(`Done. ${written} file(s), ${totalRows} row(s)${failures ? `, ${failures} failure(s)` : ''}.\n`)
  return failures === 0 ? 0 : 1
}

/**
 * Discover every per-day proxy JSONL file under `<sinkDir>/<id>/proxy/`.
 * Each entry includes the gateway_id parsed from the directory path so the
 * caller can group files per-gateway before walking — conversations live
 * within one gateway, never across.
 *
 * Sorted by gateway_id then date so multi-id, multi-day fixtures land in
 * stable, chronological order per gateway.
 *
 * @param {string} sinkDir
 * @returns {Array<{ gatewayId: string, date: string, jsonlPath: string }>}
 */
export function discoverProxyJsonlFiles(sinkDir) {
  /** @type {Array<{ gatewayId: string, date: string, jsonlPath: string }>} */
  const out = []
  for (const id of safeReadDir(sinkDir)) {
    const proxyDir = path.join(sinkDir, id, 'proxy')
    let stat
    try {
      stat = fs.statSync(proxyDir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    for (const name of safeReadDir(proxyDir)) {
      const match = DATE_FILE_PATTERN.exec(name)
      if (!match) continue
      out.push({ gatewayId: id, date: match[1], jsonlPath: path.join(proxyDir, name) })
    }
  }
  out.sort(compareProxyFiles)
  return out
}

/**
 * Drain every per-day proxy JSONL into a single `proxy_messages` Parquet
 * file. Walks each gateway's days chronologically so the conversation walker
 * can dedupe message ids across the day boundary, then concatenates all
 * gateways into the same output. Returns the input as "skipped: messages"
 * when the walker produces zero rows so callers print the same "0 rows"
 * signal the old exchange/stream_event split surfaced.
 *
 * @param {Array<{ gatewayId: string, date: string, jsonlPath: string }>} jsonlFiles
 * @param {string} outDir
 * @param {{ contextLookup?: (sessionId: string | undefined, timestamp: unknown) => ({ cwd?: string, git_branch?: string, claude_version?: string } | undefined) }} [opts]
 * @returns {Promise<ProxyExportResult>}
 */
export async function exportProxy(jsonlFiles, outDir, opts = {}) {
  /** @type {Map<string, Array<{ date: string, jsonlPath: string }>>} */
  const byGateway = new Map()
  for (const file of jsonlFiles) {
    let list = byGateway.get(file.gatewayId)
    if (!list) {
      list = []
      byGateway.set(file.gatewayId, list)
    }
    list.push({ date: file.date, jsonlPath: file.jsonlPath })
  }

  /** @type {Record<string, unknown>[]} */
  const allRows = []
  for (const [gatewayId, files] of byGateway) {
    files.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    /** @type {Map<string, Record<string, unknown>[]>} */
    const streamEventsByExchange = new Map()
    /** @type {Record<string, unknown>[]} */
    const exchanges = []
    for (const file of files) {
      const bundles = await iterExchangesWithStreamEvents(file.jsonlPath)
      for (const bundle of bundles) {
        const exchangeId = bundle.exchange.exchange_id
        if (typeof exchangeId === 'string') {
          streamEventsByExchange.set(exchangeId, bundle.streamEvents)
        }
        exchanges.push(bundle.exchange)
      }
    }
    const contextLookup = opts.contextLookup ?? await loadClaudeContextLookup({
      sessionIds: sessionIdsFromExchanges(exchanges),
    })
    const walked = walkExchanges(exchanges, {
      gateway_id: gatewayId,
      contextLookup,
      reconstructAssistantMessage: (exchange) => {
        const exchangeId = exchange.exchange_id
        if (typeof exchangeId !== 'string') return null
        const events = streamEventsByExchange.get(exchangeId)
        if (!events) return null
        return reconstructAssistantMessage(/** @type {import('./stream-reconstruct.js').StreamEventRow[]} */ (events))
      },
    })
    for await (const row of walked) {
      allRows.push(row)
    }
  }

  const proxyDir = path.join(outDir, 'proxy')
  /** @type {ExportFileResult[]} */
  const files = []
  /** @type {Array<'messages'>} */
  const skipped = []
  if (allRows.length === 0) {
    skipped.push('messages')
    return { files, skipped }
  }
  const buf = await messageRowsToParquet(allRows, ['gateway_id'])
  if (!buf) {
    skipped.push('messages')
    return { files, skipped }
  }
  fs.mkdirSync(proxyDir, { recursive: true })
  const outPath = path.join(proxyDir, 'messages.parquet')
  fs.writeFileSync(outPath, buf)
  files.push({ rows: allRows.length, bytes: buf.byteLength, outPath })
  return { files, skipped }
}

/**
 * @param {{ gatewayId: string, date: string }} a
 * @param {{ gatewayId: string, date: string }} b
 * @returns {number}
 */
function compareProxyFiles(a, b) {
  if (a.gatewayId !== b.gatewayId) return a.gatewayId < b.gatewayId ? -1 : 1
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  return 0
}

/**
 * Discover OTLP export jobs by walking
 * `<sinkDir>/<gateway_id>/<signal>/<date>.jsonl`. The proxy and `raw/`
 * subtrees live alongside the per-signal directories under the same
 * `<gateway_id>/` root and are skipped here. The proxy export path
 * (`exportProxy`) handles `proxy/`, and `raw/` envelopes are kept for
 * debugging only.
 *
 * @param {string} sinkDir
 * @param {{ date?: string, gatewayId?: string, signal?: Signal }} filter
 * @returns {ExportJob[]}
 */
export function discoverExportJobs(sinkDir, filter) {
  /** @type {ExportJob[]} */
  const jobs = []
  const ids = filter.gatewayId ? [filter.gatewayId] : safeReadDir(sinkDir)
  for (const gatewayId of ids) {
    const idDir = path.join(sinkDir, gatewayId)
    let stat
    try {
      stat = fs.statSync(idDir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    for (const signal of safeReadDir(idDir)) {
      // Reserved sibling subtrees that aren't per-signal data:
      //   proxy/  drained by exportProxy
      //   raw/    debug-only OTLP envelopes
      if (signal === 'proxy' || signal === 'raw') continue
      if (!isSignal(signal)) continue
      if (filter.signal && signal !== filter.signal) continue
      const signalDir = path.join(idDir, signal)
      for (const entry of safeReadDir(signalDir)) {
        const match = DATE_FILE_PATTERN.exec(entry)
        if (!match) continue
        const date = match[1]
        if (filter.date && date !== filter.date) continue
        jobs.push({ gatewayId, signal, date, jsonlPath: path.join(signalDir, entry) })
      }
    }
  }
  jobs.sort(compareJobs)
  return jobs
}

/**
 * @param {ExportJob} job
 * @param {string} outDir
 * @returns {Promise<{ rows: number, bytes: number, outPath: string }>}
 */
async function exportOne(job, outDir) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for await (const row of readJsonlRows(job.jsonlPath)) {
    rows.push(row)
  }
  const partitionDir = path.join(outDir, job.gatewayId, job.signal, `date=${job.date}`)
  const outPath = path.join(partitionDir, 'data.parquet')
  if (rows.length === 0) {
    return { rows: 0, bytes: 0, outPath }
  }
  const buf = await rowsToParquet(job.signal, rows)
  fs.mkdirSync(partitionDir, { recursive: true })
  fs.writeFileSync(outPath, buf)
  return { rows: rows.length, bytes: buf.byteLength, outPath }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * @param {ExportJob} a
 * @param {ExportJob} b
 * @returns {number}
 */
function compareJobs(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.gatewayId !== b.gatewayId) return a.gatewayId < b.gatewayId ? -1 : 1
  return VALID_SIGNALS.indexOf(a.signal) - VALID_SIGNALS.indexOf(b.signal)
}

/**
 * @param {string} value
 * @returns {value is Signal}
 */
function isSignal(value) {
  return value === 'logs' || value === 'traces' || value === 'metrics'
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
