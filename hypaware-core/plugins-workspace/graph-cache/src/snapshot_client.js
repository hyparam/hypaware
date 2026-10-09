// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { attachWithRefresh } from '../../../../src/core/remote/credentials.js'
import { discardBody, parseRetryAfter, readBodyCapped } from '../../../../src/core/util/backoff.js'
import { PROTOCOL_MAJOR } from './contract.js'

/**
 * @import { ReadableStream } from 'node:stream/web'
 * @import { DownloadOutcome, ReplicaTarget, SnapshotAnswer } from '../../../../hypaware-core/plugins-workspace/graph-cache/src/types.js'
 */

/** Manifests are a few kilobytes; anything near this is not a manifest. */
const MANIFEST_BODY_CAP = 1024 * 1024
/** Error bodies are `{ error, message, ... }`; only the code is read. */
const ERROR_BODY_CAP = 64 * 1024

const SNAPSHOT_PATH = '/v1/graph/snapshot'
const MCP_PATH = '/v1/mcp'

/**
 * The snapshot route base (`<base>/v1/graph/snapshot`) of a registered target
 * URL. A sibling of the core's MCP and reports derivations: a URL whose path
 * ends in `/v1/mcp` is a server base wearing its MCP suffix, so the suffix is
 * stripped first; any path prefix is kept. An unparseable URL is returned
 * unchanged so fetch fails on it the way it would anyway.
 *
 * @param {string} url
 * @returns {string}
 * @ref LLP 0480#sync [implements]: the endpoint derives from the registered base URL like the MCP and reports endpoints (LLP 0084)
 */
export function deriveSnapshotEndpoint(url) {
  /** @type {URL} */
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  let trimmed = parsed.pathname.replace(/\/+$/, '')
  if (trimmed.endsWith(MCP_PATH)) trimmed = trimmed.slice(0, -MCP_PATH.length)
  parsed.pathname = `${trimmed}${SNAPSHOT_PATH}`
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

/**
 * One authorized GET with the shared 401 -> refresh -> retry-once policy.
 * Returns the final response, or why no request could be made.
 *
 * @param {{ target: ReplicaTarget, url: string, headers?: Record<string, string>, fetchImpl: typeof fetch, signal: AbortSignal }} args
 * @returns {Promise<{ ok: true, response: Response } | { ok: false, kind: 'credential' | 'network', error: string }>}
 */
async function authorizedGet({ target, url, headers = {}, fetchImpl, signal }) {
  /** @type {Awaited<ReturnType<ReplicaTarget['token']>>} */
  let resolved
  try {
    resolved = await target.token(false)
  } catch (err) {
    return { ok: false, kind: 'credential', error: messageOf(err) }
  }
  if (!resolved.ok) return { ok: false, kind: 'credential', error: resolved.error }

  /** @param {string} token @returns {Promise<{ authFailed: boolean, value: { ok: true, response: Response } | { ok: false, kind: 'network', error: string } }>} */
  const op = async (token) => {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...headers, authorization: `Bearer ${token}` },
        redirect: 'error',
        signal,
      })
      if (response.status === 401) {
        // The retry reads a fresh response; this one's body is not needed.
        await discardBody(response)
        return { authFailed: true, value: { ok: true, response } }
      }
      return { authFailed: false, value: { ok: true, response } }
    } catch (err) {
      return { authFailed: false, value: { ok: false, kind: 'network', error: messageOf(err) } }
    }
  }

  try {
    const out = await attachWithRefresh({ resolved, refresh: () => target.token(true), op })
    if (!out.ok) return { ok: false, kind: 'credential', error: out.error }
    return out.value
  } catch (err) {
    // A refresh that throws (invalid_grant) is a credential problem, not an outage.
    return { ok: false, kind: 'credential', error: messageOf(err) }
  }
}

/**
 * The manifest check: `GET <endpoint>?protocol=1`, conditional on the active
 * generation. Never throws for a server or network answer; an abort of
 * `signal` propagates.
 *
 * @param {{ target: ReplicaTarget, endpoint: string, generation: string | null, fetchImpl: typeof fetch, signal: AbortSignal }} args
 * @returns {Promise<SnapshotAnswer>}
 */
