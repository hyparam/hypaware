// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { atomicWriteJson } from '../../../src/core/util/fs_atomic.js'
import { canonicalJson, isPlainObject, sha256Hex } from '../../../src/core/util/json_util.js'
import { isLoopbackHost } from '../../../src/core/util/loopback.js'
import { getLogger } from '../../../src/core/observability/index.js'

/**
 * @import { CaptureOptions, CaptureRuntime, CaptureState } from '../../../hypaware-core/bridges/devin/types.js'
 */

const LIMITS = Object.freeze({
  responseBytes: 2 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  pages: 100,
  records: 10000,
  durationMs: 15 * 60 * 1000,
  timeoutMs: 10000,
})
const STATE_BYTES = 1024 * 1024
const logger = getLogger('devin.bridge')

/**
 * Read only one explicitly selected session into the existing OTLP logs receiver.
 * Payloads are capture data. Diagnostics contain only stages, counts and codes.
 *
 * @param {CaptureOptions} options
 * @param {CaptureRuntime} [runtime]
 */
export async function captureSession(options, runtime = {}) {
  const { orgId, sessionId, token, statePath, watch = false } = options
  if (!/^org-[a-zA-Z0-9_-]{1,200}$/.test(orgId)) throw new Error('invalid_org_id')
  if (!/^devin-[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) throw new Error('invalid_session_id')
  if (!/^cog_[^\s]+$/.test(token)) throw new Error('missing_or_invalid_DEVIN_API_KEY')
  const endpoint = new URL(options.endpoint)
  if (!isLoopbackHost(endpoint.hostname) || !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/v1/logs' || endpoint.search || endpoint.hash) {
    throw new Error('endpoint_must_be_local_v1_logs')
  }
  const apiBase = new URL(runtime.apiBase ?? 'https://api.devin.ai')
  if (apiBase.origin !== 'https://api.devin.ai' &&
      !(apiBase.protocol === 'http:' && isLoopbackHost(apiBase.hostname))) {
    throw new Error('invalid_api_origin')
  }
  const limits = { ...LIMITS, ...runtime.limits }
  const now = runtime.now ?? Date.now
  const sleep = runtime.sleep ?? (async (ms) => { await delay(ms) })
  const fetchImpl = runtime.fetch ?? fetch
  const deadline = now() + limits.durationMs
  let bytes = 0
  let pages = 0
  let delivered = 0
  let duplicates = 0
  await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 })
  let lock
  try { lock = await fs.open(`${statePath}.lock`, 'wx', 0o600) } catch {
    throw new Error('state_locked_or_unwritable: after a crash remove the state .lock file before retrying')
  }
  try {
    const state = await loadState(statePath, orgId, sessionId, endpoint.href, limits.records)
    const seen = new Set(state.seen)
    const sessionUrl = new URL(`/v3/organizations/${orgId}/sessions/${sessionId}`, apiBase)

    /** @param {number} ms */
    async function pause(ms) {
      if (now() + ms >= deadline) throw new Error('deadline_exceeded')
      await sleep(ms)
    }

    /** @param {Response} response */
    async function readBody(response) {
      const reader = response.body?.getReader()
      if (!reader) return ''
      let size = 0
      const chunks = []
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          bytes += value.byteLength
          if (size > limits.responseBytes || bytes > limits.totalBytes) throw new Error('byte_limit_exceeded')
          chunks.push(value)
        }
        return Buffer.concat(chunks).toString('utf8')
      } finally { await reader.cancel().catch(() => {}) }
    }

    /** @param {URL} url @param {string} stage @param {string} [body] */
    async function request(url, stage, body) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const remaining = deadline - now()
        if (remaining <= 0) throw new Error('deadline_exceeded')
        let retryMs = 1000 * 2 ** attempt
        try {
          const response = await fetchImpl(url, {
            method: body === undefined ? 'GET' : 'POST',
            headers: body === undefined
              ? { authorization: `Bearer ${token}` }
              : { 'content-type': 'application/json' },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(Math.max(1, Math.min(limits.timeoutMs, remaining))),
          })
          if (response.status === 429 || response.status >= 500) {
            const retry = response.headers.get('retry-after')
            await response.body?.cancel()
            if (retry) {
              const seconds = Number(retry)
              retryMs = Number.isFinite(seconds) ? Math.max(retryMs, seconds * 1000) : Math.max(retryMs, Date.parse(retry) - now())
              if (!Number.isFinite(retryMs) || retryMs > 30000) throw new Error(`${stage}_retry_after_exceeds_budget`)
            }
          } else {
            if (response.status !== 200) {
              await response.body?.cancel()
              throw new Error(`${stage}_http_${response.status}`)
            }
            const raw = await readBody(response)
            let result
            try { result = raw ? JSON.parse(raw) : {} } catch { throw new Error(`${stage}_invalid_json`) }
            if (!isPlainObject(result)) throw new Error(`${stage}_invalid_response`)
            return result
          }
        } catch (error) {
          // Never surface fetch/JSON errors: they can contain URLs or vendor content.
          if (error instanceof Error && /^(deadline_|byte_limit_|(details|messages|otlp)_(http_|invalid_|retry_after_))/.test(error.message)) throw error
        }
        if (attempt === 2) throw new Error(`${stage}_retry_exhausted`)
        logger.warn('devin.bridge.retry', { hyp_operation: stage, status: 'degraded', attempt: attempt + 1 })
        await pause(retryMs)
      }
      throw new Error(`${stage}_retry_exhausted`)
    }

    async function save() {
      state.seen = [...seen]
      await atomicWriteJson(statePath, state, { mode: 0o600, dirMode: 0o700, fsync: true })
    }

    /** @param {Record<string, unknown>[]} records */
    async function post(records) {
      if (!records.length) return
      const body = JSON.stringify({ resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'devin' } }] },
        scopeLogs: [{ scope: { name: 'hypaware.devin.bridge', version: '1' }, logRecords: records }],
      }] })
      if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('otlp_payload_limit_exceeded')
      const response = await request(endpoint, 'otlp', body)
      // A partial success is ambiguous. Do not checkpoint even if some rows landed.
      if (isPlainObject(response.partialSuccess) &&
          (Number(response.partialSuccess.rejectedLogRecords ?? 0) !== 0 || response.partialSuccess.errorMessage)) {
        throw new Error('otlp_partial_success')
      }
      delivered += records.length
    }

    for (;;) {
      const detail = await request(sessionUrl, 'details')
      if (typeof detail.session_id !== 'string' ||
          ![sessionId, sessionId.slice(6)].includes(detail.session_id) || detail.org_id !== orgId ||
          typeof detail.status !== 'string') throw new Error('details_identity_or_status_mismatch')
      const detailHash = sha256Hex(canonicalJson(detail))
      const observed = now()
      if (detailHash !== state.detailHash) {
        await post([record(detail, 'session', orgId, sessionId, observed)])
        state.detailHash = detailHash
        await save()
      }
      // Revisit just the final page on a later poll: a null end_cursor must not
      // reset recovery to the beginning of the transcript. No cursor is invented.
      const cursors = new Set([state.after])
      for (;;) {
        if (++pages > limits.pages) throw new Error('page_limit_exceeded')
        const url = new URL(`${sessionUrl.pathname}/messages`, apiBase)
        url.searchParams.set('first', '100')
        if (state.after) url.searchParams.set('after', state.after)
        const page = await request(url, 'messages')
        if (!Array.isArray(page.items) || page.items.length > 100 || typeof page.has_next_page !== 'boolean' ||
            !(page.end_cursor === null || (typeof page.end_cursor === 'string' && page.end_cursor.length <= 4096))) {
          throw new Error('messages_invalid_page')
        }
        const next = page.end_cursor
        if (page.has_next_page && (!next || cursors.has(next))) throw new Error('messages_cursor_cycle')
        const fresh = new Map()
        for (const item of page.items) {
          if (!isPlainObject(item) || typeof item.event_id !== 'string' || !item.event_id ||
              typeof item.message !== 'string' || typeof item.source !== 'string') throw new Error('messages_invalid_item')
          const key = sha256Hex(item.event_id)
          if (seen.has(key) || fresh.has(key)) {
            duplicates++
            continue
          }
          fresh.set(key, record(item, 'message', orgId, sessionId, now()))
        }
        if (seen.size + fresh.size > limits.records) throw new Error('record_limit_exceeded')
        await post([...fresh.values()])
        for (const key of fresh.keys()) seen.add(key)
        if (page.has_next_page) {
          state.after = /** @type {string} */ (next)
          cursors.add(state.after)
        }
        await save()
        logger.info('devin.bridge.page', { hyp_operation: 'messages', status: 'ok', pages, delivered, duplicates })
        if (!page.has_next_page) break
      }
      const status = detail.status
      const statusDetail = typeof detail.status_detail === 'string' ? detail.status_detail : null
      const stopped = ['exit', 'error', 'suspended'].includes(status) ||
        ['finished', 'waiting_for_user', 'waiting_for_approval'].includes(statusDetail ?? '')
      if (!watch || stopped) {
        logger.info('devin.bridge.done', { hyp_operation: 'capture', status: 'ok', pages, delivered, duplicates, bytes })
        return { status, statusDetail, pages, delivered, duplicates, bytes, distinctMessages: seen.size }
      }
      await pause(30000)
    }
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'capture_failed'
    logger.error('devin.bridge.failed', { hyp_operation: 'capture', status: 'failed', error_kind: code })
    throw error
  } finally {
    await lock.close()
    await fs.rm(`${statePath}.lock`, { force: true })
  }
}

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {Record<string, unknown>}
 */
