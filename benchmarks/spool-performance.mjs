// @ts-check

// Synthetic spool benchmark. Run each mode in a fresh process for peak RSS:
// node --expose-gc benchmarks/spool-performance.mjs flush [repo-root]
// node --expose-gc benchmarks/spool-performance.mjs inspect [repo-root]
// The optional root runs the same fixture against a baseline checkout, so a
// candidate and its baseline are measured on one fixture in one Node version.
//
// One 16 MiB envelope of 1,024 rows, median of three fresh Node v24.2.0
// processes on macOS arm64, before and after the fragment-retaining line
// reader (baseline d42c7946). Setup is excluded from CPU; peak RSS is the
// whole-process maximum. Without --expose-gc the fixture-build garbage is
// still resident, so peak_rss_mib is not comparable; the emitted `gc` field
// records which it was. These measure the two spool read paths only, not
// whole-daemon cost:
//   flush    251.35 -> 64.53 ms CPU, 302.09 -> 172.42 MiB peak RSS
//   inspect  217.43 -> 33.98 ms CPU, 290.12 -> 132.41 MiB peak RSS

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
    node: process.version, gc: typeof global.gc === 'function', rows, fixture_bytes: fs.statSync(filePath).size,
    wall_ms: performance.now() - started, cpu_ms: (used.user + used.system) / 1000,
    peak_rss_mib: process.resourceUsage().maxRSS / 1024,
  }))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
