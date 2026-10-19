// @ts-check
import { setImmediate } from 'node:timers/promises'
import { resolveWindow, projectedExchangeItem, AI_GATEWAY_MESSAGES_DATASET } from '../../../../src/core/backfill/scan_util.js'
import { readBackfillPolicy } from '../../../../src/core/config/backfill_policy.js'
import { discoverStores, fingerprint } from './paths.js'
import { openDatabase, retainedSpans, readAttributes, createOwnershipResolver } from './native.js'
import { projectSpan } from './projector.js'
import { createAdmission } from './admission.js'

/** @import { BackfillContribution, BackfillItem } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { CopilotOptions, CopilotHealth } from '../../../../hypaware-core/plugins-workspace/copilot/src/types.js' */

export const COPILOT_KIND = 'copilot.projected_exchange'
// Private write guards contain policy rechecks, never durable payload state.
/** @type {WeakMap<BackfillItem, () => Promise<boolean>>} */
export const writeGuards = new WeakMap()

/**
 * @param {CopilotOptions} opts @param {CopilotHealth} health
 * @returns {BackfillContribution}
 * @ref LLP 0549#recovery: bounded retained-ID reconciliation catches late parents and replacement
 */
export function createCopilotBackfillProvider(opts, health) {
  const admission = createAdmission(opts)
  const ownership = createOwnershipResolver(opts.env ?? process.env)
  const policy = readBackfillPolicy({ name: '@hypaware/copilot', config: opts.config })
  const floor = Date.now()
  const raw = opts.config?.backfill
  const cron = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.sweep_cron === 'string' ? raw.sweep_cron : '* * * * *'
  /** @type {Map<string, string>} */
  const seen = new Map()
  let running = false
  let passes = 0
  return {
    name: 'copilot', plugin: '@hypaware/copilot', datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Recover VS Code Copilot completed spans from Local and Agent Host databases',
    sweep: { cron },
    async *run(ctx) {
      if (running) {
        yield { type: 'event', event: 'copilot.recovery.busy' }
        return
      }
      running = true
      if (++passes % 12 === 0) seen.clear()
      Object.assign(health, { stores: 0, selected: 0, read: 0, unchanged: 0, dropped: 0, incomplete: 0, last_scan: new Date().toISOString() })
      const window = resolveWindow(ctx)
      if (ctx.sweep && policy.onJoin === false) window.sinceMs = Math.max(window.sinceMs ?? 0, floor)
      const present = new Set()
      try {
        admission.refresh(true)
        const stores = await discoverStores(opts.env ?? ctx.env, opts.config ?? {})
        health.stores = stores.length
        if (!stores.length) {
          health.incomplete++
          yield { type: 'event', event: 'copilot.recovery.incomplete', attributes: { error_kind: 'database_missing' } }
        }
        let bytes = 0
        let remaining = 16384
        let remainingParts = 8192
        for (const store of stores) {
          if (remaining <= 0) {
            health.incomplete++
            yield { type: 'event', event: 'copilot.recovery.incomplete', attributes: { error_kind: 'run_span_count_limit' } }
            break
          }
          ownership.begin()
          if (ctx.signal?.aborted) return
          let db
          try {
            db = openDatabase(store.file)
            const generation = (await fingerprint(store.file)).split(':').slice(0, 2).join(':')
            const spans = retainedSpans(db, remaining)
            remaining -= spans.length
            const sessions = new Map()
            for (const span of spans) {
              if (ctx.signal?.aborted) return
              if (!['invoke_agent', 'chat', 'execute_tool'].includes(span.operation_name ?? '') || !(span.end_time_ms >= span.start_time_ms) || span.end_time_ms <= 0) continue
              if ((window.sinceMs !== undefined && span.start_time_ms < window.sinceMs) || (window.untilMs !== undefined && span.start_time_ms > window.untilMs)) continue
              const id = span.chat_session_id || span.conversation_id
              if (!id) {
                health.incomplete++
                continue
              }
              health.selected++
              let cwd = sessions.get(id)
              if (!sessions.has(id)) {
                if (sessions.size >= 128) throw new Error('session_count_limit')
                try { cwd = await ownership.resolve(store, id, db) }
                catch (err) {
                  health.incomplete++
                  yield { type: 'event', event: 'copilot.recovery.incomplete', attributes: { error_kind: safeKind(err) } }
                  cwd = undefined
                }
                sessions.set(id, cwd)
              }
              if (!cwd || !await admission.allowed(id, cwd)) {
                health.dropped++
                continue
              }
              const key = store.file + ':' + span.trace_id + ':' + span.span_id
              present.add(key)
              // Scan retained identities on every pass, payloads only for new
              // terminal rows. Periodically reconcile payloads too, so VACUUM
              // and same-identity replacements cannot strand a checkpoint.
              const signature = [generation, JSON.stringify(span), cwd].join(':')
              if (ctx.sweep && !ctx.dryRun && seen.get(key) === signature) {
                health.unchanged++
                continue
              }
              try {
                const attrs = readAttributes(db, span)
                bytes += Object.values(attrs).reduce((n, value) => n + Buffer.byteLength(value), 0)
                if (bytes > 32 * 1024 * 1024) throw new Error('run_content_limit')
                health.read++
                const exchange = projectSpan(span, attrs, id, cwd, store.harness)
                if (!exchange.messages.length) {
                  health.incomplete++
                  yield { type: 'event', event: 'copilot.recovery.incomplete', attributes: { error_kind: 'content_unavailable' } }
                  continue
                }
                const filtered = await admission.filter(exchange)
                if (!filtered) {
                  health.dropped++
                  continue
                }
                const complete = filtered.messages.length === exchange.messages.length
                const failed = ctx.itemsFailed ?? 0
                const parts = filtered.messages.reduce((count, message) => count + (Array.isArray(message.content) ? message.content.length : 1), 0)
                if (parts > remainingParts) throw new Error('run_part_count_limit')
                remainingParts -= parts
                if (filtered.messages.length) {
                  const item = projectedExchangeItem(filtered, { client_name: 'copilot', native_id: id, source_path: store.file })
                  item.kind = COPILOT_KIND
                  writeGuards.set(item, async () => {
                    if (ctx.signal?.aborted || !await ownership.recheck(store, id, db, cwd)) return false
                    const checked = await admission.filter(filtered)
                    return checked?.messages.length === filtered.messages.length
                  })
                  yield item
                }
                if (ctx.sweep && !ctx.dryRun && complete && (ctx.itemsFailed ?? 0) === failed && !ctx.signal?.aborted) {
                  if (seen.size >= 16384) seen.delete(seen.keys().next().value)
                  seen.set(key, signature)
                }
                if (health.read % 32 === 0) await setImmediate()
              } catch (err) {
                health.incomplete++
                yield { type: 'event', event: 'copilot.recovery.incomplete', attributes: { error_kind: safeKind(err) } }
                if (['run_content_limit', 'run_part_count_limit'].includes(safeKind(err))) {
                  remaining = 0
                  break
                }
              }
            }
          } catch (err) {
            if (safeKind(err) === 'span_count_limit' || safeKind(err) === 'run_content_limit') remaining = 0
            health.incomplete++
            ctx.log.warn('copilot.recovery.incomplete', { component: 'plugin.copilot', operation: 'recovery.read', status: 'incomplete', error_kind: safeKind(err) })
            yield { type: 'event', event: 'copilot.recovery.incomplete', attributes: { error_kind: safeKind(err) } }
          } finally { db?.close() }
        }
        for (const key of seen.keys()) if (!present.has(key)) seen.delete(key)
      } catch (err) {
        health.incomplete++
        yield { type: 'event', event: 'copilot.recovery.incomplete', attributes: { error_kind: safeKind(err) } }
      } finally {
        running = false
        ctx.log.info('copilot.recovery.scan', { component: 'plugin.copilot', operation: 'recovery.scan', status: health.incomplete ? 'incomplete' : 'ok', ...health })
      }
    },
  }
}

/** @param {unknown} err */
function safeKind(err) {
  const value = err instanceof Error ? err.message : ''
  return /^[a-z_]+$/.test(value) ? value : 'native_read_failed'
}
