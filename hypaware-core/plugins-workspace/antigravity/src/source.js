// @ts-check

import { randomUUID } from 'node:crypto'

import {
  AI_GATEWAY_MESSAGES_DATASET,
  PROJECTED_EXCHANGE_KIND,
  projectedExchangeItem,
} from '../../../../src/core/backfill/scan_util.js'
import { refreshSessionIgnores } from '../../../../src/core/control/session_ignore_store.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/matcher.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/local_only.js'
import {
  DEFAULT_ANTIGRAVITY_CLI_SUBDIR,
  parsePollIntervalMs,
  resolveAntigravityAppDataDir,
} from './config.js'
import { deriveRepoFromCwd } from './git_repo.js'
import { projectAntigravityConversation } from './projector.js'
import { listAntigravityConversations, statConversationTranscript } from './summaries_db.js'
import { loadWatermarkState, saveWatermarkState } from './watermark.js'

/**
 * @import {
 *   AiGatewayProjectedExchange,
 *   JsonObject,
 *   PluginActivationContext,
 *   SourceStatus,
 *   StartedSource,
 * } from '../../../../hypaware-plugin-kernel-types.js'
 * @import {
 *   AntigravitySummariesOptions,
 *   AntigravityVariantOptions,
 *   AntigravityWatermarkState,
 * } from './types.js'
 */

const DEFAULT_VARIANT = /** @type {AntigravityVariantOptions} */ ({
  pluginName: '@hypaware/antigravity',
  clientName: 'antigravity',
  configSectionName: 'antigravity',
  defaultAppDataSubdir: DEFAULT_ANTIGRAVITY_CLI_SUBDIR,
  entrypoint: 'cli',
  excludeCliSyncedSummaries: false,
})

/**
 * Start the Antigravity poll source for `@hypaware/antigravity` or
 * `@hypaware/antigravity-desktop`.
 *
 * @param {PluginActivationContext} ctx
 * @param {AntigravitySummariesOptions & {
 *   variant?: Partial<AntigravityVariantOptions>,
 *   localOnlyListPath?: string,
 *   ignoredSessions?: Set<string>,
 *   deriveRepo?: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval,
 * }} [opts]
 * @returns {Promise<StartedSource>}
 */
