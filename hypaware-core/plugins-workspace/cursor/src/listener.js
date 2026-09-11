// @ts-check

import http from 'node:http'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { SESSION_IGNORE_ROUTE, createControlHandler, isControlPath } from '../../../../src/core/control/session_ignore.js'
import { isMisdirectedHost, listenAndResolve, requestUrlOf } from '../../../../src/core/otlp/server.js'
import { CLASS_RANK, createUsagePolicyResolver, isEqualOrDescendant } from '../../../../src/core/usage-policy/index.js'
import { drainRequestBody } from '../../../../src/core/util/reject_body.js'
import { isPlainObject } from '../../../../src/core/util/json_util.js'
import { createProjectedExchangeWriter } from '../../ai-gateway/src/exchange_writer.js'
import { CURSOR_EVENTS } from './attach.js'
import { cursorListenPort } from './config.js'
import { cursorCwd, projectCursorHook } from './projector.js'
import { findCursorSession, readCursorSession, safeError, CursorReadError } from './native.js'
import { cursorAdmission } from './recovery.js'

/** @import { CursorReadOptions } from '../../../../hypaware-core/plugins-workspace/cursor/src/types.js' */

/** @import { PluginActivationContext, StartedSource, AiGatewayProjectedExchange } from '../../../../hypaware-plugin-kernel-types.js' */

const MAX_BYTES = 1024 * 1024
const MAX_REQUESTS = 4

