// @ts-check

// Fastask stress and resource bounds in the real daemon (LLP 0481 T11,
// LLP 0479#acceptance, LLP 0484#build-memory, LLP 0485, and the thresholds of
// LLP 0486#decision; whole-process CPU as server LLP 0564#decision counts it).
//
// Runs `hyp daemon run` (gateway plus processing child) in a disposable HOME
// with @hypaware/fastask enabled through plugins[], the default remote
// pointing at a loopback snapshot server in its own process (server.mjs), and
// a measurement probe (probe.mjs) preloaded into both daemon processes. While
// foreground load runs against the same daemon (gateway capture through
// @hypaware/ai-gateway to a fake upstream, OTLP log ingest, warm `discover`
// over the fastask control route) and capture smokes run beside it, it drives:
//
//   initial   first load of a measured-size (1x) generation
//   idle      the synced replica with foreground load only (the baseline)
//   refresh   twenty back-to-back 1x refreshes (new generation each time):
//             duty, event-loop delay, foreground latency, swap overlap per
//             build, and no RSS growth from the 10th to the 20th (LLP 0486)
//   large     a 4x generation replacing the 1x one
//   settle    what the processing child keeps once builds stop
//   refused   a manifest past the up-front bound (rows x 100 > MAX_INDEX_BYTES)
//   shutdown  SIGTERM to the daemon while a 4x build runs
//
// and writes one JSON report. Synthetic data only.
//
//   node benchmarks/fastask-client/stress.mjs [--out results.json] [--tmp dir]
//     [--refreshes 20] [--idle-seconds 30] [--settle-seconds 60] [--scale 4]
//     [--smokes a,b] [--keep]

import { spawn, fork } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { defaultConfigPath } from '../../src/core/config/schema.js'
import { readStatusFile } from '../../src/core/daemon/status.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'
import { MAX_INDEX_BYTES } from '../../hypaware-core/plugins-workspace/fastask/src/index_builder.js'
import { DEFAULT_DUTY } from '../../src/core/util/work_budget.js'
import { MEASURED_EDGES, MEASURED_NODES, generate } from './generate.mjs'

/**
 * @import { ChildProcess } from 'node:child_process'
 * @import { AddressInfo } from 'node:net'
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const HERE = fileURLToPath(new URL('.', import.meta.url))
const MB = 1024 * 1024
const TOKEN = 'stress-token'
const TARGET = 'stress'
const SOURCE = 'team-graph-replica'

const opts = parseArgs(process.argv.slice(2))
const scaleLarge = Number(opts.scale ?? 4)
const idleSeconds = Number(opts['idle-seconds'] ?? 30)
const refreshes = Number(opts.refreshes ?? 20)
const settleSeconds = Number(opts['settle-seconds'] ?? 60)
const smokes = (opts.smokes ?? 'gateway_claude_capture,otel_loopback_capture').split(',').filter(Boolean)
const tiny = opts.tiny === 'true'

const work = fs.mkdtempSync(path.join(opts.tmp ?? os.tmpdir(), 'fastask-stress-'))
const home = path.join(work, 'home')
const probeDir = path.join(work, 'probe')
fs.mkdirSync(probeDir, { recursive: true })
fs.mkdirSync(home, { recursive: true })
const env = { ...isolatedClientEnv(process.env, home), FASTASK_STRESS_PROBE_DIR: probeDir, [`HYP_REMOTE_TOKEN_${TARGET.toUpperCase()}`]: TOKEN }
const hypHome = /** @type {string} */ (env.HYP_HOME)

/** @type {Array<() => Promise<void> | void>} */
const cleanups = []
/** @type {Record<string, any>} */
const report = {
  benchmark: 'fastask-client stress in the daemon (LLP 0481 T11)',
  recorded_at: new Date().toISOString(),
  hardware: { platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()[0]?.model, cpus: os.cpus().length, memory_gb: Math.round(os.totalmem() / 1024 ** 3) },
  node: process.version,
  bounds: {
    max_index_bytes: MAX_INDEX_BYTES,
    event_loop_delay_ms: { p95: 20, max: 100 },
    background_cpu_cores: 0.25,
    foreground_latency_regression: 0.10,
    index_bytes_at_1x: 128 * MB,
    peak_increase_1x: 256 * MB,
    peak_increase_large: '4.5 x index + 64 MB, or refused up front',
    peak_increase_refused: 32 * MB,
    refresh_growth_10th_to_20th: 32 * MB,
    otlp_added_median_ms: 1,
    otlp_added_median_ms_accepted_if_documented: 2,
    shutdown_ms: 1000,
  },
  phases: {},
  // The daemon runs the work budget's default, clocked on process CPU (LLP 0485).
  duty: DEFAULT_DUTY,
}

try {
  await main()
} finally {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
  if (opts.keep !== 'true') fs.rmSync(work, { recursive: true, force: true })
}

