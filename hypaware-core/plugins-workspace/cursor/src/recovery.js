// @ts-check
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { createUsagePolicyResolver, CLASS_RANK, isEqualOrDescendant } from '../../../../src/core/usage-policy/index.js'
import { readBackfillPolicy } from '../../../../src/core/config/backfill_policy.js'
import { AI_GATEWAY_MESSAGES_DATASET, projectedExchangeItem, resolveWindow } from '../../../../src/core/backfill/scan_util.js'
import { readCursorSession, listCursorSessions, safeError } from './native.js'

/** @import { BackfillContribution, AiGatewayProjectedExchange, JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { CursorReadOptions, CursorSession } from '../../../../hypaware-core/plugins-workspace/cursor/src/types.js' */

/** @param {{ localOnlyListPath?: string, ignoredSessions?: Set<string> }} opts */
export function cursorAdmission(opts) {
  const resolver = createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
  return {
    /** @param {CursorSession} session */
    session(session) { return !opts.ignoredSessions?.has(session.id) && resolver.resolve(session.cwd).class !== 'ignore' },
    /** @param {AiGatewayProjectedExchange} exchange */
    async filter(exchange) {
      if (opts.ignoredSessions?.has(exchange.session_id ?? '') || !exchange.cwd || resolver.resolve(exchange.cwd).class === 'ignore') return undefined
      const cwd = exchange.cwd
      const rank = CLASS_RANK[resolver.resolve(cwd).class]
      const messages = []
      for (const message of exchange.messages) {
        let allowed = true
        if (message.role === 'tool' && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.name !== 'Read') continue
            const input = block.input
            const file = input && typeof input === 'object' && !Array.isArray(input) ? input.path ?? input.file_path : undefined
            if (typeof file !== 'string') { allowed = false; break }
            const full = path.resolve(cwd, file)
            try {
              const [root, target] = await Promise.all([realpath(cwd), realpath(full)])
              if (!isEqualOrDescendant(target, root) || [path.dirname(full), path.dirname(target)].some((dir) => CLASS_RANK[resolver.resolve(dir).class] > rank)) allowed = false
            } catch {
              // Missing-file errors contain no successful read contents. Keep
              // explicit errors only, still applying lexical directory policy.
              allowed = block.is_error === true && isEqualOrDescendant(full, cwd) && CLASS_RANK[resolver.resolve(path.dirname(full)).class] <= rank
            }
          }
        }
        if (allowed) messages.push(message)
      }
      if (opts.ignoredSessions?.has(exchange.session_id ?? '') || resolver.resolve(cwd).class === 'ignore') return undefined
      return { ...exchange, messages }
    },
  }
}

/** @param {CursorReadOptions & { localOnlyListPath?: string, ignoredSessions?: Set<string>, config?: JsonObject, activeRecoveries?: Set<string> }} [opts]
 * @returns {BackfillContribution}
 * @ref LLP 0399#recovery: one reader and identity for live recovery and scheduled history
 */
export function createCursorBackfillProvider(opts = {}) {
  const policy = readBackfillPolicy({ name: '@hypaware/cursor', config: opts.config })
  const raw = opts.config?.backfill
  const cron = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.sweep_cron === 'string' ? raw.sweep_cron : '*/5 * * * *'
  const fingerprints = new Map()
  const activeRecoveries = opts.activeRecoveries ?? new Set()
  return {
    name: 'cursor', plugin: '@hypaware/cursor', datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Recover Cursor editor and CLI native sessions',
    ...(policy.onJoin !== false ? { sweep: { cron } } : {}),
    async *run(ctx) {
      const admission = cursorAdmission(opts)
      const window = resolveWindow(ctx)
      const windowKey = JSON.stringify([ctx.since, ctx.until, ctx.retentionDays])
      const selectionErrors = new Set()
      const sessions = await listCursorSessions({ ...opts, env: opts.env ?? ctx.env, onError: (err) => {
        selectionErrors.add(safeError(err).message)
        ctx.log.warn('cursor.recovery.incomplete', { component: 'plugin.cursor', operation: 'recovery.select', status: 'incomplete', error_kind: safeError(err).message })
      } }, window)
      for (const error_kind of selectionErrors) yield { type: 'event', event: 'cursor.recovery.incomplete', attributes: { error_kind } }
      const present = new Set(sessions.map((session) => session.dbPath + ':' + session.id))
      for (const key of fingerprints.keys()) if (!present.has(key)) fingerprints.delete(key)
      ctx.log.info('cursor.recovery.selected', { component: 'plugin.cursor', operation: 'recovery.select', sessions: sessions.length, status: 'ok' })
      for (const session of sessions) {
        if (ctx.signal?.aborted) return
        const key = session.dbPath + ':' + session.id
        if (!admission.session(session)) {
          fingerprints.delete(key)
          yield { type: 'event', event: 'cursor.recovery.policy_drop', attributes: { status: 'skipped' } }
          continue
        }
        if (activeRecoveries.has(session.id)) {
          yield { type: 'event', event: 'cursor.recovery.busy', attributes: { status: 'skipped' } }
          continue
        }
        activeRecoveries.add(session.id)
        try {
          const previous = fingerprints.get(key)
          const snapshot = readCursorSession(session, ctx.sweep && !ctx.dryRun && previous?.windowKey === windowKey ? previous.root : undefined)
          if (snapshot.unchanged) {
            ctx.log.info('cursor.recovery.unchanged', { component: 'plugin.cursor', operation: 'recovery.read', status: 'skipped' })
            continue
          }
          const failedBefore = ctx.itemsFailed ?? 0
          let complete = true
          for (const exchange of snapshot.exchanges) {
            if (ctx.signal?.aborted) return
            const messages = exchange.messages.filter((message) => {
              const time = message.message_created_at ? Date.parse(message.message_created_at) : undefined
              return time === undefined || !Number.isFinite(time) ||
                ((window.sinceMs === undefined || time >= window.sinceMs) && (window.untilMs === undefined || time <= window.untilMs))
            })
            const permitted = await admission.filter({ ...exchange, messages })
            if (!permitted || permitted.messages.length !== messages.length) complete = false
            if (permitted?.messages.length) yield projectedExchangeItem(permitted, { client_name: 'cursor', native_id: session.id, source_path: session.dbPath })
          }
          if (ctx.sweep && !ctx.dryRun && complete && (ctx.itemsFailed ?? 0) === failedBefore && !ctx.signal?.aborted && admission.session(session)) {
            if (fingerprints.size >= 1000) fingerprints.delete(fingerprints.keys().next().value)
            fingerprints.set(key, { root: snapshot.root, windowKey })
          }
          ctx.log.info('cursor.recovery.read', { component: 'plugin.cursor', operation: 'recovery.read', frontend: session.frontend, turns: snapshot.exchanges.length, status: 'ok' })
        } catch (err) {
          ctx.log.warn('cursor.recovery.incomplete', { component: 'plugin.cursor', operation: 'recovery.read', status: 'incomplete', error_kind: safeError(err).message })
          yield { type: 'event', event: 'cursor.recovery.incomplete', attributes: { error_kind: safeError(err).message } }
        } finally { activeRecoveries.delete(session.id) }
      }
    },
  }
}