export async function checkSnapshot({ target, endpoint, generation, fetchImpl, signal }) {
  /** @type {Record<string, string>} */
  const headers = {}
  if (generation !== null) headers['if-none-match'] = `"${generation}"`
  const got = await authorizedGet({ target, url: `${endpoint}?protocol=${PROTOCOL_MAJOR}`, headers, fetchImpl, signal })
  signal.throwIfAborted()
  if (!got.ok) return { kind: got.kind, error: got.error }
  const { response } = got
  const leaseSeconds = parseSeconds(response.headers.get('hyp-snapshot-lease'))

  if (response.status === 304) {
    await discardBody(response)
    return { kind: 'not_modified', leaseSeconds }
  }
  if (response.status === 200) {
    const body = await readBodyCapped(response, MANIFEST_BODY_CAP, signal)
    if (!body.ok) return { kind: 'network', error: `manifest larger than ${MANIFEST_BODY_CAP} bytes` }
    try {
      return { kind: 'manifest', manifest: JSON.parse(body.body), leaseSeconds }
    } catch {
      return { kind: 'network', error: 'manifest is not JSON' }
    }
  }
  return refusal(response, signal)
}

/**
 * Streams one data file to `dest`, hashing the compressed bytes on the way
 * and refusing past `expectedBytes`. Memory is one chunk; backpressure from
 * the file holds the socket. Never throws for a server, network or disk
 * failure; an abort of `signal` propagates.
 *
 * @param {{ target: ReplicaTarget, url: string, dest: string, expectedBytes: number, fetchImpl: typeof fetch, signal: AbortSignal, createWriteStream?: typeof fs.createWriteStream }} args
 * @returns {Promise<DownloadOutcome>}
 */
export async function downloadFile({ target, url, dest, expectedBytes, fetchImpl, signal, createWriteStream = fs.createWriteStream }) {
  const got = await authorizedGet({ target, url, headers: { accept: 'application/gzip' }, fetchImpl, signal })
  signal.throwIfAborted()
  if (!got.ok) return { ok: false, code: got.kind, status: null }
  const { response } = got
  if (response.status !== 200) {
    const refused = await refusal(response, signal)
    if (refused.kind !== 'refused') return { ok: false, code: 'network', status: null }
    return { ok: false, code: refused.code ?? `http_${refused.status}`, status: refused.status, retryAfterSeconds: refused.retryAfterSeconds }
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > expectedBytes) {
    await discardBody(response)
    return { ok: false, code: 'oversize', status: 200 }
  }
  if (!response.body) return { ok: false, code: 'truncated', status: 200 }

  const hash = createHash('sha256')
  let bytes = 0
  let oversize = false
  /** @param {AsyncIterable<Uint8Array>} chunks */
  async function* measure(chunks) {
    for await (const chunk of chunks) {
      bytes += chunk.byteLength
      if (bytes > expectedBytes) {
        oversize = true
        throw new Error('download exceeds the manifest size')
      }
      hash.update(chunk)
      yield chunk
    }
  }
  try {
    await pipeline(
      Readable.fromWeb(/** @type {ReadableStream<Uint8Array>} */ (response.body)),
      measure,
      createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
      { signal },
    )
  } catch (err) {
    signal.throwIfAborted()
    if (oversize) return { ok: false, code: 'oversize', status: 200 }
    const code = /** @type {NodeJS.ErrnoException} */ (err).code
    if (code === 'ENOSPC' || code === 'EDQUOT') return { ok: false, code: 'disk_full', status: 200 }
    if (code === 'EACCES' || code === 'EROFS' || code === 'EEXIST') return { ok: false, code: 'write_failed', status: 200 }
    return { ok: false, code: 'truncated', status: 200 }
  }
  if (bytes !== expectedBytes) return { ok: false, code: 'truncated', status: 200 }
  return { ok: true, bytes, sha256: hash.digest('hex') }
}

/**
 * A non-success answer: status, the body's stable `error` code (bodies
 * without one, like an older server's, give null) and `retry-after`.
 *
 * @param {Response} response
 * @param {AbortSignal} signal
 * @returns {Promise<SnapshotAnswer>}
 */
async function refusal(response, signal) {
  const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'))
  /** @type {string | null} */
  let code = null
  const body = await readBodyCapped(response, ERROR_BODY_CAP, signal).catch(() => null)
  if (body?.ok) {
    try {
      const parsed = JSON.parse(body.body)
      if (parsed && typeof parsed.error === 'string') code = parsed.error
    } catch { /* not JSON: status alone decides */ }
  }
  return { kind: 'refused', status: response.status, code, retryAfterSeconds }
}

/**
 * @param {string | null} value
 * @returns {number | null}
 */
function parseSeconds(value) {
  if (value === null || !/^\d+$/.test(value.trim())) return null
  const seconds = Number(value.trim())
  return Number.isSafeInteger(seconds) ? seconds : null
}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}
