// @ts-check

import http from 'node:http'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { SESSION_IGNORE_ROUTE, createControlHandler, isControlPath } from '../../../../src/core/control/session_ignore.js'
import { isMisdirectedHost, listenAndResolve, requestUrlOf } from '../../../../src/core/otlp/server.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { createProjectedExchangeWriter } from '../../ai-gateway/src/exchange_writer.js'
import { opencodeListenPort } from './config.js'
import { projectOpenCodeSnapshot } from './projector.js'

/**
 * @import { PluginActivationContext, SourceStatus, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

const PLUGIN_NAME = '@hypaware/opencode'
const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 16 * 1024 * 1024
// How much of a rejected request's body is read before the connection is cut.
// A rejected body a caller is still uploading has to be read for the answer to
// reach it at all, so the read cannot be skipped; left unbounded, its length is
// the sender's to choose. A legitimate rejected body is a snapshot header or
// smaller, so nothing this listener serves comes near the cap.
const MAX_REJECTED_DRAIN_BYTES = 64 * 1024
// A rejected snapshot is always counted, but logged at most this often. The
// route is unauthenticated and reachable by the same browser page the
// content-type gate exists to refuse, so a line per rejection would trade
// blocked row injection in `ai_gateway_messages` for unbounded row growth in
// `logs`. The neighbouring 404 branch logs nothing at all for that reason.
const UNSUPPORTED_CONTENT_TYPE_LOG_INTERVAL_MS = 60 * 1000
// The logged content-type is attacker-chosen and bounded only by Node header
// budget; a real one is short.
const LOGGED_CONTENT_TYPE_MAX_CHARS = 128

/**
 * @param {{ localOnlyListPath?: string, ignoredSessions?: Set<string> }} deps
 */
