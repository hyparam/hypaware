// @ts-check

import fs from 'node:fs/promises'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { readBackfillPolicy } from '../../../../src/core/config/backfill_policy.js'
import { AI_GATEWAY_MESSAGES_DATASET, projectedExchangeItem, resolveWindow } from '../../../../src/core/backfill/scan_util.js'
import { droidSessionsRoot, droidSessionFiles, fingerprint, MAX_FILE_BYTES, readDroidTranscript } from './transcript.js'

/** @import { BackfillContribution, JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */

/**
 * @param {{ env?: NodeJS.ProcessEnv, config?: JsonObject, localOnlyListPath?: string, ignoredSessions?: Set<string> }} [opts]
 * @returns {BackfillContribution}
 * @ref LLP 0359#sweep-context: use the runner's bounded effective time window
 * @ref LLP 0551#bounds: success-only fingerprints, finite discovery and byte budgets
 */
export function createDroidBackfillProvider(opts = {}) {
  const fingerprints = new Map()
  let nextFile = ''
  const policy = readBackfillPolicy({ name: '@hypaware/droid', config: opts.config })
  const backfill = /** @type {any} */ (opts.config?.backfill)
  return {
    name: 'droid', plugin: '@hypaware/droid', datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import persisted Factory Droid conversations',
    ...(policy.onJoin !== false ? { sweep: { cron: backfill?.sweep_cron ?? '*/5 * * * *' } } : {}),
    async *run(ctx) {
      refreshSessionIgnores(opts.ignoredSessions)
      if (sessionIgnoreLoadError(opts.ignoredSessions)) throw new Error('Droid session exclusions are unreadable')
      const resolver = createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
      const root = droidSessionsRoot(opts.env ?? ctx.env)
      const window = resolveWindow(ctx)
      const files = []
      for await (const file of droidSessionFiles(root)) {
        if (ctx.signal?.aborted) return
        files.push(file)
      }
      files.sort()
      const found = new Set(files)
      for (const file of fingerprints.keys()) if (!found.has(file)) fingerprints.delete(file)
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
          const stat = await fs.lstat(file)
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('file_budget')
          // Do not use mtime for the time window: Droid can preserve file
          // times while rewriting metadata. Filter native message timestamps.
          if (ctx.sweep && fingerprints.get(file) === fingerprint(stat)) {
            unchanged++
            continue
          }
          if (bytes + stat.size > 256 * 1024 * 1024) {
            deferred = true
            break
          }
          bytes += stat.size
          read++
          const failures = ctx.itemsFailed
          for await (const item of readDroidTranscript(file, { root, window, signal: ctx.signal,
            allowed: session => !sessionIgnoreLoadError(opts.ignoredSessions) && !opts.ignoredSessions?.has(String(session.id)) && resolver.resolve(String(session.cwd)).class !== 'ignore',
          })) {
            if (item.dropped) dropped++
            if (item.projection) yield projectedExchangeItem(item.projection, { client_name: 'droid', source_path: file, native_id: item.projection.session_id })
            if (item.complete && item.cursor && !ctx.dryRun && ctx.itemsFailed === failures) fingerprints.set(file, item.cursor.fingerprint)
          }
        } catch {
          failed++
          ctx.log.warn('droid.backfill.file_failed', { component: 'plugin.droid', operation: 'backfill.read', status: 'failed', error_kind: 'session_unavailable_or_over_budget' })
          yield { type: 'event', event: 'file_failed', attributes: { client_name: 'droid', error_kind: 'session_unavailable_or_over_budget' } }
        }
      }
      if (deferred) yield { type: 'event', event: 'scan_deferred', attributes: { client_name: 'droid', reason: 'scan_byte_budget' } }
      ctx.log.info('droid.backfill.scan', { component: 'plugin.droid', operation: 'backfill.scan', status: failed || deferred ? 'partial' : 'ok', files_read: read, files_unchanged: unchanged, files_failed: failed, policy_drops: dropped, scan_bytes_reserved: bytes, scan_deferred: deferred, fingerprint_count: fingerprints.size })
    },
  }
}