async function main() {
  const sizes = tiny ? { n: 3000, e: 9000 } : { n: MEASURED_NODES, e: MEASURED_EDGES }
  const gens = {
    a: path.join(work, 'gen-a'),
    b: path.join(work, 'gen-b'),
    large: path.join(work, 'gen-large'),
  }
  log(`generating 1x (two) and ${scaleLarge}x graphs in ${work}`)
  await generate(gens.a, sizes.n, sizes.e, 1)
  await generate(gens.b, sizes.n, sizes.e, 2)
  await generate(gens.large, Math.round(sizes.n * scaleLarge), Math.round(sizes.e * scaleLarge), 3)
  report.graphs = {
    x1: { nodes: sizes.n, edges: sizes.e, gz_bytes: gzBytes(gens.a) },
    large: { scale: scaleLarge, nodes: Math.round(sizes.n * scaleLarge), edges: Math.round(sizes.e * scaleLarge), gz_bytes: gzBytes(gens.large) },
  }
  const questions = JSON.parse(fs.readFileSync(path.join(gens.a, 'questions.json'), 'utf8'))

  const server = await startServer()
  const upstream = await startUpstream()
  const configPath = writeConfig(server.url, upstream.url)
  const daemon = startDaemon(configPath)
  const up = await waitForDaemon()
  const pids = { gateway: /** @type {number} */ (daemon.pid), processing: up.processing }
  log(`daemon up: gateway ${pids.gateway}, processing ${pids.processing}`)
  report.daemon = { gateway_pid: pids.gateway, processing_pid: pids.processing }
  const control = controlClient(up.details.listen_port)
  const ports = daemonPorts()
  const load = foregroundLoad(ports, control, questions)
  const smokeLoop = smokeRunner(smokes)
  cleanups.push(() => load.stop())
  cleanups.push(() => smokeLoop.kill())
  const disk = diskSampler(path.join(hypHome, 'hypaware', 'plugins', '@hypaware', 'fastask'))
  cleanups.push(() => disk.stop())
  let serial = 0
  const nextGeneration = () => `${1760000000000 + ++serial}-${serial}`

  // initial: the child idles with nothing published (503), then the first 1x load.
  await sleep(5_000)
  load.start()
  const seriesSince = Date.now()
  /** @type {Record<string, number>} */
  const phaseStarts = {}
  let t0 = Date.now()
  phaseStarts.initial = t0
  const first = nextGeneration()
  await server.call({ type: 'publish', dir: gens.a, generation: first })
  await control.refresh()
  await waitIndex(control, first, 300_000)
  let t1 = Date.now()
  await probeCatchUp()
  report.phases.initial = { generation: first, wall_ms: t1 - t0, ...measure(pids, t0, t1), index: await indexFacts(first) }
  log(`initial: ${JSON.stringify(report.phases.initial.summary)}`)

  // idle: the baseline, with foreground load and capture smokes.
  smokeLoop.start()
  await sleep(3_000)
  t0 = Date.now()
  phaseStarts.idle = t0
  await sleep(idleSeconds * 1000)
  t1 = Date.now()
  await probeCatchUp()
  report.phases.idle = { ...measure(pids, t0, t1), foreground: load.summary(t0, t1) }
  const idleCores = report.phases.idle.cpu.processing.cores_mean
  log(`idle: ${JSON.stringify(report.phases.idle.summary)}`)

  // refresh: back-to-back 1x generations.
  t0 = Date.now()
  phaseStarts.refresh = t0
  /** @type {any[]} */
  const builds = []
  for (let k = 0; k < refreshes; k++) {
    const generation = nextGeneration()
    await server.call({ type: 'publish', dir: k % 2 === 0 ? gens.b : gens.a, generation })
    const r0 = Date.now()
    await control.refresh()
    await waitIndex(control, generation, 300_000)
    builds.push({ generation, t0: r0, t1: Date.now(), wall_ms: Date.now() - r0 })
  }
  t1 = Date.now()
  await probeCatchUp()
  // Each build against the RSS just before it (the old index is still live: swap overlap).
  for (const b of builds) {
    const m = measure(pids, b.t0, b.t1, idleCores)
    Object.assign(b, { rss_before_mb: m.rss_mb.processing?.before, peak_increase_mb: m.rss_mb.processing?.peak_increase, rss_after_mb: rssAfter(pids.processing, b.t1), ...heapAfter(pids.processing, b.t1), background_cores: m.cpu.processing?.background_cores_mean })
  }
  report.phases.refresh = { builds, ...measure(pids, t0, t1, idleCores), foreground: load.summary(t0, t1, report.phases.idle.foreground) }
  log(`refresh: ${JSON.stringify(report.phases.refresh.summary)}`)

  // large: the larger generation replaces the 1x one.
  const large = nextGeneration()
  const largeManifest = (await server.call({ type: 'publish', dir: gens.large, generation: large })).manifest
  t0 = Date.now()
  phaseStarts.large = t0
  await control.refresh()
  await waitIndex(control, large, 900_000)
  t1 = Date.now()
  await probeCatchUp()
  report.phases.large = { generation: large, wall_ms: t1 - t0, ...measure(pids, t0, t1, idleCores), foreground: load.summary(t0, t1, report.phases.idle.foreground), disk_peak_bytes: disk.peak(t0, t1) }
  smokeLoop.stop()
  await smokeLoop.done()
  report.phases.large.index = await indexFacts(large)
  log(`large: ${JSON.stringify(report.phases.large.summary)}`)

  // settle: what the processing child keeps once the builds stop (V8 returns
  // freed heap lazily), with foreground load only.
  t0 = Date.now()
  phaseStarts.settle = t0
  await sleep(settleSeconds * 1000)
  t1 = Date.now()
  await probeCatchUp()
  const settleLines = probeLines(pids.processing).filter((l) => l.t > t0 && l.t <= t1 + 1000)
  report.phases.settle = {
    ...measure(pids, t0, t1, idleCores),
    rss_mb_every_10s: settleLines.filter((_, i) => i % 10 === 0).map((l) => round1(l.rss / MB)),
    rss_mb_end: round1((settleLines.at(-1)?.rss ?? NaN) / MB),
    foreground: load.summary(t0, t1, report.phases.idle.foreground),
    index_bytes_live_mb: round1(report.phases.large.index.index_bytes / MB),
  }
  log(`settle: ${JSON.stringify(report.phases.settle.rss_mb_every_10s)}`)

  // refused: a manifest past rows x 100 > MAX_INDEX_BYTES is refused before download.
  const refusedGen = nextGeneration()
  const huge = JSON.parse(JSON.stringify(largeManifest))
  huge.generation = refusedGen
  huge.files.nodes = { ...huge.files.nodes, path: `generations/${refusedGen}/nodes.ndjson.gz`, rows: Math.round(MEASURED_NODES * 12) }
  huge.files.edges = { ...huge.files.edges, path: `generations/${refusedGen}/edges.ndjson.gz`, rows: Math.round(MEASURED_EDGES * 12) }
  await sleep(3_000)
  const requestsBefore = (await server.call({ type: 'requests' })).data
  t0 = Date.now()
  await server.call({ type: 'publish_manifest', manifest: huge })
  await control.refresh()
  const refused = await waitFor(async () => {
    const { indexed, replica } = await control.replica()
    return replica && !replica.refresh_in_progress && replica.reason === 'replica_too_large' ? { indexed, replica } : null
  }, 120_000)
  await sleep(2_000)
  t1 = Date.now()
  const requestsAfter = (await server.call({ type: 'requests' })).data
  await probeCatchUp()
  report.phases.refused = {
    manifest_rows: huge.files.nodes.rows + huge.files.edges.rows,
    state: refused.replica.state, reason: refused.replica.reason, generation_kept: refused.replica.generation, still_answering: refused.indexed,
    data_requests: requestsAfter - requestsBefore,
    ...measure(pids, t0, t1, idleCores),
  }
  log(`refused: ${JSON.stringify(report.phases.refused.summary)}`)

  // shutdown: SIGTERM while a large build runs.
  const last = nextGeneration()
  const before = (await server.call({ type: 'requests' })).data
  await server.call({ type: 'publish', dir: gens.large, generation: last })
  await control.refresh()
  await waitFor(async () => ((await server.call({ type: 'requests' })).data - before >= 2 ? true : null), 120_000)
  await sleep(3_000)
  const building = (await control.replica()).replica
  await load.stop()
  const s0 = Date.now()
  daemon.kill('SIGTERM')
  const exits = await Promise.all([waitExit(pids.gateway, 30_000), waitExit(pids.processing, 30_000)])
  report.phases.shutdown = {
    during_build: Boolean(building?.refresh_in_progress) && building?.generation !== last,
    gateway_exit_ms: exits[0] === null ? null : exits[0] - s0,
    processing_exit_ms: exits[1] === null ? null : exits[1] - s0,
  }
  log(`shutdown: ${JSON.stringify(report.phases.shutdown)}`)
  report.smokes = smokeLoop.results()
  report.foreground_series = { since: new Date(seriesSince).toISOString(), bucket_s: 10, phase_starts_s: Object.fromEntries(Object.entries(phaseStarts).map(([k, v]) => [k, Math.round((v - seriesSince) / 1000)])), ...load.series(seriesSince) }
  report.disk_peak_bytes = disk.peak(0, Date.now())
  report.foreground_change = foregroundChange(report.foreground_series)
  report.verdict = verdict(report)
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (opts.out) fs.writeFileSync(opts.out, text)
  process.stdout.write(text)
}