export async function startAntigravitySource(ctx, opts = {}) {
  const variant = { ...DEFAULT_VARIANT, ...(opts.variant ?? {}) }
  const deriveRepo = opts.deriveRepo ?? deriveRepoFromCwd
  const setIntervalFn = opts.setIntervalFn ?? setInterval
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval

  let currentConfig = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  let enabled = currentConfig.enabled !== false
  let appDataDir = resolveAntigravityAppDataDir({
    config: currentConfig,
    env: ctx.env,
    defaultAppDataSubdir: variant.defaultAppDataSubdir,
  })
  let pollIntervalMs = parsePollIntervalMs(currentConfig.poll_interval)

  // The local-only list lives under the kernel state root, not under this
  // plugin's scoped state dir (`<root>/plugins/@hypaware/<name>`).
  const localPolicyPath = opts.localOnlyListPath ?? localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)
  let resolver = createUsagePolicyResolver({ localOnlyListPath: localPolicyPath })
  /** @type {Set<string>} */
  const ignoredSessions = opts.ignoredSessions ?? new Set()

  /** @type {AntigravityWatermarkState} */
  let watermarks = await loadWatermarkState(ctx.paths.stateDir, appDataDir)

  let stopped = false
  let tickInFlight = /** @type {Promise<void> | null} */ (null)
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null

  let lastState = /** @type {'ready' | 'degraded' | 'stopped'} */ ('ready')
  let lastMessage = /** @type {string | undefined} */ (undefined)
  let pollsCompleted = 0
  let sessionsProjected = 0
  let rowsMaterialized = 0

  /**
   * Execute one poll pass against `appDataDir`.
   */
  async function runTick() {
    if (stopped || !enabled) return

    // Everything a tick awaits stays inside this try: the interval callback
    // does not catch, and an unhandled rejection would end the daemon.
    try {
      // @ref LLP 0403#storage [implements]: reload saved session opt-outs once
      // per poll; a store that cannot load throws here and the tick captures nothing
      refreshSessionIgnores(ignoredSessions)

      const listed = await listAntigravityConversations(appDataDir, {
        ...opts,
        excludeCliSyncedSummaries: variant.excludeCliSyncedSummaries,
      })

      if (!listed.available) {
        if (listed.reason === 'no_node_sqlite') {
          lastState = 'degraded'
          lastMessage = 'node:sqlite builtin is unavailable on this Node runtime'
        } else {
          lastState = 'ready'
          lastMessage = `waiting for ${appDataDir}`
        }
        pollsCompleted += 1
        return
      }

      const tickDevRunId = randomUUID()
      /** @type {AntigravityWatermarkState} */
      const nextWatermarks = {}
      /** @type {Map<string, Promise<{ git_remote?: string, repo_root?: string }>>} */
      const repoCache = new Map()
      let watermarksChanged = false

      for (const summary of listed.summaries) {
        if (stopped) return
        const convId = summary.conversation_id
        const located = await statConversationTranscript(appDataDir, convId)
        if (!located) continue

        const size = Number(located.stat.size ?? 0)
        const mtimeMs = Number(located.stat.mtimeMs ?? 0)
        const stepCount = summary.step_count
        const prev = watermarks[convId]

        if (
          prev
          && prev.size === size
          && prev.mtime_ms === mtimeMs
          && prev.step_count === stepCount
        ) {
          nextWatermarks[convId] = prev
          continue
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

        // Materialize as each conversation projects, so a first tick over a
        // long history holds one transcript's rows at a time, not all of them.
        if (projected.item) {
          await emitExchange(projected.item, located.transcriptPath, tickDevRunId)
        }
        nextWatermarks[convId] = {
          size,
          mtime_ms: mtimeMs,
          step_count: stepCount,
        }
        watermarksChanged = true
      }

      if (!watermarksChanged && Object.keys(watermarks).length !== Object.keys(nextWatermarks).length) {
        watermarksChanged = true
      }

      if (watermarksChanged) {
        watermarks = nextWatermarks
        await saveWatermarkState(ctx.paths.stateDir, appDataDir, watermarks)
      }

      lastState = 'ready'
      lastMessage = undefined
      pollsCompleted += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastState = 'degraded'
      lastMessage = msg
      ctx.log.warn(`${variant.clientName}.source.poll_error`, {
        app_data_dir: appDataDir,
        error: msg,
      })
    }
  }

  /**
   * Materialize one projected conversation and append its rows.
   *
   * @param {AiGatewayProjectedExchange} item
   * @param {string} transcriptPath
   * @param {string} devRunId
   */
  async function emitExchange(item, transcriptPath, devRunId) {
    const materializer = ctx.backfillMaterializers.get(PROJECTED_EXCHANGE_KIND)
    if (!materializer) {
      throw new Error(`missing backfill materializer '${PROJECTED_EXCHANGE_KIND}'`)
    }
    const dataset = ctx.query.getDataset?.(AI_GATEWAY_MESSAGES_DATASET)
    if (!dataset) {
      throw new Error(`dataset '${AI_GATEWAY_MESSAGES_DATASET}' is not registered`)
    }
    const envelope = projectedExchangeItem(item, {
      client_name: variant.clientName,
      native_id: item.session_id,
      source_path: transcriptPath,
    })
    const rows = await materializer.materialize(envelope, {
      env: ctx.env,
      log: ctx.log,
      storage: ctx.storage,
      devRunId,
    })
    if (Array.isArray(rows) && rows.length > 0) {
      await ctx.storage.appendRowsToPartition(
        AI_GATEWAY_MESSAGES_DATASET,
        [variant.clientName],
        dataset.schema?.columns ?? [],
        rows
      )
      rowsMaterialized += rows.length
    }
    sessionsProjected += 1
  }

  function scheduleLoop() {
    if (timer !== null) {
      clearIntervalFn(timer)
      timer = null
    }
    if (stopped || !enabled) return
    timer = setIntervalFn(() => {
      if (tickInFlight || stopped || !enabled) return
      tickInFlight = runTick().finally(() => {
        tickInFlight = null
      })
    }, pollIntervalMs)
    if (timer && typeof (/** @type {any} */ (timer)).unref === 'function') {
      /** @type {any} */ (timer).unref()
    }
  }

  if (enabled) {
    tickInFlight = runTick().finally(() => {
      tickInFlight = null
    })
    scheduleLoop()
  } else {
    lastState = 'stopped'
    lastMessage = `disabled via ${variant.configSectionName}.enabled=false`
  }

  return {
    /**
     * @returns {Promise<SourceStatus>}
     */
    async status() {
      return {
        state: stopped ? 'stopped' : lastState,
        rowsWritten: rowsMaterialized,
        ...(lastMessage !== undefined ? { message: lastMessage } : {}),
        details: {
          app_data_dir: appDataDir,
          poll_interval_ms: pollIntervalMs,
          polls_completed: pollsCompleted,
          sessions_projected: sessionsProjected,
          rows_materialized: rowsMaterialized,
          watermarked_sessions: Object.keys(watermarks).length,
        },
      }
    },

    /**
     * @param {PluginActivationContext | JsonObject} nextCtxOrConfig
     */
    async reload(nextCtxOrConfig) {
      if (tickInFlight) {
        await tickInFlight
      }
      const rawConfig = nextCtxOrConfig
        && typeof nextCtxOrConfig === 'object'
        && 'plugin' in nextCtxOrConfig
        && 'paths' in nextCtxOrConfig
        ? nextCtxOrConfig.config
        : nextCtxOrConfig
      currentConfig = /** @type {Record<string, unknown>} */ (rawConfig ?? {})
      enabled = currentConfig.enabled !== false
      const nextAppDataDir = resolveAntigravityAppDataDir({
        config: currentConfig,
        env: ctx.env,
        defaultAppDataSubdir: variant.defaultAppDataSubdir,
      })
      const nextPollMs = parsePollIntervalMs(currentConfig.poll_interval)

      resolver = createUsagePolicyResolver({ localOnlyListPath: localPolicyPath })

      if (nextAppDataDir !== appDataDir) {
        appDataDir = nextAppDataDir
        watermarks = await loadWatermarkState(ctx.paths.stateDir, appDataDir)
      }
      pollIntervalMs = nextPollMs

      if (!enabled) {
        if (timer !== null) {
          clearIntervalFn(timer)
          timer = null
        }
        lastState = 'stopped'
        lastMessage = `disabled via ${variant.configSectionName}.enabled=false`
        return
      }

      lastState = 'ready'
      lastMessage = undefined
      tickInFlight = runTick().finally(() => {
        tickInFlight = null
      })
      await tickInFlight
      scheduleLoop()
    },

    async stop() {
      stopped = true
      if (timer !== null) {
        clearIntervalFn(timer)
        timer = null
      }
      if (tickInFlight) {
        await tickInFlight
      }
      lastState = 'stopped'
    },
  }
}