export function createStartOpenCodeSource(deps) {
  /** @param {PluginActivationContext} ctx @returns {Promise<StartedSource>} */
  return async function startOpenCodeSource(ctx) {
    const startedAt = new Date().toISOString()
    const ignoredSessions = deps.ignoredSessions ?? new Set()
    const resolver = createUsagePolicyResolver({ localOnlyListPath: deps.localOnlyListPath })
    const writer = createProjectedExchangeWriter({ storage: ctx.storage })
    const state = {
      pluginEvents: 0,
      snapshots: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      policyDrops: 0,
      sessionDrops: 0,
      missingCwd: 0,
      unknownEntrypoints: 0,
      storeActivityGaps: 0,
      unsupportedContentTypes: 0,
      unsupportedContentTypeLoggedAt: 0,
      lastEventAt: undefined,
      reconciliationCursor: undefined,
      lastError: undefined,
    }

    const control = createControlHandler({
      ignoredSessions,
      log: ctx.log,
      logEvent: 'opencode.control.ignore_session',
      logFields: { [Attr.PLUGIN]: PLUGIN_NAME, [Attr.COMPONENT]: 'sources' },
    })

    const server = http.createServer((req, res) => {
      if (isMisdirectedHost(req, { name: PLUGIN_NAME, log: ctx.log })) {
        rejectJson(req, res, 421, { error: 'misdirected request' })
        return
      }
      // Shared with the OTLP listener: a constant base keeps `Host` out of the
      // parser, and a request target `new URL` rejects is answered rather than
      // thrown out of this handler, where nothing would catch it.
      const url = requestUrlOf(req)
      if (!url) {
        rejectJson(req, res, 400, { error: 'invalid request target' })
        return
      }
      if (isControlPath(url.pathname)) {
        control(req, res, url)
        return
      }
      if (req.method === 'GET' && url.pathname === '/') {
        sendJson(res, 200, { name: 'hypaware/opencode', status: 'ready' })
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/snapshot') {
        rejectJson(req, res, 404, { error: 'not found' })
        return
      }
      // A page in the user's browser cannot preflight its way in here, but it
      // can send a preflight-free 'simple request' - text/plain,
      // application/x-www-form-urlencoded, multipart/form-data - and without
      // this gate that was enough to inject fabricated rows into
      // ai_gateway_messages. Requiring application/json takes the route out of
      // the simple-request set, so a cross-origin POST needs a preflight this
      // server never answers. Same posture, and the same 415, as the shared
      // OTLP listener (src/core/otlp/server.js). The managed plugin asset
      // already sends this header, so nothing legitimate is turned away.
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        // Count and name the rejection. The managed asset wraps its post in a
        // bare try/catch and never reads the status, so a header regression
        // there would otherwise be indistinguishable from "OpenCode is not
        // running": snapshots_received 0, no error, nothing naming
        // content-type.
        state.unsupportedContentTypes += 1
        const now = Date.now()
        if (now - state.unsupportedContentTypeLoggedAt >= UNSUPPORTED_CONTENT_TYPE_LOG_INTERVAL_MS) {
          state.unsupportedContentTypeLoggedAt = now
          ctx.log.warn('opencode.snapshot.unsupported_content_type', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            [Attr.COMPONENT]: 'sources',
            [Attr.OPERATION]: 'snapshot.receive',
            error_kind: 'unsupported_content_type',
            content_type: contentType ? contentType.slice(0, LOGGED_CONTENT_TYPE_MAX_CHARS) : null,
            // Every rejection since the listener started, so a burst the
            // interval above swallowed is still legible from one line.
            rejected_total: state.unsupportedContentTypes,
            status: 'rejected',
          })
        }
        rejectJson(req, res, 415, {
          error: `unsupported content-type: expected application/json, got '${contentType || 'none'}'`,
        })
        return
      }
      void receiveSnapshot(req, res, { ctx, state, ignoredSessions, resolver, writer })
    })
    const bound = await listenAndResolve(server, HOST, opencodeListenPort(ctx.config), 'hypaware/opencode')

    return {
      async status() {
        /** @type {SourceStatus} */
        const status = {
          state: 'ready',
          rowsWritten: state.rowsWritten,
          details: {
            listen_host: bound.host,
            listen_port: bound.port,
            control_routes: [SESSION_IGNORE_ROUTE],
            plugin_events: state.pluginEvents,
            snapshots_received: state.snapshots,
            reconciliation_cursor: state.reconciliationCursor ?? null,
            rows_skipped: state.rowsSkipped,
            policy_drops: state.policyDrops,
            session_drops: state.sessionDrops,
            missing_cwd: state.missingCwd,
            unknown_entrypoints: state.unknownEntrypoints,
            store_activity_gaps: state.storeActivityGaps,
            unsupported_content_types: state.unsupportedContentTypes,
            ignored_sessions: ignoredSessions.size,
            last_event_at: state.lastEventAt ?? null,
            listener_started_at: startedAt,
          },
        }
        if (state.lastError) status.lastError = state.lastError
        return status
      },
      async stop() {
        await new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve(undefined)))
          // The OpenCode plugin posts with fetch (undici keep-alive), so a
          // running OpenCode holds an idle socket open and `close()` alone
          // would block `hyp daemon stop` until it exits.
          server.closeIdleConnections?.()
          server.closeAllConnections?.()
        })
      },
    }
  }
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {{ ctx: PluginActivationContext, state: Record<string, any>, ignoredSessions: Set<string>, resolver: UsagePolicyResolver, writer: ReturnType<typeof createProjectedExchangeWriter> }} deps
 */