// ---------------------------------------------------------------------------
// Processes

async function startServer() {
  const child = fork(path.join(HERE, 'server.mjs'), [], { env: { ...process.env, FASTASK_STRESS_TOKEN: TOKEN }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  cleanups.push(() => { child.kill() })
  /** @type {Map<number, (msg: any) => void>} */
  const waiting = new Map()
  let nextId = 1
  const url = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.on('message', (/** @type {any} */ msg) => {
      if (msg.type === 'ready') resolve(msg.url)
      else waiting.get(msg.id)?.(msg)
    })
  })
  /** @param {Record<string, unknown>} msg */
  const call = (msg) => new Promise((resolve, reject) => {
    const id = nextId++
    waiting.set(id, (reply) => {
      waiting.delete(id)
      if (reply.ok) resolve(reply)
      else reject(new Error(reply.error))
    })
    child.send({ ...msg, id })
  })
  return { url: /** @type {string} */ (url), call, pid: child.pid }
}

/** A fake Anthropic upstream for the gateway's capture path. */
async function startUpstream() {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const body = JSON.stringify({ id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-stress', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
      res.end(body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)) }))
  const address = /** @type {AddressInfo} */ (server.address())
  return { url: `http://127.0.0.1:${address.port}` }
}

/**
 * @param {string} serverUrl
 * @param {string} upstreamUrl
 */