function otlpValue(value, depth = 0) {
  if (depth > 64) throw new Error('payload_depth_exceeded')
  if (value === null) return {}
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') return { doubleValue: value }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(v => otlpValue(v, depth + 1)) } }
  if (isPlainObject(value)) return { kvlistValue: { values: Object.entries(value).map(([key, v]) => ({ key, value: otlpValue(v, depth + 1) })) } }
  throw new Error('payload_invalid_value')
}

/** @param {unknown} value */
function vendorTime(value) {
  // Expect Unix seconds for this pilot. Confirm the unit with a live sample.
  // Retain the original number in the body rather than guessing another unit.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 253402300799) {
    throw new Error('invalid_vendor_timestamp')
  }
  return String(BigInt(value) * 1000000000n)
}

/** @param {Record<string, unknown>} body @param {string} kind @param {string} org @param {string} session @param {number} observed */
function record(body, kind, org, session, observed) {
  const attrs = { org_id: org, session_id: session, event_kind: kind,
    ...(kind === 'message' ? { event_id: body.event_id, source: body.source } : {}),
  }
  return {
    timeUnixNano: vendorTime(kind === 'message' ? body.created_at : body.updated_at),
    observedTimeUnixNano: String(BigInt(observed) * 1000000n),
    severityText: 'INFO', severityNumber: 9,
    body: otlpValue(body),
    attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: otlpValue(value) })),
  }
}

