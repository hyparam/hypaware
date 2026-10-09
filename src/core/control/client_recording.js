// @ts-check

import http from 'node:http'
import { performance } from 'node:perf_hooks'
import { isLoopbackHost } from '../util/loopback.js'
import { readObservabilityEnv } from '../observability/env.js'
import { readPidFile, processIsAlive } from '../daemon/pid.js'
import { readStatusFile, resolveLiveControlRouteEndpointsFromStatus, daemonHeartbeatAgeMs, DAEMON_HEARTBEAT_STALE_MS } from '../daemon/status.js'

export const RECORDING_ROUTE = 'recording/ollama'
export const RECORDING_PATH = '/_hypaware/' + RECORDING_ROUTE
export const RECORDING_TIMEOUT_MS = 10_000
export const VERIFY_ROUTE = 'verify/ollama'
export const VERIFY_PATH = '/_hypaware/' + VERIFY_ROUTE

/**
 * Confirm the processor's generation change, rather than merely the saved
 * switch or a live forwarding socket. Missing/malformed live advertisements
 * cannot prove a running collector stopped recording.
 * @ref LLP 0474#recording [implements]: processor-confirmed stop, finite uncertainty and advertised actual host
 * @param {{ env: NodeJS.ProcessEnv, recording: boolean, endpoint?: string }} opts
 * @returns {Promise<{ confirmed: boolean, stopped?: boolean }>}
 */
export async function confirmOllamaRecording(opts) {
  const { stateDir } = readObservabilityEnv(opts.env)
  let endpoint = opts.endpoint
  if (!endpoint) {
    try {
      const pid = readPidFile(stateDir)
      const status = readStatusFile(stateDir)
      if (pid && (!Number.isSafeInteger(pid.pid) || pid.pid < 1)) return { confirmed: false }
      if ((!pid && (!status || status.state === 'stopped')) || (pid && !processIsAlive(pid.pid))) return { confirmed: true, stopped: true }
      const age = daemonHeartbeatAgeMs(status, Date.now())
      if (!pid || status?.pid !== pid.pid || status.runId !== pid.runId || status.startedAt !== pid.startedAt || age === null || age < 0 || age > DAEMON_HEARTBEAT_STALE_MS) return { confirmed: false }
      endpoint = resolveLiveControlRouteEndpointsFromStatus({ stateRoot: stateDir, route: RECORDING_ROUTE }).find(source => source.source === 'ai-gateway')?.endpoint
    } catch { return { confirmed: false } }
  }
  if (!endpoint) return { confirmed: false }
  let target
  try { target = new URL(RECORDING_PATH, endpoint) } catch { return { confirmed: false } }
  if (target.protocol !== 'http:' || target.username || target.password) return { confirmed: false }
  return new Promise(resolve => {
    let done = false
    const finish = confirmed => {
      if (done) return
      done = true
      clearTimeout(timer)
      request.destroy()
      resolve({ confirmed })
    }
    const request = http.request(target, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let body = ''
      let bytes = 0
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 1024) { response.destroy(); finish(false) }
        else body += chunk.toString('utf8')
      })
      response.on('error', () => finish(false))
      response.on('end', () => {
        let parsed
        try { parsed = JSON.parse(body) } catch { /* incomplete/malformed ack */ }
        finish(response.statusCode === 200 && parsed?.recording === opts.recording && typeof parsed.generation === 'string' && /^[a-zA-Z0-9:_-]{1,80}$/.test(parsed.generation))
      })
    })
    const timer = setTimeout(() => finish(false), RECORDING_TIMEOUT_MS)
    request.on('error', () => finish(false))
    request.end(JSON.stringify({ recording: opts.recording }))
  })
}

// @ref LLP 0476#confirmation [implements]: control and final identity proof share the caller's single persistence deadline
/** @param {{ endpoint: string, runId: string, generation?: string, operation?: string, deadline: number }} opts @returns {Promise<{ reason: string, generation?: string }>} */
export async function requestOllamaVerification(opts) {
  const now = () => performance.timeOrigin + performance.now()
  const unavailable = { reason: 'processor_unavailable' }
  let target
  try { target = new URL(VERIFY_PATH, opts.endpoint) } catch { return unavailable }
  if (target.protocol !== 'http:' || target.username || target.password || !isLoopbackHost(target.hostname) || now() >= opts.deadline) return unavailable
  return new Promise(resolve => {
    let done = false
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      request.destroy()
      resolve(value)
    }
    const request = http.request(target, { method: opts.operation ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } }, response => {
      let body = ''
      let bytes = 0
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 1024) finish(unavailable)
        else body += chunk.toString('utf8')
      })
      response.on('error', () => finish(unavailable))
      response.on('end', () => {
        let parsed
        try { parsed = JSON.parse(body) } catch { /* bounded receipt only */ }
        const reason = parsed?.reason
        const known = ['settled', 'ready', 'settlement_busy', 'settlement_failed', 'recording_disabled', 'policy_unreadable', 'stale_generation', 'processor_unavailable']
        const success = reason === 'settled' || reason === 'ready'
        const matches = parsed?.runId === opts.runId && typeof parsed?.generation === 'string' && /^[a-zA-Z0-9:_-]{1,80}$/.test(parsed.generation)
          && (!success || (!opts.generation || parsed.generation === opts.generation)
          && (!opts.operation || parsed?.operation === opts.operation))
        finish(now() < opts.deadline && matches && known.includes(reason) && (!success || response.statusCode === 200) ? { reason, generation: parsed.generation } : unavailable)
      })
    })
    const timer = setTimeout(() => finish({ reason: 'persistence_timeout' }), Math.max(1, opts.deadline - now()))
    request.on('error', () => finish(unavailable))
    request.end(opts.operation ? JSON.stringify({ operation: opts.operation, generation: opts.generation, runId: opts.runId }) : undefined)
  })
}
