import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-product-bench-'))
const env = { HYP_HOME: root }
global.gc?.()
const before = process.memoryUsage()
const { createProductClient } = await import(
  '../src/core/product_telemetry/client.js'
)
const { createOutbox } = await import('../src/core/product_telemetry/outbox.js')
const { productRoot, writePolicy } = await import(
  '../src/core/product_telemetry/policy.js'
)
const { productBatch, productEvent, createProductResource } = await import(
  '../src/core/product_telemetry/collection.js'
)
const queueRoot = productRoot(env)
const policy = writePolicy(queueRoot, 'local')
const queue = createOutbox(queueRoot)
const resource = createProductResource()
const samples = []
const invocations = []
try {
  for (let i = 0; i < 400; i++) {
    if (i % 100 === 0) queue.prune(null)
    const batch = productBatch(resource, [
      productEvent('cli.invocation', {
        command: 'status',
        invocation_kind: 'execution',
        outcome: 'success',
        exit_class: 'zero',
        duration_ms: 10
      })
    ])
    const start = performance.now()
    if (!queue.append(batch, policy.binding))
      throw new Error('append unexpectedly dropped')
    samples.push(performance.now() - start)
  }
  queue.prune(null)
  for (let i = 0; i < 100; i++) {
    const start = performance.now()
    const client = createProductClient({ env })
    client.emit([
      productEvent('cli.invocation', {
        command: 'status',
        invocation_kind: 'execution',
        outcome: 'success',
        exit_class: 'zero',
        duration_ms: 10
      })
    ])
    client.close()
    invocations.push(performance.now() - start)
  }
  const pending = queue.status()
  queue.prune(null)
  const daemon = createProductClient({ env, role: 'daemon' })
  global.gc?.()
  const retained = process.memoryUsage()
  const cpu = process.cpuUsage()
  const start = performance.now()
  await new Promise((resolve) => setTimeout(resolve, 65000))
  const elapsed = performance.now() - start
  const used = process.cpuUsage(cpu)
  daemon.close()
  samples.sort((a, b) => a - b)
  invocations.sort((a, b) => a - b)
  console.log(
    JSON.stringify(
      {
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        append_count: samples.length,
        append_p95_ms: samples[Math.floor(samples.length * 0.95)],
        enabled_client_lifecycle_p95_ms: invocations[95],
        baseline_rss_bytes: before.rss,
        retained_rss_delta_bytes: retained.rss - before.rss,
        retained_heap_delta_bytes: retained.heapUsed - before.heapUsed,
        idle_observation_ms: elapsed,
        idle_process_cpu_percent:
          ((used.user + used.system) / (elapsed * 1000)) * 100,
        observed_queue_bytes: pending.queue_bytes,
        observed_queue_batches: pending.queue_batches,
        limits:
          'microbenchmark only; 65s local-only pipeline, no installed daemon or full five-minute network flush'
      },
      null,
      2
    )
  )
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