function writeConfig(serverUrl, upstreamUrl) {
  const configPath = defaultConfigPath(hypHome)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:0', upstreams: [{ name: 'stress-upstream', base_url: upstreamUrl, path_prefix: '/v1/messages', priority: 100 }] } },
      { name: '@hypaware/otel', config: { listen_host: '127.0.0.1', listen_port: 0 } },
      { name: '@hypaware/fastask' },
    ],
    query: { default_remote: TARGET, remotes: { [TARGET]: { url: serverUrl } } },
  }, null, 2))
  return configPath
}

/** @param {string} configPath */
function startDaemon(configPath) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(HERE, 'probe.mjs')).href, path.join(ROOT, 'bin/hypaware.js'), 'daemon', 'run', '--config', configPath], {
    env: { ...env, HYP_CONFIG: configPath },
    stdio: ['ignore', fs.openSync(path.join(work, 'daemon.out'), 'a'), fs.openSync(path.join(work, 'daemon.err'), 'a')],
  })
  cleanups.push(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  return child
}

function readStatus() {
  try {
    return /** @type {any} */ (readStatusFile(path.join(hypHome, 'hypaware')))
  } catch {
    return null // mid-write
  }
}

/** The fastask source's details, wherever the status file lists it. */
function replicaDetails() {
  const s = readStatus()
  return s?.sources?.find((/** @type {any} */ x) => x.name === SOURCE)?.details ?? null
}

async function waitForDaemon() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const s = readStatus()
    const d = replicaDetails()
    if (s?.processes?.processing?.pid && d?.listen_port) return { processing: s.processes.processing.pid, details: d, status: s }
    await sleep(250)
  }
  throw new Error(`daemon did not report ${SOURCE} within 60 s; status: ${JSON.stringify(readStatus())?.slice(0, 2000)}; stderr: ${fs.readFileSync(path.join(work, 'daemon.err'), 'utf8').slice(-2000)}`)
}


// ---------------------------------------------------------------------------
// Driving the daemon

/** @param {number} port the fastask control listener */
function controlClient(port) {
  const tokenPath = path.join(hypHome, 'hypaware', 'plugins', '@hypaware', 'fastask', 'control-token')
  const headers = () => ({ authorization: `Bearer ${fs.readFileSync(tokenPath, 'utf8')}`, 'content-type': 'application/json' })
  const base = `http://127.0.0.1:${port}/_hypaware`
  return {
    async refresh() {
      const res = await fetch(`${base}/fastask/refresh`, { method: 'POST', headers: headers(), body: '{}' })
      await res.arrayBuffer()
      if (res.status !== 202) throw new Error(`refresh answered ${res.status}`)
    },
    /**
     * The live replica view and whether its index answers: discover only
     * answers 200 once the index of the servable generation is in memory.
     * (The status file trails by up to a daemon tick.)
     */
    async replica() {
      const res = await fetch(`${base}/fastask/discover`, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'readiness' }) })
      const body = /** @type {any} */ (await res.json())
      return { indexed: res.status === 200, replica: body.replica }
    },
    /** @param {{ question: string, repo: string | null }} q */
    async discover(q) {
      const res = await fetch(`${base}/fastask/discover`, { method: 'POST', headers: headers(), body: JSON.stringify(q) })
      await res.arrayBuffer()
      return res.status
    },
  }
}

