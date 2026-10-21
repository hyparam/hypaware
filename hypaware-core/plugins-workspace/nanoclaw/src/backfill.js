// @ts-check
import fs from 'node:fs/promises'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { readBackfillPolicy } from '../../../../src/core/config/backfill_policy.js'
import { AI_GATEWAY_MESSAGES_DATASET, projectedExchangeItem, resolveWindow } from '../../../../src/core/backfill/scan_util.js'
import { validateNanoclawConfig } from './config.js'
import { containedPath, discoverFiles, fingerprint, MAX_FILE_BYTES, MAX_SCAN_BYTES, present, projectTranscript, readGroups, readTranscript } from './transcripts.js'

/** @import { BackfillContribution, BackfillItem, JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { NanoclawHealth } from '../../../../hypaware-core/plugins-workspace/nanoclaw/src/types.js' */

export const NANOCLAW_KIND = 'nanoclaw.projected_exchange'
/** @type {WeakMap<BackfillItem, () => boolean>} */
export const writeGuards = new WeakMap()

/**
 * @param {{ config: JsonObject, localOnlyListPath?: string, ignoredSessions?: Set<string> }} opts
 * @param {NanoclawHealth} health
 * @returns {BackfillContribution}
 * @ref LLP 0553#capture: scheduled native recovery without an inference proxy
 * @ref LLP 0359#sweep-context: inherit the runner's effective retention window
 */
export function createNanoclawBackfillProvider(opts, health) {
  /** @type {Map<string, string>} */
  const fingerprints = new Map()
  let nextFile = ''
  const policy = readBackfillPolicy({ name: '@hypaware/nanoclaw', config: opts.config })
  const backfill = /** @type {any} */ (opts.config.backfill)
  return {
    name: 'nanoclaw', plugin: '@hypaware/nanoclaw', datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import local NanoClaw v2 Claude transcripts',
    ...(policy.onJoin !== false ? { sweep: { cron: backfill?.sweep_cron ?? '*/5 * * * *' } } : {}),
    async *run(ctx) {
      Object.assign(health, { groups: 0, files_read: 0, files_unchanged: 0, files_failed: 0, policy_drops: 0, deferred: false, error_kind: undefined })
      let bytes = 0
      try {
        if (!validateNanoclawConfig(opts.config).ok) throw new Error('Configure @hypaware/nanoclaw with config.root set to the absolute NanoClaw installation directory')
        refreshSessionIgnores(opts.ignoredSessions)
        if (sessionIgnoreLoadError(opts.ignoredSessions)) throw new Error('NanoClaw session exclusions are unreadable')
        if (ctx.isPluginDetached?.('@hypaware/nanoclaw')) return
        const root = await fs.realpath(String(opts.config.root))
        const groups = await readGroups(root)
        health.groups = groups.length
        const files = await discoverFiles(root, groups)
        const found = new Set(files.map(source => source.file))
        for (const file of fingerprints.keys()) if (!found.has(file)) fingerprints.delete(file)
        const start = ctx.sweep ? Math.max(0, files.findIndex(source => source.file >= nextFile)) : 0
        const window = resolveWindow(ctx)
        for (let i = 0; i < files.length; i++) {
          if (ctx.signal?.aborted) return
          const source = files[(start + i) % files.length]
          nextFile = source.file
          try {
            await containedPath(root, source.group.cwd)
            await containedPath(root, source.file)
            const resolver = createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath, existsSync: present })
            if (resolver.resolve(source.group.cwd).class === 'ignore') { health.policy_drops++; continue }
            const stat = await fs.lstat(source.file)
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('file_budget')
            if (ctx.sweep && fingerprints.get(source.file) === fingerprint(stat)) { health.files_unchanged++; continue }
            // Explicit imports must finish: a new CLI process cannot resume
            // this process-local cursor. Both modes keep the per-file bounds.
            if (ctx.sweep && bytes + stat.size > MAX_SCAN_BYTES) { health.deferred = true; break }
            bytes += stat.size
            health.files_read++
            const snapshot = await readTranscript(root, source, ctx.signal, fingerprint(stat))
            const failures = ctx.itemsFailed
            let dropped = false
            for (const [sessionId, entries] of snapshot.sessions) {
              if (ctx.signal?.aborted) return
              const allowed = () => !sessionIgnoreLoadError(opts.ignoredSessions) && !opts.ignoredSessions?.has(sessionId) &&
                !ctx.isPluginDetached?.('@hypaware/nanoclaw') &&
                createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath, existsSync: present }).resolve(source.group.cwd).class !== 'ignore'
              if (!allowed()) { dropped = true; health.policy_drops++; continue }
              const exchange = await projectTranscript(sessionId, entries, source.group, window)
              if (!exchange) continue
              const item = projectedExchangeItem(exchange, { client_name: 'nanoclaw', source_path: source.file, native_id: sessionId })
              item.kind = NANOCLAW_KIND
              writeGuards.set(item, allowed)
              yield item
            }
            if (!snapshot.complete) health.deferred = true
            if (snapshot.complete && !dropped && !ctx.dryRun && !ctx.signal?.aborted && ctx.itemsFailed === failures) fingerprints.set(source.file, snapshot.fingerprint)
          } catch {
            health.files_failed++
            ctx.log.warn('nanoclaw.backfill.file_failed', { component: 'plugin.nanoclaw', operation: 'backfill.read', status: 'failed', error_kind: 'transcript_unavailable_or_over_budget' })
            yield { type: 'event', event: 'file_failed', attributes: { client_name: 'nanoclaw', error_kind: 'transcript_unavailable_or_over_budget' } }
          }
        }
        if (health.deferred) yield { type: 'event', event: 'scan_deferred', attributes: { client_name: 'nanoclaw', reason: 'incomplete_or_budget' } }
        if (health.files_failed || health.deferred) yield { type: 'event', event: 'import_unavailable', attributes: {
          client_name: 'nanoclaw',
          note: `NanoClaw import is partial: ${health.files_failed} file(s) failed; ${health.deferred ? 'unfinished responses or the scan budget deferred some history' : 'check source diagnostics for unavailable or oversized transcripts'}. Recovery will retry.`,
        } }
      } catch {
        health.error_kind = 'catalog_or_config_unavailable'
        throw new Error('NanoClaw capture unavailable: check config.root, the local data/v2.db group catalog, workspace permissions and session exclusions')
      } finally {
        health.last_scan = new Date().toISOString()
        ctx.log.info('nanoclaw.backfill.scan', { component: 'plugin.nanoclaw', operation: 'backfill.scan', status: health.error_kind ? 'failed' : health.files_failed || health.deferred ? 'partial' : 'ok', ...health, scan_bytes_reserved: bytes, fingerprint_count: fingerprints.size })
      }
    },
  }
}
