// @ts-check

/**
 * The `goose` source: reads Goose's own `sessions.db` (LLP 0570). This is
 * the skeleton, which starts and reports its state without reading a row;
 * the poll runner lands with the reader and projector.
 *
 * @import { PluginActivationContext, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 */

import fs from 'node:fs'
import { resolveGooseEnabled, resolveHomeDir, resolvePollIntervalMs, resolveSessionsDbPath } from './config.js'

/**
 * `startGooseSource(ctx)` is the `SourceContribution.start` callback.
 *
 * @param {PluginActivationContext} ctx
 * @returns {Promise<StartedSource>}
 */
export async function startGooseSource(ctx) {
  const sessionsDbPath = resolveSessionsDbPath(ctx, resolveHomeDir(ctx))
  // @ref LLP 0570#config [implements]: the `enabled: false` kill switch is
  // checked in `start`, not `activate()`, because the daemon runtime starts
  // every registered source (issue #348).
  if (!resolveGooseEnabled(ctx.config)) return createDisabledSource(ctx, sessionsDbPath)

  const pollIntervalMs = resolvePollIntervalMs(ctx)
  return {
    async status() {
      // @ref LLP 0570#status [implements]: a missing `sessions.db` is `ready`
      // with zero rows, not an error: most hosts never install Goose.
      const message = fs.existsSync(sessionsDbPath)
        ? `polling ${sessionsDbPath} every ${pollIntervalMs}ms, no sessions yet`
        : 'no goose installation detected'
      return { state: 'ready', message, rowsWritten: 0, details: { sessions_db: sessionsDbPath } }
    },
    async reload() {},
    async stop() {},
  }
}

/**
 * @param {PluginActivationContext} ctx
 * @param {string} sessionsDbPath
 * @returns {StartedSource}
 */
function createDisabledSource(ctx, sessionsDbPath) {
  ctx.log.info('goose.source_disabled', {
    component: 'goose',
    operation: 'goose.start',
    sessions_db: sessionsDbPath,
    detail: 'goose.enabled = false',
  })
  return {
    async status() {
      return {
        state: 'ready',
        message: 'goose ongoing capture disabled (goose.enabled = false)',
        rowsWritten: 0,
        details: { sessions_db: sessionsDbPath, enabled: false },
      }
    },
    async reload() {},
    async stop() {},
  }
}