function daemonPorts() {
  const s = readStatus()
  const gw = s.sources.find((/** @type {any} */ x) => x.name === 'ai-gateway').details
  const otlp = s.sources.find((/** @type {any} */ x) => x.name === 'otlp').details
  return { gateway: `http://${gw.host}:${gw.port}`, otlp: `http://${otlp.listen_host}:${otlp.listen_port}` }
}

/**
 * Foreground work against the daemon under test, one request every 100 ms
 * in rotation: a captured gateway request, an OTLP log batch, and a warm
 * discover. Sequential, so a slow answer delays the next instead of piling up.
 *
 * @param {{ gateway: string, otlp: string }} ports
 * @param {ReturnType<typeof controlClient>} control
 * @param {Array<{ question: string, repo: string | null }>} questions
 */
function foregroundLoad(ports, control, questions) {
  /** @type {Array<{ t: number, kind: string, ms: number, ok: boolean }>} */
  const samples = []
  let running = false
  /** @type {Promise<void> | null} */
  let loop = null
  const kinds = ['gateway', 'otlp', 'discover']
  async function one(/** @type {string} */ kind, /** @type {number} */ n) {
    const started = performance.now()
    let ok = false
    try {
      if (kind === 'gateway') {
        const res = await fetch(`${ports.gateway}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'stress', 'x-claude-code-session-id': `stress-${n % 7}` },
          body: JSON.stringify({ model: 'claude-stress', max_tokens: 4, messages: [{ role: 'user', content: `stress ${n}` }] }),
        })
        await res.arrayBuffer()
        ok = res.status === 200
      } else if (kind === 'otlp') {
        const nano = `${BigInt(Date.now()) * 1_000_000n}`
        const res = await fetch(`${ports.otlp}/v1/logs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'fastask-stress' } }] }, scopeLogs: [{ logRecords: [{ timeUnixNano: nano, body: { stringValue: `stress ${n}` } }] }] }] }),
        })
        await res.arrayBuffer()
        ok = res.status < 300
      } else {
        ok = (await control.discover(questions[n % questions.length])) === 200
      }
    } catch {
      ok = false
    }
    samples.push({ t: Date.now(), kind, ms: performance.now() - started, ok })
  }
  return {
    start() {
      if (running) return
      running = true
      loop = (async () => {
        for (let n = 0; running; n++) {
          const next = Date.now() + 100
          await one(kinds[n % kinds.length], n)
          const wait = next - Date.now()
          if (wait > 0) await sleep(wait)
        }
      })()
    },
    async stop() {
      running = false
      await loop
    },
    /**
     * Median latency per kind in 10-second buckets from `since`, to tell a
     * build's effect from drift over the run.
     * @param {number} since
     */
    series(since) {
      /** @type {Record<string, Array<number | null>>} */
      const out = {}
      for (const kind of kinds) {
        /** @type {number[][]} */
        const buckets = []
        for (const x of samples) {
          if (x.kind !== kind || x.t < since) continue
          const i = Math.floor((x.t - since) / 10_000)
          ;(buckets[i] ??= []).push(x.ms)
        }
        out[kind] = Array.from(buckets, (b) => (b ? round2(pct(b.sort((a, c) => a - c), 50)) : null))
      }
      return out
    },
    /**
     * Latency per kind in [t0, t1], and the change against a baseline summary.
     * @param {number} t0
     * @param {number} t1
     * @param {any} [baseline]
     */
    summary(t0, t1, baseline) {
      /** @type {Record<string, any>} */
      const out = {}
      for (const kind of kinds) {
        const window = samples.filter((x) => x.kind === kind && x.t >= t0 && x.t <= t1)
        const ms = window.map((x) => x.ms).sort((a, b) => a - b)
        const entry = { n: window.length, failed: window.filter((x) => !x.ok).length, p50: round2(pct(ms, 50)), p95: round2(pct(ms, 95)), max: round2(ms[ms.length - 1] ?? NaN) }
        if (baseline?.[kind]) {
          Object.assign(entry, { p50_change: round2(entry.p50 / baseline[kind].p50 - 1), p95_change: round2(entry.p95 / baseline[kind].p95 - 1) })
        }
        out[kind] = entry
      }
      return out
    },
  }
}

/**
 * Capture smokes run one after another beside the daemon under test, each in
 * its own disposable install, for as long as the loop is on.
 *
 * @param {string[]} names
 */
