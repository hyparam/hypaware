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
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'

import { EDGE_COLUMNS, NODE_COLUMNS, encodeLine } from '../../hypaware-core/plugins-workspace/fastask/src/contract.js'
import { discover } from '../../hypaware-core/plugins-workspace/fastask/src/discovery.js'
import { IndexBuildError, MAX_INDEX_BYTES, buildIndexFromSnapshot } from '../../hypaware-core/plugins-workspace/fastask/src/index_builder.js'

const SELF = fileURLToPath(import.meta.url)
const MEASURED_NODES = 142_766
const MEASURED_EDGES = 462_042
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

/**
 * Deterministic PRNG (mulberry32).
 *
 * @param {number} seed
 */
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const COMMON = ['index.js', 'README.md', 'utils.ts', 'package.json', 'config.js', 'main.go', 'test.js', 'types.d.ts', 'login.js', 'server.js']
const WORDS = ['auth', 'login', 'session', 'parser', 'budget', 'cache', 'query', 'graph', 'sync', 'replica', 'token', 'retry', 'export', 'sink', 'source', 'daemon', 'status', 'evidence', 'index', 'build']
const DIRS = ['src', 'lib', 'test', 'docs', 'scripts', 'src/core', 'src/util', 'src/cli', 'pkg', 'internal']
const EXTS = ['js', 'ts', 'md', 'go', 'py', 'json']

/**
 * Writes a snapshot-shaped generation (gzipped NDJSON in contract column
 * order) plus a set of discovery questions over it. Shape follows the
 * measured graph: about 6% Sessions with full props, 43% Files (bridged
 * `owner/repo:path` keys, a fifth absolute paths), the rest Commits,
 * Programs, Tools, Repos and so on; about two thirds of edges are `touched`
 * with a skewed popularity, the rest the other session edges. A small share
 * of edges point at absent nodes.
 *
 * @param {string} dir
 * @param {number} nodeCount
 * @param {number} edgeCount
 */
