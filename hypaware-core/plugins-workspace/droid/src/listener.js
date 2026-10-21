// @ts-check

import http from 'node:http'
import path from 'node:path'
import { withSpan } from '../../../../src/core/observability/index.js'
import { refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { SESSION_IGNORE_ROUTE, createControlHandler, isControlPath } from '../../../../src/core/control/session_ignore.js'
import { isMisdirectedHost, listenAndResolve, requestUrlOf } from '../../../../src/core/otlp/server.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { drainRequestBody } from '../../../../src/core/util/reject_body.js'
import { createProjectedExchangeWriter } from '../../ai-gateway/src/exchange_writer.js'
import { droidListenPort } from './config.js'
import { droidSessionsRoot, MAX_LIVE_BYTES, readDroidTranscript } from './transcript.js'

/** @import { PluginActivationContext, StartedSource } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { DroidCursor } from '../../../../hypaware-core/plugins-workspace/droid/src/types.js' */

/** @param {{ localOnlyListPath?: string, ignoredSessions?: Set<string> }} deps */
export function createStartDroidSource(deps) {
  /** @param {PluginActivationContext} ctx @returns {Promise<StartedSource>} */
  return async function startDroidSource(ctx) {
    const ignored = deps.ignoredSessions ?? new Set()
    const root = droidSessionsRoot(ctx.env)
    /** @type {Map<string, DroidCursor>} */
    const cursors = new Map()
    const state = { rows: 0, skipped: 0, drops: 0, rejected: 0, notifications: 0, lastError: /** @type {string | undefined} */ (undefined) }
    let busy = false
    /** @type {Promise<void> | undefined} */
    let active
    const abort = new AbortController()
    const control = createControlHandler({ ignoredSessions: ignored, log: ctx.log, logEvent: 'droid.control.ignore_session', logFields: { component: 'plugin.droid' } })
    const server = http.createServer((req, res) => {
      if (isMisdirectedHost(req, { name: '@hypaware/droid', log: ctx.log })) return reject(req, res, 421, 'misdirected_request')
      const url = requestUrlOf(req)
      if (!url) return reject(req, res, 400, 'invalid_request')
      if (isControlPath(url.pathname)) {
        cursors.clear()
        control(req, res, url)
        return
      }
      if (req.method === 'GET' && url.pathname === '/') {
        send(res, 200, { name: 'hypaware/droid' })
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/hook') return reject(req, res, 404, 'not_found')
      if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return reject(req, res, 415, 'content_type')
      // @ref LLP 0551#bounds: one admitted scan, no unbounded notification queue
      if (busy) {
        state.rejected++
        return reject(req, res, 503, 'busy')
      }
      busy = true
      req.setTimeout(2500, () => req.destroy())
      active = receive(req, res).finally(() => {
        busy = false
        active = undefined
      })
    })
    const bound = await listenAndResolve(server, '127.0.0.1', droidListenPort(ctx.config), 'hypaware/droid')

    /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
    async function receive(req, res) {
      await withSpan('droid.hook.receive', { component: 'plugin.droid', operation: 'hook.receive' }, async span => {
        try {
          const chunks = []
          let bytes = 0
          const deadline = setTimeout(() => req.destroy(), 2500)
          deadline.unref()
          try {
            for await (const chunk of req) {
              bytes += chunk.length
              if (bytes > 16 * 1024) {
                state.rejected++
                reject(req, res, 413, 'body_limit')
                return
              }
              chunks.push(chunk)
            }
          } finally { clearTimeout(deadline) }
          let raw
          try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
            reject(req, res, 400, 'invalid_json')
            return
          }
          if (typeof raw?.session_id !== 'string' || !raw.session_id || typeof raw.transcript_path !== 'string' || !path.isAbsolute(raw.transcript_path)) {
            reject(req, res, 400, 'invalid_notification')
            return
          }
          state.notifications++
          refreshSessionIgnores(ignored)
          const resolver = createUsagePolicyResolver({ localOnlyListPath: deps.localOnlyListPath })
          const file = path.resolve(raw.transcript_path)
          let rows = 0
          let skipped = 0
          let dropped = false
          for await (const item of readDroidTranscript(file, { root, sessionId: raw.session_id, cursor: cursors.get(file), maxBytes: MAX_LIVE_BYTES, signal: abort.signal,
            allowed: session => !sessionIgnoreLoadError(ignored) && !ignored.has(String(session.id)) && resolver.resolve(String(session.cwd)).class !== 'ignore',
          })) {
            if (item.dropped) {
              dropped = true
              cursors.delete(file)
            }
            if (item.projection) {
              const result = await createProjectedExchangeWriter({ storage: ctx.storage }).record(item.projection)
              rows += result.rowsWritten
              skipped += result.rowsSkipped
            }
            // Commit only after every yielded projection was written. A failed
            // batch replays on the next notification; durable IDs deduplicate.
            if (item.cursor) {
              cursors.delete(file)
              if (cursors.size >= 64) cursors.delete(cursors.keys().next().value)
              cursors.set(file, item.cursor)
            }
          }
          state.rows += rows
          state.skipped += skipped
          if (dropped) state.drops++
          state.lastError = undefined
          span.setAttribute('status', dropped ? 'skipped' : 'ok')
          span.setAttribute('rows_written', rows)
          ctx.log.info('droid.hook.recorded', { component: 'plugin.droid', operation: 'hook.record', status: dropped ? 'skipped' : 'ok', rows_written: rows, rows_skipped: skipped })
          send(res, dropped ? 202 : 200, { status: dropped ? 'skipped' : 'ok', rowsWritten: rows, rowsSkipped: skipped })
        } catch {
          state.lastError = 'droid_capture_failed'
          span.setAttribute('status', 'failed')
          ctx.log.warn('droid.hook.failed', { component: 'plugin.droid', operation: 'hook.receive', status: 'failed', error_kind: 'droid_capture_failed' })
          send(res, 500, { error: 'droid_capture_failed' })
        }
      }, { component: 'plugin.droid' })
    }
    return {
      async status() {
        return { state: 'ready', rowsWritten: state.rows, lastError: sessionIgnoreLoadError(ignored) ?? state.lastError,
          details: { listen_host: bound.host, listen_port: bound.port, control_routes: [SESSION_IGNORE_ROUTE], notifications_received: state.notifications, rows_skipped: state.skipped, policy_drops: state.drops, rejected_requests: state.rejected, active_scans: busy ? 1 : 0, cursor_count: cursors.size } }
      },
      async stop() {
        abort.abort()
        await new Promise((resolve, rejectClose) => {
          server.close(err => err ? rejectClose(err) : resolve(undefined))
          server.closeAllConnections()
        })
        await active
        cursors.clear()
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
