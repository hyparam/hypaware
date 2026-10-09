// @ts-check

// Peak memory of one team graph replica sync (LLP 0481 T5): download,
// streamed verification and activation of a generation, measured in a
// process that does nothing else. The snapshot server runs in a child
// process, so its own buffers never count toward the client's RSS.
//
//   node --expose-gc benchmarks/fastask-replica-sync-memory.mjs [rows...]
//
// A warm-up sync of the pinned fixture runs first and is not reported.
// Each argument is a generated generation's total row count (nodes plus
// edges, split 1:3 like the measured graph); 0 means the pinned fixture.
// Prints one JSON line per size.

import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

import { EDGE_COLUMNS, NODE_COLUMNS, encodeLine, measureFile } from '../hypaware-core/plugins-workspace/graph-cache/src/contract.js'
import { createReplicaSync } from '../hypaware-core/plugins-workspace/graph-cache/src/replica_sync.js'

const SELF = fileURLToPath(import.meta.url)
const FIXTURES = path.resolve(path.dirname(SELF), '..', 'test', 'fixtures', 'contracts', 'graph-snapshot', 'v1')

if (process.argv[2] === '--serve') {
  await serve(Number(process.argv[3]), process.argv[4])
} else {
  const sizes = process.argv.slice(2).map(Number)
  // Warm-up: the first fetch, tracer and module loads are one-time process
  // costs, not the sync's; measure from after them.
  await measure(0)
  for (const rows of sizes.length > 0 ? sizes : [0, 600_000, 1_800_000]) {
    console.log(JSON.stringify(await measure(rows)))
  }
}

/**
 * @param {number} rows
 */
async function measure(rows) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fastask-replica-bench-'))
  const child = fork(SELF, ['--serve', String(rows), work], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const ready = /** @type {{ port: number, bytes: number, generateMs: number }} */ (await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('exit', (code) => reject(new Error(`server exited ${code}`)))
  }))
  try {
    globalThis.gc?.()
    const baseline = process.memoryUsage().rss
    let peak = baseline
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 5)
    const sync = createReplicaSync({
      stateDir: path.join(work, 'state'),
      resolveTarget: async () => ({ target: 'bench', url: `http://127.0.0.1:${ready.port}`, org: 'acme', token: async () => ({ ok: true, token: 'tok' }) }),
      budget: { duty: 1 },
    })
    const started = performance.now()
    const { status } = await sync.syncOnce()
    const syncMs = performance.now() - started
    clearInterval(sampler)
    peak = Math.max(peak, process.memoryUsage().rss)
    await sync.close()
    return {
      rows: status.rows ? status.rows.nodes + status.rows.edges : 0,
      state: status.state,
      compressed_bytes: ready.bytes,
      sync_ms: Math.round(syncMs),
      rss_baseline_mb: mb(baseline),
      rss_peak_mb: mb(peak),
      rss_growth_mb: mb(peak - baseline),
      max_rss_mb: mb(process.resourceUsage().maxRSS * 1024),
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
    }
  } finally {
    child.kill()
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Child: generate (streaming, to disk) or copy the pinned generation, then
 * serve the snapshot routes from disk.
 *
 * @param {number} rows
 * @param {string} work
 */
async function serve(rows, work) {
  const started = performance.now()
  const generation = rows === 0 ? JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8')).generation : `bench-${rows}`
  const files = { nodes: path.join(work, 'nodes.ndjson.gz'), edges: path.join(work, 'edges.ndjson.gz') }
  /** @type {any} */
  let manifest
  if (rows === 0) {
    manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'))
    for (const name of /** @type {const} */ (['nodes', 'edges'])) fs.copyFileSync(path.join(FIXTURES, `${name}.ndjson.gz`), files[name])
  } else {
    const nodeCount = Math.round(rows / 4)
    const edgeCount = rows - nodeCount
    const id = (/** @type {string} */ kind, /** @type {number} */ i) => createHash('sha256').update(`${kind}\0${i}`).digest('hex').slice(0, 24)
    await pipeline(Readable.from((function* () {
      for (let i = 0; i < nodeCount; i++) {
        yield encodeLine({
          node_id: id('node', i), node_type: i % 3 ? 'File' : 'Session', natural_key: `/work/repo-${i % 50}/src/file-${i}.js`, label: `file-${i}.js`,
          props: { language: 'JavaScript', size: i % 9000 }, first_seen: 1760000000000 + i * 1000, source_dataset: 'ai_gateway_messages',
          source_keys: { session_id: `s-${i % 5000}`, message_id: `m-${i}` }, projector: 'ai-gateway.t0', projector_version: 2,
        }, NODE_COLUMNS) + '\n'
      }
    })()), createGzip(), fs.createWriteStream(files.nodes))
    await pipeline(Readable.from((function* () {
      for (let i = 0; i < edgeCount; i++) {
        const src = id('node', i % nodeCount)
        const dst = id('node', (i * 7 + 1) % nodeCount)
        yield encodeLine({
          edge_id: id('edge', i), edge_type: i % 2 ? 'EDITED' : 'READ', src_id: src, dst_id: dst, src_type: 'Session', dst_type: 'File',
          props: i % 4 ? null : { tool: 'Edit' }, first_seen: 1760000000000 + i * 1000, source_dataset: 'ai_gateway_messages',
          source_keys: { session_id: `s-${i % 5000}`, message_id: `m-${i}` }, projector: 'ai-gateway.t0', projector_version: 2,
        }, EDGE_COLUMNS) + '\n'
      }
    })()), createGzip(), fs.createWriteStream(files.edges))
    manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'))
    manifest.generation = generation
    for (const name of /** @type {const} */ (['nodes', 'edges'])) {
      const { facts } = await measureFile(fs.createReadStream(files[name]))
      manifest.files[name] = { path: `generations/${generation}/${name}.ndjson.gz`, ...facts }
    }
  }
  const body = JSON.stringify(manifest)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/v1/graph/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json', 'hyp-snapshot-lease': '259200', etag: `"${generation}"` })
      res.end(body)
      return
    }
    const match = url.pathname.match(/\/(nodes|edges)\.ndjson\.gz$/)
    if (!match) { res.writeHead(404); res.end(); return }
    const file = files[/** @type {'nodes' | 'edges'} */ (match[1])]
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(fs.statSync(file).size) })
    fs.createReadStream(file).pipe(res)
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    process.send?.({
      port: typeof address === 'object' && address ? address.port : 0,
      bytes: manifest.files.nodes.bytes + manifest.files.edges.bytes,
      generateMs: Math.round(performance.now() - started),
    })
  })
}

/** @param {number} bytes */
function mb(bytes) {
  return Math.round(bytes / 1024 / 1024 * 10) / 10
}