async function generate(dir, nodeCount, edgeCount) {
  fs.mkdirSync(dir, { recursive: true })
  const rand = prng(nodeCount)
  const pick = (/** @type {any[]} */ list) => list[Math.floor(rand() * list.length)]
  const sessions = Math.round(nodeCount * 0.042)
  const files = Math.round(nodeCount * 0.427)
  const repos = Math.max(50, Math.round(nodeCount / 476))
  const users = Math.max(10, Math.round(sessions / 60))
  const others = nodeCount - sessions - files - repos
  const t0 = Date.UTC(2025, 9, 1)
  const span = 365 * 86_400_000

  /** @type {string[]} */
  const fileKeys = []
  /** @type {Array<{ q: string, repo: string | null }>} */
  const askable = []

  async function* nodeLines() {
    for (let r = 0; r < repos; r++) {
      yield line({ node_id: `repo${r}`, node_type: 'Repo', natural_key: `org${r % 97}/repo${r}`, label: `org${r % 97}/repo${r}`, props: null, first_seen: t0, source_dataset: 'ai_gateway_messages', source_keys: { git_remote: `https://github.com/org${r % 97}/repo${r}.git` }, projector: 'ai-gateway.t0', projector_version: 3 }, NODE_COLUMNS)
    }
    for (let s = 0; s < sessions; s++) {
      const r = Math.floor(rand() * repos)
      yield line({
        node_id: `s${s}`, node_type: 'Session', natural_key: `session-${s.toString(16).padStart(8, '0')}-4c1e-9a2b-${(s * 7919).toString(16).padStart(12, '0')}`, label: `session ${s}`,
        props: { cwd: `/home/user${s % users}/work/repo${r}`, git_branch: pick(['main', 'dev', `feature/${pick(WORDS)}`]), client_name: pick(['claude-code', 'codex', 'cursor']), user_id: `user-${s % users}` },
        first_seen: t0 + Math.floor(rand() * span), source_dataset: 'ai_gateway_messages', source_keys: { session_id: `s${s}` }, projector: 'ai-gateway.t0', projector_version: 3,
      }, NODE_COLUMNS)
    }
    for (let f = 0; f < files; f++) {
      const r = Math.floor(rand() * repos)
      const name = rand() < 0.15 ? pick(COMMON) : `${pick(WORDS)}_${pick(WORDS)}${f % 13}.${pick(EXTS)}`
      const rel = `${pick(DIRS)}/${rand() < 0.5 ? `${pick(WORDS)}/` : ''}${name}`
      const key = rand() < 0.2 ? `/home/user${f % users}/work/repo${r}/${rel}` : `org${r % 97}/repo${r}:${rel}`
      fileKeys.push(key)
      if (askable.length < 400 && rand() < 0.02) askable.push({ q: `why is ${name} shaped this way in the ${pick(WORDS)} code`, repo: rand() < 0.5 ? `org${r % 97}/repo${r}` : null })
      yield line({ node_id: `f${f}`, node_type: 'File', natural_key: key, label: name, props: {}, first_seen: t0 + Math.floor(rand() * span), source_dataset: 'ai_gateway_messages', source_keys: { file_path: `/home/u/${rel}` }, projector: 'ai-gateway.t0', projector_version: 3 }, NODE_COLUMNS)
    }
    const kinds = ['Commit', 'Program', 'Tool', 'Skill', 'App', 'Model', 'PullRequest']
    for (let o = 0; o < others; o++) {
      const type = o < others * 0.55 ? 'Commit' : o < others * 0.85 ? 'Program' : pick(kinds)
      const key = type === 'Commit' ? (o * 2654435761 >>> 0).toString(16).padStart(40, 'a') : `${type.toLowerCase()}-${o}`
      yield line({ node_id: `o${o}`, node_type: type, natural_key: key, label: type === 'Commit' ? key.slice(0, 12) : key, props: null, first_seen: t0 + Math.floor(rand() * span), source_dataset: 'ai_gateway_messages', source_keys: null, projector: 'ai-gateway.t0', projector_version: 3 }, NODE_COLUMNS)
    }
  }

  async function* edgeLines() {
    const touched = Math.round(edgeCount * 0.66)
    for (let e = 0; e < edgeCount; e++) {
      const s = Math.floor(rand() * sessions)
      const at = t0 + Math.floor(rand() * span)
      // A small share of edges name a session the node file does not carry.
      const src = rand() < 0.002 ? `missing-s${e}` : `s${s}`
      if (e < touched) {
        // Skewed popularity: a few files are touched by many sessions.
        const f = Math.floor(files * rand() ** 3)
        yield line({ edge_id: `e${e}`, edge_type: 'touched', src_id: src, dst_id: `f${f}`, src_type: 'Session', dst_type: 'File', props: null, first_seen: at, source_dataset: 'ai_gateway_messages', source_keys: rand() < 0.1 ? { session_id: `s${s}`, message_id: `msg-${e}` } : { session_id: `s${s}`, file_path: `/home/u/${fileKeys[f]}` }, projector: 'ai-gateway.t0', projector_version: 3 }, EDGE_COLUMNS)
      } else {
        const type = pick(['used', 'in', 'at', 'invoked', 'via', 'used_model', 'ran'])
        const dst = type === 'in' ? `repo${Math.floor(rand() * repos)}` : `o${Math.floor(rand() * others)}`
        yield line({ edge_id: `e${e}`, edge_type: type, src_id: src, dst_id: dst, src_type: 'Session', dst_type: type === 'in' ? 'Repo' : 'Commit', props: null, first_seen: at, source_dataset: 'ai_gateway_messages', source_keys: { session_id: `s${s}` }, projector: 'ai-gateway.t0', projector_version: 3 }, EDGE_COLUMNS)
      }
    }
  }

  await pipeline(() => batched(nodeLines()), createGzip(), fs.createWriteStream(path.join(dir, 'nodes.ndjson.gz')))
  await pipeline(() => batched(edgeLines()), createGzip(), fs.createWriteStream(path.join(dir, 'edges.ndjson.gz')))
  const words = askable.length ? askable : [{ q: 'login', repo: null }]
  const questions = words.map(({ q, repo }) => ({ question: q, repo }))
  fs.writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(questions))
  const manifest = { files: { nodes: { rows: nodeCount }, edges: { rows: edgeCount } } }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  const gzBytes = fs.statSync(path.join(dir, 'nodes.ndjson.gz')).size + fs.statSync(path.join(dir, 'edges.ndjson.gz')).size
  return { gzBytes }
}

/**
 * Joins lines into writes of about 64 KB.
 *
 * @param {AsyncIterable<string>} lines
 */
async function* batched(lines) {
  let buffer = ''
  for await (const text of lines) {
    buffer += text
    if (buffer.length >= 65_536) {
      yield buffer
      buffer = ''
    }
  }
  if (buffer) yield buffer
}

/**
 * @param {Record<string, unknown>} row
 * @param {ReadonlyArray<string>} columns
 */
function line(row, columns) {
  return `${encodeLine(row, columns)}\n`
}

const args = parseArgs(process.argv.slice(2))
if (args.child) await child(args)
else await parent(args)
