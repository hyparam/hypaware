// @ts-check

import http from 'node:http'
import { withSpan } from '../../../../src/core/observability/index.js'
import { refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { SESSION_IGNORE_ROUTE, createControlHandler, isControlPath } from '../../../../src/core/control/session_ignore.js'
import { isMisdirectedHost, listenAndResolve, requestUrlOf } from '../../../../src/core/otlp/server.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { drainRequestBody } from '../../../../src/core/util/reject_body.js'
import { createProjectedExchangeWriter } from '../../ai-gateway/src/exchange_writer.js'
import { piListenPort } from './config.js'
import { piSessionHeader, projectPiEntries } from './projector.js'

/** @import { PluginActivationContext, StartedSource } from '../../../../hypaware-plugin-kernel-types.js' */

/**
 * Version refusals inside one unbroken {@link SKEW_WINDOW_MS} chain that read
 * as a skewed extension rather than a stray probe: an extension too old to
 * speak version 2 has every batch it will ever send refused the same way.
 * @ref LLP 0416#ordering [implements]: a permanent live-lane refusal is reported, not only counted
 */
const SKEW_REFUSALS = 3

/**
 * How long a version refusal counts toward a skew report, and how long the
 * report outlives the last one. An accepted batch cannot clear it: one shared
 * extension file serves every Pi process, so the skew is a pre-upgrade process
 * interleaving with a current one, and an accepted batch proves a sender
 * speaks version 2 rather than that the one that does not has stopped. Silence
 * is the only evidence of repair this listener gets.
 * @ref LLP 0349#the-window: the self-clearing horizon `hyp status` already calls recent
 */
const SKEW_WINDOW_MS = 24 * 3_600_000

const SKEW_ERROR = 'pi_unsupported_batch - the attached Pi extension keeps sending an unsupported batch version; live capture is refused, native session recovery still applies'

/** @param {{ localOnlyListPath?: string, ignoredSessions?: Set<string>, now?: () => number }} deps */
export function createStartPiSource(deps) {
  /** @param {PluginActivationContext} ctx @returns {Promise<StartedSource>} */
  return async function startPiSource(ctx) {
    const ignored = deps.ignoredSessions ?? new Set()
    const now = deps.now ?? Date.now
    const state = { batches: 0, rows: 0, skipped: 0, drops: 0, rejected: 0, refusals: 0, refusedAt: 0, lastError: /** @type {string | undefined} */ (undefined) }
    let busy = false
    /** @type {Promise<void> | undefined} */
    let active
    const control = createControlHandler({ ignoredSessions: ignored, log: ctx.log, logEvent: 'pi.control.ignore_session', logFields: { component: 'plugin.pi' } })
    const server = http.createServer((req, res) => {
      if (isMisdirectedHost(req, { name: '@hypaware/pi', log: ctx.log })) return reject(req, res, 421, 'misdirected_request')
      const url = requestUrlOf(req)
      if (!url) return reject(req, res, 400, 'invalid_request')
      if (isControlPath(url.pathname)) { control(req, res, url); return }
      if (req.method === 'GET' && url.pathname === '/') { send(res, 200, { name: 'hypaware/pi', version: 2 }); return }
      if (req.method !== 'POST' || url.pathname !== '/entries') return reject(req, res, 404, 'not_found')
      if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        state.rejected++
        return reject(req, res, 415, 'content_type')
      }
      // @ref LLP 0416#bounds: admission and writer state are bounded per batch
      if (busy) { state.rejected++; return reject(req, res, 503, 'busy') }
      busy = true
      req.setTimeout(2500, () => req.destroy())
      active = receive(req, res).finally(() => { busy = false; active = undefined })
    })
    const bound = await listenAndResolve(server, '127.0.0.1', piListenPort(ctx.config), 'hypaware/pi')

    /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
    async function receive(req, res) {
      await withSpan('pi.entries.receive', { component: 'plugin.pi', operation: 'entries.receive' }, async span => {
        try {
          const chunks = []
          let bytes = 0
          // An inactivity timeout alone can be kept alive forever by a slow
          // sender, holding the sole admission slot and accumulating chunks.
          const deadline = setTimeout(() => req.destroy(), 2500)
          deadline.unref()
          try {
            for await (const chunk of req) {
              bytes += chunk.length
              if (bytes > 512 * 1024) { state.rejected++; reject(req, res, 413, 'body_limit'); return }
              chunks.push(chunk)
            }
          } finally { clearTimeout(deadline) }
          let raw
          try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { state.rejected++; reject(req, res, 400, 'invalid_json'); return }
          const session = piSessionHeader(raw?.session)
          if (raw?.version !== 2 || !session || !Array.isArray(raw.entries) || raw.entries.length > 64 ||
              !Array.isArray(raw.message_indices) || raw.message_indices.length !== raw.entries.length ||
              raw.message_indices.some(index => !Number.isInteger(index) || index < 0 || index > 2147483647)) {
            state.rejected++
            // Only a version this listener does not speak reads as a skewed
            // extension. The same refusal covers every other shape failure,
            // which a stray loopback probe produces too, and reporting those
            // as a version problem points an operator at the wrong repair.
            if (Number.isInteger(raw?.version) && raw.version !== 2) {
              const at = now()
              state.refusals = at - state.refusedAt > SKEW_WINDOW_MS ? 1 : state.refusals + 1
              state.refusedAt = at
            }
            reject(req, res, 400, 'unsupported_batch')
            return
          }
          state.batches++
          refreshSessionIgnores(ignored)
          const resolver = createUsagePolicyResolver({ localOnlyListPath: deps.localOnlyListPath })
          const reason = sessionIgnoreLoadError(ignored) || ignored.has(String(session.id)) ? 'session_ignored'
            : resolver.resolve(String(session.cwd)).class === 'ignore' ? 'usage_policy' : undefined
          if (reason) {
            state.drops++
            span.setAttribute('status', 'skipped')
            ctx.log.info('pi.entries.dropped', { component: 'plugin.pi', operation: 'entries.receive', status: 'skipped', reason })
            send(res, 202, { status: 'skipped', reason })
            return
          }
          const mode = ['tui', 'print', 'json', 'rpc'].includes(raw.entrypoint) ? raw.entrypoint : 'unknown'
          const projection = projectPiEntries(raw, { entrypoint: mode })
          // Explicit native parent/tool IDs allow dropping all writer state
          // after this request. The dataset still dedupes committed/spooled IDs.
          const result = projection ? await createProjectedExchangeWriter({ storage: ctx.storage }).record(projection) : { rowsWritten: 0, rowsSkipped: 0 }
          state.rows += result.rowsWritten
          state.skipped += result.rowsSkipped
          state.lastError = undefined
          span.setAttribute('status', 'ok')
          span.setAttribute('rows_written', result.rowsWritten)
          ctx.log.info('pi.entries.recorded', { component: 'plugin.pi', operation: 'entries.record', status: 'ok', rows_written: result.rowsWritten, rows_skipped: result.rowsSkipped })
          send(res, 200, { status: 'ok', ...result })
        } catch {
          state.lastError = 'pi_capture_failed'
          span.setAttribute('status', 'failed')
          ctx.log.warn('pi.entries.failed', { component: 'plugin.pi', operation: 'entries.receive', error_kind: 'pi_capture_failed', status: 'failed' })
          send(res, 500, { error: 'pi_capture_failed' })
        }
      }, { component: 'plugin.pi' })
    }
    return {
      async status() {
        // The two clear on different evidence: an interleaved current sender
        // clears `lastError` while the skewed one keeps being refused, and a
        // lane with no current sender never clears `lastError` at all. Either
        // one reported alone would hide the other.
        const skewed = state.refusals >= SKEW_REFUSALS && now() - state.refusedAt <= SKEW_WINDOW_MS
        const reported = !skewed ? state.lastError
          : state.lastError ? `${state.lastError}; ${SKEW_ERROR}` : SKEW_ERROR
        return { state: 'ready', rowsWritten: state.rows, lastError: sessionIgnoreLoadError(ignored) ?? reported,
          details: { listen_host: bound.host, listen_port: bound.port, control_routes: [SESSION_IGNORE_ROUTE], batches_received: state.batches, rows_skipped: state.skipped, policy_drops: state.drops, rejected_requests: state.rejected, active_batches: busy ? 1 : 0 } }
      },
      async stop() {
        await new Promise((resolve, rejectClose) => {
          server.close(err => err ? rejectClose(err) : resolve(undefined))
          server.closeAllConnections()
        })
        await active
      },
    }
  }
}

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {number} status @param {string} error */
function reject(req, res, status, error) {
  drainRequestBody(req, res)
  send(res, status, { error })
}

/** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
function send(res, status, body) {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
