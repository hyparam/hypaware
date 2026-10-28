// @ts-check

import { createOutbox } from './outbox.js'
import { effectivePolicy, safeDestination } from './policy.js'
import { SCHEMA_VERSIONS, validateBatch } from './contract.js'

// @ref LLP 0562#cadence [implements]: one CLI upload an hour unless a batch is full
export const CLI_SEND_INTERVAL_MS = 3600_000

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
 * One upload per pass. Abort is synchronous and never waits for delivery on CLI
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
      const entry = outbox.next(
        binding,
        previous.cli_sent_at > now() - CLI_SEND_INTERVAL_MS
      )
      if (!entry) return
      // Disk is a trust boundary too: corruption or an old writer must not
      // turn the exact-byte replay path into an arbitrary payload exporter.
      const batch = JSON.parse(entry.wire)
      if (validateBatch(batch, now()) !== null) {
        outbox.remove(entry)
        outbox.noteDrop()
        return
      }
      // Deliver to the destination the guard accepted, not the string it
      // accepted it from: a url that spells itself differently from its parse
      // (a hand-edited trailing backslash) would aim the POST at a route the
      // guard never approved. Organization mode means the guard returned one.
      const destination = /** @type {string} */ (safeDestination(effective.policy.url))
      const target = destination + '/v1/telemetry'
      const attempt = Math.min(16, (previous.attempt ?? 0) + 1)
      // The versions the receiver last advertised. Emission reads this to
      // decide whether it may build v2 records for this binding.
      let versions = receiverVersions(previous)
      /** @param {string} state @param {number} [delay] */
      function pause(state, delay = 3600_000) {
        outbox.saveDelivery({
          binding,
          state,
          attempt,
          next_at: now() + delay,
          last_success_at: previous.last_success_at ?? null,
          cli_sent_at: previous.cli_sent_at ?? null,
          schema_versions: versions
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
          destination + '/v1/identity/refresh',
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
      versions = receiverVersions(capabilities)
      // @ref LLP 0561#rollout [implements]: a batch never reaches a receiver that does not list its version
      if (!versions.includes(batch.schema_version)) {
        // Queued while the receiver listed v2, which it no longer does. It
        // would be refused as a schema error and discarded, so it goes now.
        outbox.remove(entry)
        outbox.noteDrop()
        pause('permanent_rejection', 0)
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
            last_success_at: now(),
            cli_sent_at:
              entry.role === 'cli' ? now() : (previous.cli_sent_at ?? null),
            schema_versions: versions
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
        const same = previous?.binding === effective.binding
        const attempt = Math.min(16, (same ? (previous.attempt ?? 0) : 0) + 1)
        outbox.saveDelivery({
          binding: effective.binding,
          state: closed ? 'interrupted' : 'retry',
          attempt,
          next_at:
            now() +
            Math.min(3600_000, 1000 * 2 ** attempt) * (0.5 + random() / 2),
          last_success_at: previous?.last_success_at ?? null,
          cli_sent_at: (same && previous.cli_sent_at) || null,
          schema_versions: same ? receiverVersions(previous) : [1]
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

/**
 * The known versions in a capability answer or saved delivery state; v1 when
 * nothing usable was recorded.
 * @param {any} value @returns {number[]}
 */
export function receiverVersions(value) {
  const listed = Array.isArray(value?.schema_versions) ? value.schema_versions : []
  const known = SCHEMA_VERSIONS.filter((v) => listed.includes(v))
  return known.length ? known : [1]
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
