// @ts-check


import {
  AI_GATEWAY_MESSAGES_DATASET,
  PROJECTED_EXCHANGE_KIND,
  projectedExchangeItem,
  resolveWindow,
} from '../../../../src/core/backfill/scan_util.js'
import { readBackfillPolicy } from '../../../../src/core/config/backfill_policy.js'
import { refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/matcher.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/local_only.js'
import { DEFAULT_ANTIGRAVITY_CLI_SUBDIR, resolveAntigravityAppDataDir } from './config.js'
import { deriveRepoFromCwd } from './git_repo.js'
import { projectAntigravityConversation } from './projector.js'
import { listAntigravityConversations, statConversationTranscript } from './summaries_db.js'

/**
 * @import {
 *   AiGatewayProjectedExchange,
 *   BackfillContribution,
 *   BackfillItem,
 *   BackfillRunContext,
 *   JsonObject,
 *   PluginPaths,
 * } from '../../../../hypaware-plugin-kernel-types.js'
 * @import {
 *   AntigravitySummariesOptions,
 *   AntigravityTranscriptFingerprint,
 *   AntigravityVariantOptions,
 * } from './types.js'
 */

export const ANTIGRAVITY_BACKFILL_TARGET = PROJECTED_EXCHANGE_KIND

const DEFAULT_VARIANT = /** @type {AntigravityVariantOptions} */ ({
  pluginName: '@hypaware/antigravity',
  clientName: 'antigravity',
  configSectionName: 'antigravity',
  defaultAppDataSubdir: DEFAULT_ANTIGRAVITY_CLI_SUBDIR,
  entrypoint: 'cli',
  excludeCliSyncedSummaries: false,
})

/**
 * Build the backfill provider contribution for `@hypaware/antigravity` or
 * `@hypaware/antigravity-desktop`.
 *
 * @param {AntigravitySummariesOptions & {
 *   variant?: Partial<AntigravityVariantOptions>,
 *   config?: Record<string, unknown> | null,
 *   paths?: PluginPaths,
 *   deriveRepo?: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   localOnlyListPath?: string,
 *   ignoredSessions?: Set<string>,
 * }} [opts]
 * @returns {BackfillContribution & {
 *   target: string,
 *   collect: (collectCtx: {
 *     config?: Record<string, unknown> | null,
 *     env?: NodeJS.ProcessEnv,
 *     homeDir?: string,
 *     since?: string,
 *     until?: string,
 *     retentionDays?: number,
 *     sweep?: boolean,
 *     signal?: AbortSignal,
 *     paths?: PluginPaths,
 *   }) => AsyncGenerator<AiGatewayProjectedExchange>,
 * }}
 */
export function createAntigravityBackfillProvider(opts = {}) {
  const variant = { ...DEFAULT_VARIANT, ...(opts.variant ?? {}) }
  const deriveRepo = opts.deriveRepo ?? deriveRepoFromCwd
  /** @type {Map<string, Map<string, AntigravityTranscriptFingerprint>>} */
  const sweepFingerprintsByDir = new Map()

  /**
   * @param {{
   *   config?: Record<string, unknown> | null,
   *   env?: NodeJS.ProcessEnv,
   *   homeDir?: string,
   *   since?: string,
   *   until?: string,
   *   retentionDays?: number,
   *   sweep?: boolean,
   *   signal?: AbortSignal,
   *   paths?: PluginPaths,
   * }} collectCtx
   * @returns {AsyncGenerator<{ item: AiGatewayProjectedExchange, transcriptPath: string }>}
   */
  async function* collectExchanges(collectCtx) {
    const effectiveConfig = collectCtx.config ?? opts.config ?? null
    const appDataDir = resolveAntigravityAppDataDir({
      config: effectiveConfig,
      env: collectCtx.env,
      ...(collectCtx.homeDir !== undefined ? { homeDir: collectCtx.homeDir } : {}),
      defaultAppDataSubdir: variant.defaultAppDataSubdir,
    })

    const listed = await listAntigravityConversations(appDataDir, {
      ...opts,
      excludeCliSyncedSummaries: variant.excludeCliSyncedSummaries,
    })
    if (!listed.available) return

    // The local-only list sits under the kernel state root, not this plugin's
    // own state dir, which is where `hyp usage local-only` writes it.
    const resolver = createUsagePolicyResolver({
      localOnlyListPath: opts.localOnlyListPath
        ?? localOnlyListPath(readObservabilityEnv(collectCtx.env ?? process.env).stateDir),
    })
    // @ref LLP 0403#storage [implements]: honor `hyp session ignore` markers, fail closed when unreadable
    const ignoredSessions = opts.ignoredSessions ?? new Set()
    refreshSessionIgnores(ignoredSessions)
    if (sessionIgnoreLoadError(ignoredSessions)) throw new Error('Antigravity session exclusions are unreadable')
    /** @type {Map<string, Promise<{ git_remote?: string, repo_root?: string }>>} */
    const repoCache = new Map()

    const window = resolveWindow(/** @type {any} */ ({
      since: collectCtx.since,
      until: collectCtx.until,
      retentionDays: collectCtx.retentionDays,
    }))
    const isScheduledSweep = collectCtx.sweep === true

    /** @type {Map<string, AntigravityTranscriptFingerprint> | undefined} */
    let dirFingerprints
    if (isScheduledSweep) {
      dirFingerprints = sweepFingerprintsByDir.get(appDataDir)
      if (!dirFingerprints) {
        dirFingerprints = new Map()
        sweepFingerprintsByDir.set(appDataDir, dirFingerprints)
      }
      const liveIds = new Set(listed.summaries.map((s) => s.conversation_id))
      for (const cachedId of dirFingerprints.keys()) {
        if (!liveIds.has(cachedId)) dirFingerprints.delete(cachedId)
      }
    }

    for (const summary of listed.summaries) {
      if (collectCtx.signal?.aborted) return

      const located = await statConversationTranscript(appDataDir, summary.conversation_id)
      if (!located) continue

      if (window.sinceMs !== undefined || window.untilMs !== undefined) {
        const activityMs = resolveConversationActivityMs(summary, located.stat.mtimeMs)
        if (activityMs !== null) {
          if (window.sinceMs !== undefined && activityMs < window.sinceMs) continue
          if (window.untilMs !== undefined && activityMs > window.untilMs) continue
        }
      }

      const fingerprint = {
        ino: Number(located.stat.ino ?? 0),
        size: Number(located.stat.size ?? 0),
        mtimeMs: Number(located.stat.mtimeMs ?? 0),
        stepCount: summary.step_count,
      }

      if (dirFingerprints) {
        const prev = dirFingerprints.get(summary.conversation_id)
        if (
          prev
          && prev.ino === fingerprint.ino
          && prev.size === fingerprint.size
          && prev.mtimeMs === fingerprint.mtimeMs
          && prev.stepCount === fingerprint.stepCount
        ) {
          continue
        }
      }

      const projected = await projectAntigravityConversation({
        summary,
        transcriptPath: located.transcriptPath,
        clientName: variant.clientName,
        entrypoint: variant.entrypoint,
        resolver,
        ignoredSessions,
        deriveRepo,
        repoCache,
      })

      if (projected.item) {
        if (dirFingerprints) {
          dirFingerprints.set(summary.conversation_id, fingerprint)
        }
        yield { item: projected.item, transcriptPath: located.transcriptPath }
      } else if (
        dirFingerprints
        && (projected.skipped === 'hypignore' || projected.skipped === 'ignored_session' || projected.skipped === 'empty')
      ) {
        dirFingerprints.set(summary.conversation_id, fingerprint)
      }
    }
  }

  const policy = readBackfillPolicy({ name: variant.pluginName, config: /** @type {JsonObject | undefined} */ (opts.config ?? undefined) })
  const configuredCron = /** @type {{ backfill?: { sweep_cron?: unknown } } | null | undefined} */ (opts.config)?.backfill?.sweep_cron
  // `backfill.sweep_cron` sets the scheduled sweep cadence and `on_join: false` turns the sweep off.
  const sweepCron = typeof configuredCron === 'string' ? configuredCron : '*/5 * * * *'
  return {
    name: variant.clientName,
    plugin: variant.pluginName,
    target: ANTIGRAVITY_BACKFILL_TARGET,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: `Import ${variant.clientName} conversations from ${variant.defaultAppDataSubdir} SQLite summaries and JSONL transcripts`,
    ...(policy.onJoin !== false ? { sweep: { cron: sweepCron } } : {}),

    async *collect(collectCtx) {
      for await (const { item } of collectExchanges(collectCtx)) {
        yield item
      }
    },

    /**
     * @param {BackfillRunContext} runCtx
     * @returns {AsyncGenerator<BackfillItem>}
     */
    async *run(runCtx) {
      for await (const { item, transcriptPath } of collectExchanges({
        config: opts.config ?? null,
        env: runCtx.env,
        since: runCtx.since,
        until: runCtx.until,
        retentionDays: runCtx.retentionDays,
        sweep: runCtx.sweep,
        signal: runCtx.signal,
        paths: opts.paths,
      })) {
        yield projectedExchangeItem(item, {
          client_name: variant.clientName,
          native_id: item.session_id,
          source_path: transcriptPath,
        })
      }
    },
  }
}

/**
 * @param {{ last_modified_time: string | null, last_user_input_time: string | null }} summary
 * @param {number} fallbackMtimeMs
 * @returns {number | null}
 */
function resolveConversationActivityMs(summary, fallbackMtimeMs) {
  for (const candidate of [summary.last_modified_time, summary.last_user_input_time]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      const ms = Date.parse(candidate)
      if (Number.isFinite(ms)) return ms
    }
  }
  return Number.isFinite(fallbackMtimeMs) ? fallbackMtimeMs : null
}
