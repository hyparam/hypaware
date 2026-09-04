// Synthetic spool benchmark. Run each mode in a fresh process for peak RSS:
// node --expose-gc benchmarks/spool-performance.mjs flush [repo-root]
// node --expose-gc benchmarks/spool-performance.mjs inspect [repo-root]
// The optional root runs the same fixture against a baseline checkout.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const mode = process.argv[2] ?? 'flush'
assert.ok(['flush', 'inspect'].includes(mode))
const repo = process.argv[3] ?? fileURLToPath(new URL('..', import.meta.url))
const { streamFlushFile } = await import(pathToFileURL(path.join(repo, 'src/core/cache/streaming-reader.js')))
const { createCacheSpool, SPOOL_DIR } = await import(pathToFileURL(path.join(repo, 'src/core/cache/spool.js')))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-spool-performance-'))
try {
  const tablePath = path.join(root, 'table')
  const dir = path.join(tablePath, SPOOL_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, 'active.jsonl')
  const fd = fs.openSync(filePath, 'w')
  const rowCount = 1024
  try {
    fs.writeSync(fd, '{"version":1,"columns":[{"name":"message","type":"STRING"}],"rows":[')
    for (let i = 0; i < rowCount; i++) {
      fs.writeSync(fd, (i ? ',' : '') + JSON.stringify({ message: `${i}:${'x'.repeat(16384)}` }))
    }
    fs.writeSync(fd, ']}\n')
  } finally {
    fs.closeSync(fd)
  }
  const spool = createCacheSpool({ cacheRoot: root, appendChunk: async () => ({ bytesWritten: 0 }) })
  global.gc?.()
  const started = performance.now()
  const cpu = process.cpuUsage()
  let rows = 0
  if (mode === 'flush') {
    for await (const batch of streamFlushFile({ filePath, batchId: 'benchmark' })) rows += batch.chunk.rows.length
  } else {
    for await (const row of spool.readSpooledRows(tablePath)) {
      assert.equal(typeof row.message, 'string')
      rows++
    }
  }
  const used = process.cpuUsage(cpu)
  assert.equal(rows, rowCount)
  console.log(JSON.stringify({
    benchmark: 'client_spool', smoke_name: 'spool_performance', smoke_step: mode,
    dev_run_id: process.env.DEV_RUN_ID ?? `spool-${process.pid}`,
    node: process.version, rows, fixture_bytes: fs.statSync(filePath).size,
    wall_ms: performance.now() - started, cpu_ms: (used.user + used.system) / 1000,
    peak_rss_mib: process.resourceUsage().maxRSS / 1024,
  }))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