/** @param {string} file @param {string} orgId @param {string} sessionId @param {string} endpoint @param {number} recordLimit @returns {Promise<CaptureState>} */
async function loadState(file, orgId, sessionId, endpoint, recordLimit) {
  let handle
  try { handle = await fs.open(file, 'r') } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw new Error('state_unreadable')
    return { version: 1, orgId, sessionId, endpoint, after: null, seen: [], detailHash: null }
  }
  try {
    const buffer = Buffer.alloc(STATE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > STATE_BYTES) throw new Error('state_size_exceeded')
    let value
    try { value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) } catch { throw new Error('state_invalid_json') }
    if (!isPlainObject(value) || value.version !== 1 || value.orgId !== orgId || value.sessionId !== sessionId || value.endpoint !== endpoint ||
        !(value.after === null || (typeof value.after === 'string' && value.after.length <= 4096)) ||
        !(value.detailHash === null || (typeof value.detailHash === 'string' && /^[a-f0-9]{64}$/.test(value.detailHash))) ||
        !Array.isArray(value.seen) || value.seen.length > recordLimit ||
        !value.seen.every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) throw new Error('state_invalid_or_mismatched')
    return /** @type {CaptureState} */ (/** @type {unknown} */ (value))
  } finally { await handle.close() }
}
