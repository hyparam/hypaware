// @ts-check

// External measurement includes generation owners without injecting a probe
// or recording environment into production helpers. macOS/Linux ps reports
// cumulative CPU and RSS; dead owners retain their last observed CPU total.
import { execFile } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
const exec = promisify(execFile)

/** @param {number} root */
export function sampleProcessTree(root) {
  /** @type {Array<{ t: number, rss: number, cpu: number, children: number }>} */
  const samples = []
  /** @type {Map<number, number>} */
  const cpuByPid = new Map()
  let cumulativeCpu = 0
  let currentPids = [root]
  let stopped = false
  let busy = false
  const sample = async () => {
    if (busy || stopped) return
    busy = true
    try {
      const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,time='], { maxBuffer: 4 * 1024 * 1024 })
      const rows = stdout.trim().split('\n').map(line => {
        const [pid, ppid, rss, time] = line.trim().split(/\s+/)
        const [days, clock] = time.includes('-') ? time.split('-') : ['0', time]
        const parts = clock.split(':').map(Number)
        const seconds = parts.reduce((total, part) => total * 60 + part, Number(days) * 24)
        return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss) * 1024, cpu: seconds }
      })
      const pids = new Set([root])
      let grew = true
      while (grew) {
        grew = false
        for (const row of rows) if (pids.has(row.ppid) && !pids.has(row.pid)) {
          pids.add(row.pid)
          grew = true
        }
      }
      const selected = rows.filter(row => pids.has(row.pid))
      currentPids = selected.map(row => row.pid)
      for (const row of selected) {
        const previous = cpuByPid.get(row.pid) ?? 0
        cumulativeCpu += row.cpu >= previous ? row.cpu - previous : row.cpu
        cpuByPid.set(row.pid, row.cpu)
      }
      samples.push({ t: Date.now(), rss: selected.reduce((n, row) => n + row.rss, 0), cpu: cumulativeCpu, children: Math.max(0, selected.length - 1) })
    } finally { busy = false }
  }
  const timer = setInterval(() => { void sample().catch(() => {}) }, 250)
  void sample()
  return {
    samples,
    async capture() {
      while (busy) await sleep(10)
      await sample()
    },
    pids: () => currentPids,
    stop() {
      stopped = true
      clearInterval(timer)
    },
    /** @param {number} t0 @param {number} t1 */
    measure(t0, t1) {
      const before = samples.findLast(s => s.t <= t0) ?? samples[0]
      const inside = samples.filter(s => s.t > t0 && s.t <= t1)
      const last = inside.at(-1) ?? before
      if (!before || !last) throw new Error('no process-tree samples')
      const peak = Math.max(before.rss, ...inside.map(s => s.rss))
      const cores = (last.cpu - before.cpu) / ((last.t - before.t) / 1000)
      const windows = inside.filter(s => s.t >= t0 + 10_000).map(s => {
        const prior = samples.findLast(p => p.t <= s.t - 10_000)
        return prior ? (s.cpu - prior.cpu) / ((s.t - prior.t) / 1000) : cores
      })
      return { before: before.rss / 1024 ** 2, peak: peak / 1024 ** 2, after: last.rss / 1024 ** 2, peak_increase: (peak - before.rss) / 1024 ** 2,
        cores_mean: cores, cores_10s_max: Math.max(cores, ...windows), max_children: Math.max(0, ...inside.map(s => s.children)) }
    },
  }
}