function smokeRunner(names) {
  /** @type {Array<{ name: string, started: string, ms: number, exit: number | null }>} */
  const runs = []
  let running = false
  /** @type {Promise<void> | null} */
  let loop = null
  /** @type {ChildProcess | null} */
  let current = null
  const smokeHome = path.join(work, 'smoke-home')
  fs.mkdirSync(smokeHome, { recursive: true })
  return {
    start() {
      if (running || names.length === 0) return
      running = true
      loop = (async () => {
        for (let n = 0; running; n++) {
          const name = names[n % names.length]
          const started = Date.now()
          const child = spawn(process.execPath, [path.join(ROOT, 'hypaware-core/smoke/index.js'), name], {
            cwd: ROOT,
            env: isolatedClientEnv(process.env, smokeHome),
            stdio: ['ignore', fs.openSync(path.join(work, 'smokes.out'), 'a'), fs.openSync(path.join(work, 'smokes.out'), 'a')],
          })
          current = child
          const exit = await new Promise((resolve) => child.on('exit', (code) => resolve(code)))
          current = null
          runs.push({ name, started: new Date(started).toISOString(), ms: Date.now() - started, exit: /** @type {number | null} */ (exit) })
        }
      })()
    },
    stop() { running = false },
    async done() { await loop },
    async kill() { current?.kill('SIGKILL'); running = false },
    results() {
      return { runs: runs.length, failed: runs.filter((r) => r.exit !== 0), by_name: Object.fromEntries(names.map((n) => [n, runs.filter((r) => r.name === n).length])) }
    },
  }
}

/** @param {string} dir the plugin state directory; replicas live under it */
function diskSampler(dir) {
  /** @type {Array<{ t: number, bytes: number }>} */
  const samples = []
  const timer = setInterval(() => {
    let bytes = 0
    try {
      for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
          try { bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size } catch { /* removed meanwhile */ }
        }
      }
    } catch { /* not created yet */ }
    samples.push({ t: Date.now(), bytes })
  }, 500)
  return {
    stop() { clearInterval(timer) },
    /** @param {number} t0 @param {number} t1 */
    peak(t0, t1) { return Math.max(0, ...samples.filter((x) => x.t >= t0 && x.t <= t1).map((x) => x.bytes)) },
  }
}

/**
 * Resolves when `generation`'s index answers discover.
 *
 * @param {ReturnType<typeof controlClient>} control
 * @param {string} generation
 * @param {number} timeoutMs
 */
function waitIndex(control, generation, timeoutMs) {
  return waitFor(async () => {
    const { indexed, replica } = await control.replica()
    return indexed && replica?.generation === generation && !replica.refresh_in_progress ? replica : null
  }, timeoutMs)
}

/**
 * The status file's index facts for `generation`, once a daemon tick has
 * carried them there (read outside the measured windows).
 *
 * @param {string} generation
 */
function indexFacts(generation) {
  return waitFor(() => {
    const d = replicaDetails()
    if (d?.index_error) throw new Error(`index failed: ${d.index_error}`)
    return d && d.index_generation === generation ? { index_bytes: d.index_bytes, index_build_ms: d.index_build_ms, bytes_on_disk: d.bytes_on_disk, rows: d.rows } : null
  }, 180_000)
}

/**
 * @template T
 * @param {() => T | null | Promise<T | null>} check
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`timed out after ${timeoutMs} ms; replica: ${JSON.stringify(replicaDetails())}`)
}

/**
 * The time a process was first seen gone, or null at the timeout.
 *
 * @param {number} pid
 * @param {number} timeoutMs
 */
async function waitExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return Date.now() }
    await sleep(5)
  }
  return null
}

// ---------------------------------------------------------------------------
// Analysis