async function receiveSnapshot(req, res, deps) {
  await withSpan(
    'opencode.snapshot.receive',
    {
      [Attr.PLUGIN]: PLUGIN_NAME,
      [Attr.COMPONENT]: 'sources',
      [Attr.OPERATION]: 'snapshot.receive',
    },
    async (span) => {
      try {
        const raw = await readJson(req)
        deps.state.pluginEvents += 1
        deps.state.snapshots += 1
        deps.state.lastEventAt = new Date().toISOString()
        const session = raw && typeof raw === 'object' ? raw.session : undefined
        const sessionId = session && typeof session === 'object' && typeof session.id === 'string' ? session.id : undefined
        if (sessionId && deps.ignoredSessions.has(sessionId)) {
          deps.state.sessionDrops += 1
          span.setAttribute('status', 'skipped')
          span.setAttribute('error_kind', 'session_ignored')
          sendJson(res, 202, { status: 'skipped', reason: 'session_ignored' })
          return
        }
        const cwd = session && typeof session === 'object' && typeof session.directory === 'string'
          ? session.directory
          : undefined
        if (!cwd) {
          deps.state.missingCwd += 1
          deps.ctx.log.warn('opencode.snapshot.missing_cwd', {
            [Attr.COMPONENT]: 'sources',
            [Attr.OPERATION]: 'snapshot.receive',
            session_id: sessionId ?? null,
            status: 'skipped',
          })
          sendJson(res, 202, { status: 'skipped', reason: 'missing_cwd' })
          return
        }
        const policy = deps.resolver.resolve(cwd)
        if (policy.class === 'ignore') {
          deps.state.policyDrops += 1
          deps.ctx.log[policy.warn ? 'warn' : 'info']('opencode.snapshot.usage_policy_drop', {
            [Attr.COMPONENT]: 'sources',
            [Attr.OPERATION]: 'usage_policy_drop',
            session_id: sessionId ?? null,
            class: 'ignore',
            governed_by: policy.governedBy,
            status: 'skipped',
          })
          sendJson(res, 202, { status: 'skipped', reason: 'usage_policy' })
          return
        }
        const entrypoint = typeof raw.entrypoint === 'string' ? raw.entrypoint : 'unknown'
        if (entrypoint === 'unknown') deps.state.unknownEntrypoints += 1
        const projection = projectOpenCodeSnapshot(
          { session, messages: raw.messages },
          {
            entrypoint,
            entrypointSource: typeof raw.entrypoint_source === 'string'
              ? raw.entrypoint_source
              : 'plugin-process',
          }
        )
        if (!projection) {
          deps.state.storeActivityGaps += 1
          sendJson(res, 202, { status: 'skipped', reason: 'snapshot_incomplete' })
          return
        }
        const result = await deps.writer.record(projection, {
          gatewayAttributes: { gateway: { source: 'opencode-plugin' } },
        })
        deps.state.rowsWritten += result.rowsWritten
        deps.state.rowsSkipped += result.rowsSkipped
        deps.state.reconciliationCursor = `${projection.session_id}:${projection.messages.at(-1)?.message_id ?? ''}`
        deps.ctx.log.info('opencode.snapshot.reconciled', {
          [Attr.COMPONENT]: 'sources',
          [Attr.OPERATION]: 'snapshot.reconcile',
          session_id: projection.session_id,
          entrypoint,
          rows_written: result.rowsWritten,
          rows_skipped: result.rowsSkipped,
          status: 'ok',
        })
        span.setAttribute('status', 'ok')
        span.setAttribute('rows_written', result.rowsWritten)
        span.setAttribute('rows_skipped', result.rowsSkipped)
        sendJson(res, 200, { status: 'ok', ...result })
      } catch (err) {
        deps.state.lastError = err instanceof Error ? err.message : String(err)
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'snapshot_receive_failed')
        deps.ctx.log.warn('opencode.snapshot.failed', {
          [Attr.COMPONENT]: 'sources',
          [Attr.OPERATION]: 'snapshot.receive',
          error_kind: 'snapshot_receive_failed',
          error: deps.state.lastError,
        })
        sendJson(res, 500, { error: 'snapshot receive failed' })
      }
    },
    { component: 'plugin.opencode' }
  )
}

/** @param {http.IncomingMessage} req */
async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error('snapshot body exceeds 16 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Answer a request this listener refuses, discarding at most
 * MAX_REJECTED_DRAIN_BYTES of its body.
 *
 * Past the cap the request is paused, which is what bounds the read, and the
 * connection is closed once the answer is on the wire. Closing as soon as the
 * cap is hit would race the answer out and truncate it for a caller reading
 * the status it needs.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function rejectJson(req, res, status, body) {
  let drained = 0
  let overCap = false
  function closeIfAnswered() {
    if (overCap && res.writableFinished) req.destroy()
  }
  req.on('data', (chunk) => {
    drained += chunk.length
    if (drained <= MAX_REJECTED_DRAIN_BYTES) return
    overCap = true
    req.pause()
    closeIfAnswered()
  })
  res.on('finish', closeIfAnswered)
  sendJson(res, status, body)
}

/** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
