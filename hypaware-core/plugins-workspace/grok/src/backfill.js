// @ts-check

import fs from 'node:fs/promises'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { readBackfillPolicy } from '../../../../src/core/config/backfill_policy.js'
import { AI_GATEWAY_MESSAGES_DATASET, projectedExchangeItem, resolveWindow } from '../../../../src/core/backfill/scan_util.js'
import { fingerprint, fingerprintSettled, present } from '../../droid/src/transcript.js'
import { grokSessionFiles, grokSessionsRoot, MAX_FILE_BYTES, readGrokTranscript } from './transcript.js'

/** @import { BackfillContribution, JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { GrokCursor } from '../../../../hypaware-core/plugins-workspace/grok/src/types.js' */

const SCAN_BYTE_BUDGET = 256 * 1024 * 1024

/**
 * @param {{ env?: NodeJS.ProcessEnv, config?: JsonObject, localOnlyListPath?: string, ignoredSessions?: Set<string> }} [opts]
 * @returns {BackfillContribution}
 * @ref LLP 0359#sweep-context: use the runner's bounded effective time window
 * @ref LLP 0585#bounds: success-only cursors, finite discovery and byte budgets
 */
export function createGrokBackfillProvider(opts = {}) {
  /** @type {Map<string, GrokCursor>} */
  const cursors = new Map()
  let nextFile = ''
  const policy = readBackfillPolicy({ name: '@hypaware/grok', config: opts.config })
  const backfill = /** @type {any} */ (opts.config?.backfill)
  return {
    name: 'grok', plugin: '@hypaware/grok', datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import persisted Grok Build conversations',
    ...(policy.onJoin !== false ? { sweep: { cron: backfill?.sweep_cron ?? '*/5 * * * *' } } : {}),
    async *run(ctx) {
      refreshSessionIgnores(opts.ignoredSessions)
      if (sessionIgnoreLoadError(opts.ignoredSessions)) throw new Error('Grok session exclusions are unreadable')
      const resolver = createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath, existsSync: present })
      const root = grokSessionsRoot(opts.env ?? ctx.env)
      const window = resolveWindow(ctx)
      const files = []
      for await (const file of grokSessionFiles(root)) {
        if (ctx.signal?.aborted) return
        files.push(file)
      }
      files.sort()
      const found = new Set(files)
      for (const file of cursors.keys()) if (!found.has(file)) cursors.delete(file)
      const start = ctx.sweep ? Math.max(0, files.findIndex(f => f >= nextFile)) : 0
      let bytes = 0
      let read = 0
      let unchanged = 0
      let failed = 0
      let dropped = 0
      let deferred = false
      for (let i = 0; i < files.length; i++) {
        if (ctx.signal?.aborted) return
        const file = files[(start + i) % files.length]
        nextFile = file
        try {
          let stat
          try { stat = await fs.lstat(file) } catch (error) {
            // A session directory appears before its first update.
            if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue
            throw error
          }
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('file_budget')
          const cursor = ctx.sweep ? cursors.get(file) : undefined
          if (cursor && cursor.offset === stat.size && cursor.fingerprint === fingerprint(stat) && fingerprintSettled(stat)) {
            unchanged++
            continue
          }
          const pending = stat.size - (cursor && cursor.offset <= stat.size ? cursor.offset : 0)
          if (bytes > 0 && bytes + pending > SCAN_BYTE_BUDGET) {
            deferred = true
            break
          }
          bytes += pending
          read++
          const failures = ctx.itemsFailed
          for await (const item of readGrokTranscript(file, { root, cursor, window, signal: ctx.signal,
            allowed: session => !sessionIgnoreLoadError(opts.ignoredSessions) && !opts.ignoredSessions?.has(session.id) && resolver.resolve(session.cwd).class !== 'ignore',
          })) {
            if (item.dropped) dropped++
            if (item.projection) yield projectedExchangeItem(item.projection, { client_name: 'grok', source_path: file, native_id: item.projection.session_id })
            if (item.cursor && !ctx.dryRun && ctx.itemsFailed === failures) cursors.set(file, item.cursor)
          }
        } catch {
          failed++
          ctx.log.warn('grok.backfill.file_failed', { component: 'plugin.grok', operation: 'backfill.read', status: 'failed', error_kind: 'session_unavailable_or_over_budget' })
          yield { type: 'event', event: 'file_failed', attributes: { client_name: 'grok', error_kind: 'session_unavailable_or_over_budget' } }
        }
      }
      if (deferred) yield { type: 'event', event: 'scan_deferred', attributes: { client_name: 'grok', reason: 'scan_byte_budget' } }
      ctx.log.info('grok.backfill.scan', { component: 'plugin.grok', operation: 'backfill.scan', status: failed || deferred ? 'partial' : 'ok', files_read: read, files_unchanged: unchanged, files_failed: failed, policy_drops: dropped, scan_bytes_reserved: bytes, scan_deferred: deferred, cursor_count: cursors.size })
    },
  }
}