/** @param {number} pid */
function probeLines(pid) {
  try {
    return fs.readFileSync(path.join(probeDir, `${pid}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/**
 * Per daemon process over [t0, t1]: CPU in cores (whole process, as server
 * LLP 0564 counts it) as a mean and over 10-second windows, with the idle
 * baseline subtracted for the background share; event-loop delay (the
 * largest one-second p95 and the largest single delay); and RSS against the
 * last sample before t0.
 *
 * @param {{ gateway: number, processing: number }} pids
 * @param {number} t0
 * @param {number} t1
 * @param {number} [idleCores] the processing child's idle mean, to subtract
 */
function measure(pids, t0, t1, idleCores) {
  /** @type {Record<string, any>} */
  const out = { window_s: round2((t1 - t0) / 1000), cpu: {}, eld_ms: {}, rss_mb: {} }
  for (const [role, pid] of Object.entries(pids)) {
    const all = probeLines(pid)
    const base = [...all].reverse().find((l) => l.t <= t0) ?? all[0]
    // A sample covers the second before it, so the one after t1 still counts;
    // a window shorter than a second gets at least that one.
    let inside = all.filter((l) => l.t > t0 && l.t <= t1 + 1000)
    if (inside.length === 0) inside = all.filter((l) => l.t > t0).slice(0, 1)
    if (!base || inside.length === 0) continue
    const lastLine = inside[inside.length - 1]
    const cores = (/** @type {any} */ a, /** @type {any} */ b) => (b.cpu_us - a.cpu_us) / 1e6 / ((b.t - a.t) / 1000)
    /** @type {number[]} */
    const windows = []
    for (let i = 0; i + 10 <= inside.length; i += 10) windows.push(cores(i === 0 ? base : inside[i - 1], inside[i + 9]))
    const mean = cores(base, lastLine)
    const background = idleCores !== undefined && role === 'processing'
    out.cpu[role] = {
      cores_mean: round3(mean),
      cores_10s_windows: windows.map(round3),
      ...(background ? { background_cores_mean: round3(mean - idleCores), background_cores_10s_max: round3(Math.max(...windows, mean) - idleCores) } : {}),
    }
    out.eld_ms[role] = { p95_max_1s: round2(Math.max(...inside.map((l) => l.eld.p95))), max: round2(Math.max(...inside.map((l) => l.eld.max))), p50_median: round2(pct(inside.map((l) => l.eld.p50).sort((a, b) => a - b), 50)) }
    const peak = Math.max(...inside.map((l) => l.rss_peak))
    out.rss_mb[role] = { before: round1(base.rss / MB), peak: round1(peak / MB), peak_increase: round1((peak - base.rss) / MB), after: round1(lastLine.rss / MB) }
  }
  out.summary = {
    s: out.window_s,
    cpu: out.cpu.processing?.background_cores_mean ?? out.cpu.processing?.cores_mean,
    cpu10max: out.cpu.processing?.background_cores_10s_max,
    eld_p95: out.eld_ms.processing?.p95_max_1s,
    eld_max: out.eld_ms.processing?.max,
    gw_eld_max: out.eld_ms.gateway?.max,
    rss_up: out.rss_mb.processing?.peak_increase,
  }
  return out
}

/** @param {Record<string, any>} r */
function verdict(r) {
  const p = r.phases
  const b = r.bounds
  /** @type {Array<{ check: string, value: unknown, bound: unknown, pass: boolean }>} */
  const checks = []
  const add = (/** @type {string} */ check, /** @type {unknown} */ value, /** @type {unknown} */ bound, /** @type {boolean} */ pass) => checks.push({ check, value: value ?? null, bound, pass: value !== undefined && value !== null && pass })
  add('1x index bytes', p.initial.index.index_bytes, b.index_bytes_at_1x, p.initial.index.index_bytes <= b.index_bytes_at_1x)
  add('1x initial peak RSS increase (MB)', p.initial.rss_mb.processing?.peak_increase, b.peak_increase_1x / MB, p.initial.rss_mb.processing?.peak_increase <= b.peak_increase_1x / MB)
  const perBuild = Math.max(...p.refresh.builds.map((/** @type {any} */ x) => x.peak_increase_mb ?? Infinity))
  add('1x refresh peak RSS increase per build, incl. swap overlap (MB)', perBuild, b.peak_increase_1x / MB, perBuild <= b.peak_increase_1x / MB)
  const tenth = p.refresh.builds[9]?.rss_after_mb
  const twentieth = p.refresh.builds[19]?.rss_after_mb
  add('no growth: RSS after the 20th refresh minus after the 10th (MB)', tenth !== undefined && twentieth !== undefined ? round1(twentieth - tenth) : undefined, b.refresh_growth_10th_to_20th / MB, twentieth - tenth <= b.refresh_growth_10th_to_20th / MB)
  const largeBound = 4.5 * p.large.index.index_bytes / MB + 64
  add('large peak RSS increase (MB)', p.large.rss_mb.processing?.peak_increase, round1(largeBound), p.large.rss_mb.processing?.peak_increase <= largeBound)
  add('large index within MAX_INDEX_BYTES', p.large.index.index_bytes, b.max_index_bytes, p.large.index.index_bytes <= b.max_index_bytes)
  add('refused: no data downloaded', p.refused.data_requests, 0, p.refused.data_requests === 0)
  add('refused: previous generation kept and answering', p.refused.generation_kept, p.large.generation, p.refused.generation_kept === p.large.generation && p.refused.still_answering === true)
  add('refused peak RSS increase (MB)', p.refused.rss_mb.processing?.peak_increase, b.peak_increase_refused / MB, p.refused.rss_mb.processing?.peak_increase <= b.peak_increase_refused / MB)
  for (const phase of ['refresh', 'large']) {
    for (const role of ['processing', 'gateway']) {
      const e = p[phase].eld_ms[role] ?? {}
      add(`${phase} ${role} event-loop delay p95 (ms)`, e.p95_max_1s, b.event_loop_delay_ms.p95, e.p95_max_1s <= b.event_loop_delay_ms.p95)
      add(`${phase} ${role} event-loop delay max (ms)`, e.max, b.event_loop_delay_ms.max, e.max <= b.event_loop_delay_ms.max)
    }
    add(`${phase} background CPU, worst 10 s window (cores)`, p[phase].cpu.processing?.background_cores_10s_max, b.background_cpu_cores, p[phase].cpu.processing?.background_cores_10s_max <= b.background_cpu_cores)
    for (const kind of ['gateway', 'discover']) {
      const change = r.foreground_change[kind]?.[phase]
      add(`${phase} ${kind} foreground median change (10 s bucket medians vs no-build windows)`, change, b.foreground_latency_regression, change <= b.foreground_latency_regression)
    }
    // OTLP ingest shares the processing child with the build: judged by added milliseconds.
    const added = r.foreground_change.otlp?.[`${phase}_added_ms`]
    add(`${phase} otlp added median latency (ms)`, added, b.otlp_added_median_ms, added <= b.otlp_added_median_ms)
  }
  add('shutdown during a build', r.phases.shutdown.during_build, true, r.phases.shutdown.during_build === true)
  add('shutdown: processing child exits (ms)', r.phases.shutdown.processing_exit_ms, b.shutdown_ms, r.phases.shutdown.processing_exit_ms !== null && r.phases.shutdown.processing_exit_ms <= b.shutdown_ms)
  add('capture smokes beside the daemon all pass', r.smokes.failed.length, 0, r.smokes.runs > 0 && r.smokes.failed.length === 0)
  // LLP 0486#decision: OTLP up to 2 ms is accepted when the evidence records it.
  const otlpOver = checks.filter((c) => c.check.includes('otlp added') && !c.pass)
  const otlpAccepted = otlpOver.length > 0 && otlpOver.every((c) => typeof c.value === 'number' && c.value <= b.otlp_added_median_ms_accepted_if_documented)
  const others = checks.filter((c) => !otlpOver.includes(c))
  return {
    pass: checks.every((c) => c.pass),
    pass_with_documented_otlp: others.every((c) => c.pass) && (otlpOver.length === 0 || otlpAccepted),
    checks,
  }
}

/**
 * Foreground latency change per kind and build phase: the median of the
 * phase's 10-second bucket medians against the median of the no-build
 * buckets (idle and settle). Host episodes of a minute or so, which hit
 * no-build windows too, move one window's median but barely move this.
 *
 * @param {any} series
 */
function foregroundChange(series) {
  const starts = series.phase_starts_s
  const mid = (/** @type {Array<number | null>} */ a) => pct(/** @type {number[]} */ (a.filter((x) => x !== null)).sort((x, y) => x - y), 50)
  const range = (/** @type {string} */ kind, /** @type {number} */ from, /** @type {number} */ to) => series[kind].slice(Math.ceil(from / 10), Math.floor(to / 10))
  /** @type {Record<string, any>} */
  const out = {}
  for (const kind of ['gateway', 'otlp', 'discover']) {
    const base = mid([...range(kind, starts.idle, starts.refresh), ...range(kind, starts.settle, Infinity)])
    const refresh = mid(range(kind, starts.refresh, starts.large))
    const large = mid(range(kind, starts.large, starts.settle))
    out[kind] = {
      no_build_ms: round2(base),
      refresh: round3(refresh / base - 1),
      large: round3(large / base - 1),
      refresh_added_ms: round2(refresh - base),
      large_added_ms: round2(large - base),
    }
  }
  return out
}

/** @param {number[]} sorted @param {number} q */
function pct(sorted, q) {
  if (sorted.length === 0) return NaN
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q / 100))]
}

/** @param {number} n */
function round1(n) { return Math.round(n * 10) / 10 }
/** @param {number} n */
function round2(n) { return Math.round(n * 100) / 100 }
/** @param {number} n */
function round3(n) { return Math.round(n * 1000) / 1000 }

// ---------------------------------------------------------------------------
// Helpers

/**
 * The processing child's RSS in the first probe sample after `t`.
 *
 * @param {number} pid
 * @param {number} t
 */
function rssAfter(pid, t) {
  const line = probeLines(pid).find((l) => l.t > t)
  return line ? round1(line.rss / MB) : undefined
}

/**
 * Heap in use and typed-array memory in the first probe sample after `t`:
 * an index that is never released would show here as steady growth.
 *
 * @param {number} pid
 * @param {number} t
 */
function heapAfter(pid, t) {
  const line = probeLines(pid).find((l) => l.t > t)
  return line ? { heap_after_mb: round1(line.heap / MB), heap_committed_after_mb: round1(line.heap_total / MB), array_buffers_after_mb: round1(line.array_buffers / MB) } : {}
}

/** The probe writes once a second; wait for the sample that covers now. */
function probeCatchUp() {
  return sleep(1_200)
}

/** @param {string} dir */
function gzBytes(dir) {
  return fs.statSync(path.join(dir, 'nodes.ndjson.gz')).size + fs.statSync(path.join(dir, 'edges.ndjson.gz')).size
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {string} message */
function log(message) {
  process.stderr.write(`[stress ${new Date().toISOString().slice(11, 19)}] ${message}\n`)
}

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
