// @ts-check

import { createOutbox } from './outbox.js'
import { effectivePolicy } from './policy.js'
import { validateBatch } from './contract.js'

/** @param {string|null} value @param {number} now */
export function retryAfterMs(value, now) {
  if (!value) return 0
  const seconds = Number(value)
  return Math.min(
    86400_000,
    Math.max(
      0,
      Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now || 0
    )
  )
}

/**
 * One batch per pass. Abort is synchronous and never waits for delivery on CLI
 * exit. Persistent backoff applies across new CLI processes and daemon restarts.
 * @param {string} root @param {{fetchFn?:typeof fetch,now?:()=>number,random?:()=>number}} [options]
 */
export function createDelivery(
  root,
  { fetchFn = fetch, now = Date.now, random = Math.random } = {}
) {
  const outbox = createOutbox(root, { now })
  /** @type {AbortController|null} */
  let controller = null
  let closed = false
  let running = false
  async function drain() {
    if (closed || running) return
    running = true
    const release = outbox.claim()
    if (!release) {
      running = false
      return
    }
    controller = new AbortController()
    const signal = controller.signal
    const timeout = setTimeout(() => controller?.abort(), 2000)
    timeout.unref()
    try {
      const effective = effectivePolicy(root)
      if (effective.mode !== 'organization') {
        outbox.prune(effective.binding)
        return
      }
      const binding = effective.binding
      const prior = outbox.readDelivery()
      const previous = prior?.binding === binding ? prior : {}
      if (previous.next_at > now()) return
      const entry = outbox.next(binding)
      if (!entry) return
      // Disk is a trust boundary too: corruption or an old writer must not
      // turn the exact-byte replay path into an arbitrary payload exporter.
      if (validateBatch(JSON.parse(entry.wire), now()) !== null) {
        outbox.remove(entry)
        outbox.noteDrop()
        return
      }
      const target = effective.policy.url + '/v1/telemetry'
      const attempt = Math.min(16, (previous.attempt ?? 0) + 1)
      /** @param {string} state @param {number} [delay] */
      function pause(state, delay = 3600_000) {
        outbox.saveDelivery({
          binding,
          state,
          attempt,
          next_at: now() + delay,
          last_success_at: previous.last_success_at ?? null
        })
      }
      let token = effective.identity.jwt
      let refreshed = false
      /** @param {RequestInit} [init] */
      async function request(init = {}) {
        const send = () =>
          fetchFn(target, {
            ...init,
            headers: { ...init.headers, authorization: `Bearer ${token}` },
            signal,
            redirect: 'error'
          })
        let response = await send()
        if (response.status !== 401 || refreshed) return response
        refreshed = true
        await response.body?.cancel()
        if (effectivePolicy(root).binding !== binding)
          throw new Error('policy changed')
        const refresh = await fetchFn(
          effective.policy.url + '/v1/identity/refresh',
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            signal,
            redirect: 'error'
          }
        )
        const renewed = refresh.ok ? await smallResponse(refresh) : null
        if (typeof renewed?.jwt !== 'string')
          return new Response(null, { status: 401 })
        const before = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
        )
        const after = JSON.parse(
          Buffer.from(renewed.jwt.split('.')[1], 'base64url').toString('utf8')
        )
        if (
          after.sub !== before.sub ||
          after.org !== before.org ||
          effectivePolicy(root).binding !== binding
        )
          return new Response(null, { status: 401 })
        // Use the existing gateway refresh route but keep its result in this
        // pass. A concurrent re-enrollment must never be overwritten by a
        // telemetry refresh completing with the previous organization's token.
        token = renewed.jwt
        response = await send()
        return response
      }
      const capability = await request()
      if (capability.status === 401) {
        pause('authentication_required')
        return
      }
      if (capability.status === 403) {
        pause('authentication_required')
        return
      }
      if (capability.status === 404) {
        pause('receiver_unavailable')
        return
      }
      if (!capability.ok) {
        pause(
          'retry',
          Math.max(
            retryAfterMs(capability.headers.get('retry-after'), now()),
            Math.min(3600_000, 1000 * 2 ** attempt) * (0.5 + random() / 2)
          )
        )
        return
      }
      const capabilities = await smallResponse(capability)
      if (
        !Array.isArray(capabilities?.schema_versions) ||
        !capabilities.schema_versions.includes(1) ||
        !(capabilities.max_records >= 100) ||
        !(capabilities.max_batch_bytes >= 32768) ||
        !(capabilities.max_queue_age_seconds >= 604800) ||
        !(capabilities.dedup_seconds >= 691200)
      ) {
        pause('incompatible_receiver')
        return
      }
      // Re-read policy and credentials after the network boundary. A disable,
      // re-enrollment or consent generation change invalidates this send.
      const current = effectivePolicy(root)
      if (closed || current.binding !== binding) return
      const response = await request({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: entry.wire
      })
      if (response.status === 202) {
        const receipt = await smallResponse(response)
        if (receipt?.status === 202 && typeof receipt.duplicate === 'boolean') {
          outbox.remove(entry)
          outbox.saveDelivery({
            binding,
            state: 'accepted',
            attempt: 0,
            next_at: 0,
            last_success_at: now()
          })
          return
        }
      }
      if ([400, 409, 413, 415, 422].includes(response.status)) {
        outbox.remove(entry)
        outbox.noteDrop()
        pause('permanent_rejection', 0)
        return
      }
      if (response.status === 401) {
        pause('authentication_required')
        return
      }
      if (response.status === 403) {
        pause('authentication_required')
        return
      }
      if (response.status === 404) {
        pause('receiver_unavailable')
        return
      }
      pause(
        'retry',
        Math.max(
          retryAfterMs(response.headers.get('retry-after'), now()),
          Math.min(3600_000, 1000 * 2 ** attempt) * (0.5 + random() / 2)
        )
      )
    } catch {
      try {
        const effective = effectivePolicy(root)
        const previous = outbox.readDelivery()
        const attempt = Math.min(
          16,
          (previous?.binding === effective.binding
            ? (previous.attempt ?? 0)
            : 0) + 1
        )
        outbox.saveDelivery({
          binding: effective.binding,
          state: closed ? 'interrupted' : 'retry',
          attempt,
          next_at:
            now() +
            Math.min(3600_000, 1000 * 2 ** attempt) * (0.5 + random() / 2),
          last_success_at: previous?.last_success_at ?? null
        })
      } catch {}
    } finally {
      // fetch resolves on headers. Error responses may still own a streaming
      // body and socket, so ending the pass must abort them before disarming
      // the deadline or making the controller unreachable to close().
      controller?.abort()
      clearTimeout(timeout)
      controller = null
      running = false
      release()
    }
  }
  return {
    drain,
    close() {
      closed = true
      controller?.abort()
    }
  }
}

/** @param {Response} response @returns {Promise<any>} */
async function smallResponse(response) {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 4096) return null
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
  }
}
