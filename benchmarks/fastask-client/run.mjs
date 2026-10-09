// @ts-check

// Fastask index and discovery benchmark (LLP 0481 T6, LLP 0480#index and
// #discovery). Generates a synthetic team graph snapshot at the measured size
// (142,766 nodes, 462,042 edges with full Session props, LLP 0480#index) and
// at larger multiples, then builds the warm index from the gzipped NDJSON in
// a fresh child process per run and records build time, estimated and
// measured resident bytes, peak RSS, event-loop delay during the build and
// warm discovery p50/p95.
//
//   node benchmarks/fastask-client/run.mjs [--scales 1,4] [--queries 400] [--out results.json] [--tmp dir]
//
// Synthetic data only: no organization data, paths or credentials.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { discover } from '../../hypaware-core/plugins-workspace/graph-cache/src/discovery.js'
import { IndexBuildError, MAX_INDEX_BYTES, buildIndexFromSnapshot } from '../../hypaware-core/plugins-workspace/graph-cache/src/index_builder.js'
import { MEASURED_EDGES, MEASURED_NODES, generate } from './generate.mjs'

const SELF = fileURLToPath(import.meta.url)
const TARGET_BYTES = 128 * 1024 * 1024
const MB = 1024 * 1024

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = 'true'
    else out[a.slice(2)] = argv[++i]
  }
  return out
}

/** @param {Record<string, string>} opts */
async function parent(opts) {
  const scales = (opts.scales ?? '1,4').split(',').map(Number)
  const queries = Number(opts.queries ?? 400)
  const dir = fs.mkdtempSync(path.join(opts.tmp ?? os.tmpdir(), 'fastask-bench-'))
  const runs = []
  try {
    for (const scale of scales) {
      const nodes = Math.round(MEASURED_NODES * scale)
      const edges = Math.round(MEASURED_EDGES * scale)
      const at = path.join(dir, `x${scale}`)
      const started = performance.now()
      const generated = await generate(at, nodes, edges)
      process.stderr.write(`generated x${scale}: ${nodes} nodes, ${edges} edges, ${(generated.gzBytes / MB).toFixed(1)} MB gz in ${Math.round(performance.now() - started)} ms\n`)
      for (const duty of scale === 1 ? [1, 0.25] : [1]) {
        const result = spawnSync(process.execPath, ['--expose-gc', SELF, '--child', 'true', '--dir', at, '--duty', String(duty), '--queries', String(queries)], { encoding: 'utf8', maxBuffer: 16 * MB })
        if (result.status !== 0) throw new Error(`child x${scale} duty ${duty} failed: ${result.stderr}`)
        const run = { scale, nodes, edges, gz_bytes: generated.gzBytes, duty, ...JSON.parse(result.stdout) }
        process.stderr.write(`${JSON.stringify(run)}\n`)
        runs.push(run)
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const report = {
    benchmark: 'fastask-client index and discovery (LLP 0481 T6)',
    recorded_at: new Date().toISOString(),
    hardware: { platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()[0]?.model, cpus: os.cpus().length, memory_gb: Math.round(os.totalmem() / 1024 **3) },
    node: process.version,
    bounds: { target_bytes_at_measured_size: TARGET_BYTES, max_index_bytes: MAX_INDEX_BYTES, discovery_p95_target_ms: 100 },
    runs,
  }
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (opts.out) fs.writeFileSync(opts.out, text)
  process.stdout.write(text)
}

/** @param {Record<string, string>} opts */
async function child(opts) {
  const dir = opts.dir
  const duty = Number(opts.duty)
  const queries = Number(opts.queries)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const questions = JSON.parse(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8'))
  globalThis.gc?.()
  const before = process.memoryUsage()
  const loop = monitorEventLoopDelay({ resolution: 1 })
  loop.enable()
  const started = performance.now()
  /** @type {any} */
  let index
  /** @type {any} */
  const out = {}
  try {
    index = await buildIndexFromSnapshot({
      manifest,
      nodes: fs.createReadStream(path.join(dir, 'nodes.ndjson.gz')),
      edges: fs.createReadStream(path.join(dir, 'edges.ndjson.gz')),
      duty,
    })
  } catch (err) {
    if (!(err instanceof IndexBuildError)) throw err
    out.refused = err.code
    out.message = err.message
  }
  out.build_ms = Math.round(performance.now() - started)
  loop.disable()
  out.build_loop_delay_ms = { p95: round(loop.percentile(95) / 1e6), max: round(loop.max / 1e6) }
  globalThis.gc?.()
  const after = process.memoryUsage()
  out.peak_rss_mb = round(process.resourceUsage().maxRSS * 1024 / MB)
  out.baseline_rss_mb = round(before.rss / MB)
  if (index) {
    out.estimated_mb = round(index.bytes / MB)
    // Heap objects plus typed-array backing stores, after a full collection.
    out.resident_mb = round(((after.heapUsed - before.heapUsed) + (after.arrayBuffers - before.arrayBuffers)) / MB)
    out.heap_mb = round((after.heapUsed - before.heapUsed) / MB)
    out.array_buffers_mb = round((after.arrayBuffers - before.arrayBuffers) / MB)
    out.placeholders = index.placeholderCount
    out.unresolved_edges = index.unresolvedEdges
    for (let i = 0; i < 20; i++) discover(index, questions[i % questions.length])
    /** @type {number[]} */
    const times = []
    let truncated = 0
    let empty = 0
    for (let i = 0; i < queries; i++) {
      const q = questions[i % questions.length]
      const t = performance.now()
      const r = discover(index, q)
      times.push(performance.now() - t)
      if (r.coverage.truncated) truncated++
      if (r.leads.length === 0) empty++
    }
    times.sort((a, b) => a - b)
    out.discovery_ms = { p50: round2(times[Math.floor(times.length * 0.5)]), p95: round2(times[Math.floor(times.length * 0.95)]), max: round2(times[times.length - 1]) }
    out.discovery_queries = queries
    out.discovery_truncated = truncated
    out.discovery_without_leads = empty
  }
  process.stdout.write(JSON.stringify(out))
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 10) / 10
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100
}

const args = parseArgs(process.argv.slice(2))
if (args.child) await child(args)
else await parent(args)