/** @param {{ localOnlyListPath?: string, ignoredSessions?: Set<string>, readOptions?: CursorReadOptions, recoveryDelayMs?: number, activeRecoveries?: Set<string> }} deps */
export function createStartCursorSource(deps = {}) {
  /** @param {PluginActivationContext} ctx @returns {Promise<StartedSource>} */
  return async (ctx) => {
    const ignoredSessions = deps.ignoredSessions ?? new Set()
    let policy = createUsagePolicyResolver({ localOnlyListPath: deps.localOnlyListPath })
    const counts = { callbacks: 0, rows_written: 0, rows_skipped: 0, policy_drops: 0, session_drops: 0, missing_cwd: 0, incomplete: 0, lifecycle_events: 0, unknown_entrypoints: 0, missing_transcripts: 0, rejected: 0, failures: 0, subagent_events: 0 }
    let active = 0
    let lastEventAt
    let lastError
    let serial = Promise.resolve()
    let writer = createProjectedExchangeWriter({ storage: ctx.storage })
    let writtenCallbacks = 0
    const pending = new Map()
    const completedRoots = new Map()
    const activeRecoveries = deps.activeRecoveries ?? new Set()
    let stopped = false
    let recovering = false
    let recoveryTimer
    const recoveryCounts = { native_reads: 0, native_failures: 0, recovery_queue_drops: 0 }
    const readOptions = { env: ctx.env, ...deps.readOptions }
    const armRecovery = () => {
      if (stopped || recovering || recoveryTimer || !pending.size) return
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined
        recovering = true
        const work = serial.then(async () => {
          const batch = [...pending.entries()].slice(0, 16)
          for (const [key, item] of batch) {
            if (stopped) break
            // Delete before await so a new callback can request a later pass.
            pending.delete(key)
            let claimed = false
            try {
              if (activeRecoveries.has(item.id)) throw new CursorReadError('native_recovery_busy')
              activeRecoveries.add(item.id)
              claimed = true
              const admission = cursorAdmission({ localOnlyListPath: deps.localOnlyListPath, ignoredSessions })
              if (ignoredSessions.has(item.id) || policy.resolve(item.cwd).class === 'ignore') { completedRoots.delete(key); continue }
              const session = await findCursorSession(item.id, item.cwd, readOptions)
              if (!session) throw new CursorReadError('native_session_unavailable')
              const [nativeCwd, hookCwd] = await Promise.all([realpath(session.cwd), realpath(item.cwd)])
              if (nativeCwd !== hookCwd || !admission.session(session)) continue
              const snapshot = readCursorSession(session, completedRoots.get(key))
              if (snapshot.unchanged) continue
              let complete = true
              // Bound the shared writer's identity state per recovery pass.
              const nativeWriter = createProjectedExchangeWriter({ storage: ctx.storage })
              let rowsWritten = 0
              for (const exchange of snapshot.exchanges) {
                if (stopped) { complete = false; break }
                const permitted = await admission.filter(exchange)
                if (!permitted || permitted.messages.length !== exchange.messages.length) complete = false
                if (!permitted?.messages.length) continue
                const result = await nativeWriter.record(permitted)
                rowsWritten += result.rowsWritten
                counts.rows_written += result.rowsWritten
                counts.rows_skipped += result.rowsSkipped
              }
              if (complete && !stopped && admission.session(session)) {
                if (completedRoots.size >= 64) completedRoots.delete(completedRoots.keys().next().value)
                completedRoots.set(key, snapshot.root)
              }
              recoveryCounts.native_reads++
              lastError = undefined
              ctx.log.info('cursor.recovery.recorded', { [Attr.OPERATION]: 'recovery.record', frontend: session.frontend, rows_written: rowsWritten, status: 'ok' })
            } catch (err) {
              recoveryCounts.native_failures++
              lastError = safeError(err).message
              ctx.log.warn('cursor.recovery.incomplete', { [Attr.OPERATION]: 'recovery.read', error_kind: lastError, status: 'incomplete' })
              if (item.attempt < 2 && !pending.has(key) && pending.size < 64) pending.set(key, { ...item, attempt: item.attempt + 1 })
            } finally { if (claimed) activeRecoveries.delete(item.id) }
          }
        })
        serial = work.catch(() => {})
        void work.finally(() => { recovering = false; armRecovery() }).catch(() => {})
      }, deps.recoveryDelayMs ?? 1000)
      recoveryTimer.unref()
    }
    const scheduleRecovery = (id, cwd) => {
      if (stopped) return
      const key = JSON.stringify([id, cwd])
      if (!pending.has(key) && pending.size >= 64) { recoveryCounts.recovery_queue_drops++; return }
      pending.set(key, { id, cwd, attempt: 0 })
      armRecovery()
    }
    const control = createControlHandler({ ignoredSessions, log: ctx.log, logEvent: 'cursor.control.ignore_session', logFields: { [Attr.PLUGIN]: '@hypaware/cursor' } })

    const server = http.createServer((req, res) => {
      const url = requestUrlOf(req)
      if (isMisdirectedHost(req, { name: '@hypaware/cursor', log: ctx.log })) return reject(req, res, 421)
      if (!url) return reject(req, res, 400)
      if (isControlPath(url.pathname)) return control(req, res, url)
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { name: 'hypaware/cursor', status: 'ready' })
      if (req.method !== 'POST' || url.pathname !== '/hook') return reject(req, res, 404)
      if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        counts.rejected++
        return reject(req, res, 415)
      }
      // @ref LLP 0399#resources: bound aggregate bodies and queued writes,
      // not merely each request. Reject before reading another body.
      if (active >= MAX_REQUESTS) {
        counts.rejected++
        return reject(req, res, 503)
      }
      active++
      void withSpan('cursor.hook.receive', { [Attr.COMPONENT]: 'sources', [Attr.OPERATION]: 'hook.receive' }, async (span) => {
        const timeout = setTimeout(() => req.destroy(), 2000)
        try {
          const chunks = []
          let bytes = 0
          for await (const chunk of req) {
            bytes += chunk.length
            if (bytes > MAX_BYTES) {
              counts.rejected++
              reject(req, res, 413)
              return
            }
            chunks.push(chunk)
          }
          clearTimeout(timeout)
          const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!isPlainObject(raw) || !isPlainObject(raw.event) ||
              typeof raw.delivery_id !== 'string' || !/^[0-9a-f-]{36}$/.test(raw.delivery_id) ||
              typeof raw.observed_at !== 'string' || !Number.isFinite(Date.parse(raw.observed_at))) {
            counts.incomplete++
            send(res, 400, { error: 'invalid hook envelope' })
            return
          }
          const event = raw.event
          const hook = event.hook_event_name
          counts.callbacks++
          // The shared resolver also memoizes cwd values. Retire that cache
          // periodically, including during streams of dropped callbacks.
          if (counts.callbacks % 1024 === 0) policy = createUsagePolicyResolver({ localOnlyListPath: deps.localOnlyListPath })
          lastEventAt = new Date().toISOString()
          counts.unknown_entrypoints++
          if (!event.transcript_path) counts.missing_transcripts++
          if (hook === 'subagentStart' || hook === 'subagentStop') counts.subagent_events++
          const cwd = cursorCwd(event)
          const session = typeof event.conversation_id === 'string' ? event.conversation_id : ''
          const skip = (reason) => {
            span.setAttribute('status', 'skipped')
            span.setAttribute('reason', reason)
            send(res, 202, { status: 'skipped', reason })
          }
          if (!cwd) {
            counts.missing_cwd++
            skip('missing_or_ambiguous_cwd')
            return
          }
          if (!session || session.length > 256 || typeof hook !== 'string' || !CURSOR_EVENTS.includes(hook)) {
            counts.incomplete++
            skip('unsupported_hook')
            return
          }
          // Check once before projection, and again inside the serialized
          // write so a session ignored while queued cannot slip through.
          const admission = async () => {
            if (ignoredSessions.has(session)) {
              counts.session_drops++
              return 'session_ignored'
            }
            const workspacePolicy = policy.resolve(cwd).class
            if (workspacePolicy === 'ignore') {
              counts.policy_drops++
              return 'usage_policy'
            }
            // @ref LLP 0399#file-content: one cwd governs export, so drop
            // file observations outside it or under a stricter file policy.
            if (hook === 'beforeReadFile') {
              const file = event.file_path
              if (typeof file !== 'string' || file.length > 4096 || !path.isAbsolute(file)) {
                counts.incomplete++
                return 'invalid_file_path'
              }
              try {
                const [root, target] = await Promise.all([realpath(cwd), realpath(file)])
                if (!isEqualOrDescendant(target, root) ||
                    [path.dirname(file), path.dirname(target)].some((dir) =>
                      CLASS_RANK[policy.resolve(dir).class] > CLASS_RANK[workspacePolicy])) {
                  counts.policy_drops++
                  return 'file_scope_or_policy'
                }
              } catch {
                counts.policy_drops++
                return 'file_path_unresolved'
              }
              if (ignoredSessions.has(session)) {
                counts.session_drops++
                return 'session_ignored'
              }
            }
          }
          const denied = await admission()
          if (denied) {
            skip(denied)
            return
          }
          // @ref LLP 0399#identity: the native store owns conversation rows.
          // Hook-only response/tool IDs cannot safely join native Shell IDs.
          scheduleRecovery(session, cwd)
          if (hook !== 'beforeReadFile') {
            counts.lifecycle_events++
            skip('native_recovery_scheduled')
            return
          }
          // Every lifecycle hook already returned above, so the only way past
          // the projector here is a beforeReadFile whose own fields are unusable.
          const projection = projectCursorHook(raw)
          if (!projection) {
            counts.incomplete++
            skip('incomplete_hook')
            return
          }
          const write = serial.then(async () => {
            const denied = await admission()
            if (denied) {
              skip(denied)
              return
            }
            // No conversation chains depend on writer state: every message
            // has explicit identity and parents. Rotate only between writes;
            // existing stored/waiting-part dedupe remains authoritative.
            if (writtenCallbacks >= 1024) {
              writer = createProjectedExchangeWriter({ storage: ctx.storage })
              writtenCallbacks = 0
            }
            const result = await writer.record(projection, { gatewayAttributes: { gateway: { source: 'cursor-hooks' } } })
            writtenCallbacks++
            counts.rows_written += result.rowsWritten
            counts.rows_skipped += result.rowsSkipped
            span.setAttribute('status', 'ok')
            span.setAttribute('rows_written', result.rowsWritten)
            ctx.log.info('cursor.hook.recorded', { [Attr.COMPONENT]: 'sources', [Attr.OPERATION]: 'hook.record', hook, rows_written: result.rowsWritten, status: 'ok' })
            send(res, 200, { status: 'ok', ...result })
          })
          serial = write.catch(() => {})
          await write
        } catch {
          counts.failures++
          lastError = 'hook_receive_or_storage_failed'
          span.setAttribute('status', 'failed')
          span.setAttribute('error_kind', lastError)
          // Do not log parse errors or storage messages that may embed data.
          send(res, 500, { error: lastError })
        } finally {
          clearTimeout(timeout)
          active--
        }
      }, { component: 'plugin.cursor' }).catch(() => {})
    })
    server.requestTimeout = 3000
    server.headersTimeout = 3000
    const bound = await listenAndResolve(server, '127.0.0.1', cursorListenPort(ctx.config), 'hypaware/cursor')
    return {
      async status() {
        return {
          state: 'ready', rowsWritten: counts.rows_written, lastError,
          details: { ...counts, ...recoveryCounts, pending_recovery: pending.size, listen_host: bound.host, listen_port: bound.port, control_routes: [SESSION_IGNORE_ROUTE],
            active_requests: active, last_event_at: lastEventAt ?? null,
            coverage: 'native_sessions_and_file_observations', frontend: 'native_store', usage_supported: false,
            history_recovery: 'native_store', response_identity: 'native_turn_step',
            assistant_segments: 'native_checkpoint',
          },
        }
      },
      async stop() {
        stopped = true
        clearTimeout(recoveryTimer)
        pending.clear()
        await new Promise((resolve, reject) => {
          server.close((err) => err ? reject(err) : resolve(undefined))
          server.closeAllConnections()
        })
        await serial
      },
    }
  }
}

/** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
function send(res, status, body) {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {number} status */
function reject(req, res, status) {
  drainRequestBody(req, res)
  send(res, status, { error: http.STATUS_CODES[status] })
}
