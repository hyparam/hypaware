// @ts-check

import os from 'node:os'
import path from 'node:path'

import {
  AI_GATEWAY_MESSAGES_DATASET,
  PROJECTED_EXCHANGE_KIND,
  projectedExchangeItem,
  resolveWindow,
} from '../../../../src/core/backfill/scan_util.js'
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
 * }} [opts]
 * @returns {BackfillContribution & {
 *   target: string,
 *   plan: (planCtx?: { config?: Record<string, unknown> | null, env?: NodeJS.ProcessEnv, homeDir?: string, paths?: PluginPaths }) => Promise<{
 *     provider: string,
 *     plugin: string,
 *     available: boolean,
 *     reason?: string,
 *     target: string,
 *     estimatedItems?: number,
 *     summary: string,
 *     details?: { app_data_dir: string, sessions: number },
 *   }>,
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

    const effectivePaths = collectCtx.paths ?? opts.paths
    const stateRoot = effectivePaths?.stateDir
      ? path.dirname(effectivePaths.stateDir)
      : path.join(collectCtx.homeDir ?? collectCtx.env?.HOME ?? os.homedir(), '.hyp', 'hypaware')
    const resolver = createUsagePolicyResolver({
      localOnlyListPath: localOnlyListPath(stateRoot),
    })
    /** @type {Set<string>} */
    const ignoredSessions = new Set()
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

  return {
    name: variant.clientName,
    plugin: variant.pluginName,
    target: ANTIGRAVITY_BACKFILL_TARGET,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: `Import ${variant.clientName} conversations from ${variant.defaultAppDataSubdir} SQLite summaries and JSONL transcripts`,
    sweep: { cron: '*/5 * * * *' },

    async plan(planCtx = {}) {
      const appDataDir = resolveAntigravityAppDataDir({
        config: planCtx.config ?? opts.config ?? null,
        env: planCtx.env,
        ...(planCtx.homeDir !== undefined ? { homeDir: planCtx.homeDir } : {}),
        defaultAppDataSubdir: variant.defaultAppDataSubdir,
      })

      const listed = await listAntigravityConversations(appDataDir, {
        ...opts,
        excludeCliSyncedSummaries: variant.excludeCliSyncedSummaries,
      })
      if (!listed.available) {
        const reason = listed.reason === 'no_node_sqlite'
          ? `node:sqlite builtin is unavailable on this Node runtime (cannot read ${appDataDir}/conversation_summaries.db)`
          : `No Antigravity data found at ${appDataDir}`
        return {
          provider: variant.clientName,
          plugin: variant.pluginName,
          available: false,
          reason,
          target: ANTIGRAVITY_BACKFILL_TARGET,
          estimated_items: 0,
          sources: [appDataDir],
          notes: [reason],
          summary: `${variant.clientName}: unavailable (${reason})`,
        }
      }

      let transcriptCount = 0
      for (const summary of listed.summaries) {
        const located = await statConversationTranscript(appDataDir, summary.conversation_id)
        if (located) transcriptCount += 1
      }

      return {
        provider: variant.clientName,
        plugin: variant.pluginName,
        available: true,
        target: ANTIGRAVITY_BACKFILL_TARGET,
        estimated_items: transcriptCount,
        estimatedItems: transcriptCount,
        sources: [appDataDir],
        summary: `${variant.clientName}: ${transcriptCount} conversation(s) in ${appDataDir}`,
        details: {
          app_data_dir: appDataDir,
          sessions: transcriptCount,
        },
      }
    },

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
