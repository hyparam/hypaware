// @ts-check

import { randomBytes } from 'node:crypto'
import { createClientRecordingPolicyReader } from '../../../../src/core/config/client_recording.js'
import { drainRequestBody } from '../../../../src/core/util/reject_body.js'

import { RECORDING_TIMEOUT_MS } from '../../../../src/core/control/client_recording.js'
export { RECORDING_ROUTE, RECORDING_PATH, RECORDING_TIMEOUT_MS } from '../../../../src/core/control/client_recording.js'

/** @import { IncomingMessage, ServerResponse } from 'node:http' */

/** @param {{ upstream?: string, provider?: string | null }} input */
export function isOllamaCapture(input) {
  return input.provider === 'ollama' || input.upstream === 'ollama' || input.upstream === 'ollama-native'
}

/**
 * One current generation and at most the raw capture ceiling of admitted
 * appends. No request ledger survives settlement. Refresh closes admission
 * synchronously before awaiting storage; attach starts another generation.
 * @ref LLP 0474#recording [implements]: old streams cannot revive across detach and reattach; confirmed off drains admitted writes
 * @param {{ env: NodeJS.ProcessEnv, generation?: string }} opts
 */
export function createRecordingGate(opts) {
  const read = createClientRecordingPolicyReader({ env: opts.env, plugin: '@hypaware/ollama' })
  const epoch = randomBytes(12).toString('hex')
  let serial = 0
  let generation = opts.generation ?? `${epoch}:${serial}`
  let enabled = read().recording
  let stopped = false
  let busy = false
  /** @type {Set<Promise<unknown>>} */
  const appends = new Set()
  /** @type {Set<() => void>} */
  const drained = new Set()
  const rotate = () => { generation = `${epoch}:${++serial}` }
  const current = () => {
    const policy = read()
    if (!policy.recording && enabled) { enabled = false; rotate() }
    return { ...policy, reason: policy.recording && (!enabled || stopped) ? 'recording_disabled' : policy.reason, recording: !stopped && enabled && policy.recording, generation }
  }
  return {
    current,
    /** @param {string | undefined} token */
    allows(token) { return current().recording && token === generation },
    /** @param {string | undefined} token @param {() => Promise<unknown>} append */
    append(token, append) {
      if (!this.allows(token) || appends.size >= 32) return undefined
      // Acquire before invoking the storage operation, including sync throws.
      const task = Promise.resolve().then(append)
      appends.add(task)
      void task.then(() => {}, () => {}).finally(() => {
        appends.delete(task)
        if (!appends.size) for (const done of drained) done()
      })
      return task
    },
    /** @param {boolean} recording @param {AbortSignal} signal @param {string} [nextGeneration] */
    async refresh(recording, signal, nextGeneration) {
      if (busy || stopped || signal.aborted) throw new Error('recording_barrier_unconfirmed')
      busy = true
      enabled = false
      rotate()
      if (nextGeneration) generation = nextGeneration
      try {
        if (appends.size) await new Promise((resolve, reject) => {
          const cleanup = () => { drained.delete(done); signal.removeEventListener('abort', abort) }
          const done = () => { cleanup(); resolve(undefined) }
          const abort = () => { cleanup(); reject(new Error('recording_barrier_unconfirmed')) }
          drained.add(done)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
        if (stopped || signal.aborted || read().recording !== recording) throw new Error('recording_policy_changed')
        enabled = recording
        return { recording, generation }
      } finally { busy = false }
    },
    stop() { stopped = true; enabled = false; rotate() },
    snapshot() { const policy = current(); return { recording_generation: policy.generation, recording_enabled: policy.recording, recording_appends: appends.size } },
  }
}

/**
 * Fixed client, scalar body, single operation and one wall-clock deadline.
 * Abort on HTTP disconnect as well as shutdown, so a lost receipt cannot
 * leave an IPC callback or append-drain waiter pinned.
 * @param {{ refresh(recording: boolean, signal: AbortSignal): Promise<unknown> }} opts
 */
export function createRecordingControlHandler(opts) {
  /** @type {AbortController | undefined} */
  let active
  return {
    close() { active?.abort() },
    /** @param {IncomingMessage} req @param {ServerResponse} res */
    handle(req, res) {
      const reply = (code, body) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) } }
      if (req.method !== 'POST' || active) {
        drainRequestBody(req, res)
        reply(active ? 409 : 405, { reason: active ? 'recording_busy' : 'method_not_allowed' })
        return
      }
      const controller = new AbortController()
      active = controller
      const timer = setTimeout(() => controller.abort(), RECORDING_TIMEOUT_MS)
      const abort = () => controller.abort()
      res.once('close', abort)
      let body = ''
      const data = chunk => {
        if (controller.signal.aborted) return
        if (Buffer.byteLength(body) + chunk.length > 256) {
          reply(413, { reason: 'body_too_large' })
          controller.abort()
          cleanup()
        } else body += chunk.toString('utf8')
      }
      const cleanup = () => {
        clearTimeout(timer)
        req.off('data', data)
        req.off('error', abort)
        req.off('end', end)
        body = ''
        res.off('close', abort)
        if (active === controller) active = undefined
      }
      req.on('data', data)
      req.once('error', abort)
      const end = () => {
        if (controller.signal.aborted) { cleanup(); return }
        let parsed
        try { parsed = JSON.parse(body) } catch { /* invalid body */ }
        if (!parsed || typeof parsed.recording !== 'boolean' || Object.keys(parsed).length !== 1) {
          reply(400, { reason: 'invalid_recording_request' })
          cleanup()
          return
        }
        void opts.refresh(parsed.recording, controller.signal).then(
          result => reply(200, result),
          () => reply(503, { reason: 'recording_barrier_unconfirmed' })
        ).finally(cleanup)
      }
      req.once('end', end)
      // A stalled upload/disconnected client must release the operation too.
      controller.signal.addEventListener('abort', () => {
        reply(503, { reason: 'recording_barrier_unconfirmed' })
        if (!req.complete) drainRequestBody(req, res)
        cleanup()
      }, { once: true })
    },
  }
}
