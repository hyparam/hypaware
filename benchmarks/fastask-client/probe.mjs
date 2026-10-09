// @ts-check

// Measurement probe for the fastask stress run (LLP 0481 T11), preloaded with
// `node --import` into the daemon's gateway and, through the inherited exec
// arguments, its processing child. Once a second each process appends one
// line to `<FASTASK_STRESS_PROBE_DIR>/<pid>.jsonl`: cumulative CPU (user plus
// system, so garbage collection and thread-pool work count, as server
// LLP 0564 measures it), RSS now and the highest RSS sampled in the second,
// the process's lifetime peak RSS, heap used and committed, external and
// array-buffer memory, and the event-loop
// delay histogram of that second. Without the variable it does nothing.

import fs from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const dir = process.env.FASTASK_STRESS_PROBE_DIR
if (dir) {
  const file = path.join(dir, `${process.pid}.jsonl`)
  // A forked child has an IPC channel; the gateway, started from a shell, does not.
  const role = typeof process.send === 'function' ? 'processing' : 'gateway'
  const delay = monitorEventLoopDelay({ resolution: 1 })
  delay.enable()
  let peak = 0
  setInterval(() => {
    const rss = process.memoryUsage.rss()
    if (rss > peak) peak = rss
  }, 50).unref()
  setInterval(() => {
    const cpu = process.cpuUsage()
    const mem = process.memoryUsage()
    if (mem.rss > peak) peak = mem.rss
    const line = {
      t: Date.now(),
      pid: process.pid,
      role,
      cpu_us: cpu.user + cpu.system,
      rss: mem.rss,
      rss_peak: peak,
      max_rss: process.resourceUsage().maxRSS * 1024,
      heap: mem.heapUsed,
      heap_total: mem.heapTotal,
      external: mem.external,
      array_buffers: mem.arrayBuffers,
      eld: {
        p50: delay.percentile(50) / 1e6,
        p95: delay.percentile(95) / 1e6,
        p99: delay.percentile(99) / 1e6,
        max: delay.max / 1e6,
        n: delay.count,
      },
    }
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`)
    delay.reset()
    peak = 0
  }, 1000).unref()
}
