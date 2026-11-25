// @ts-check

import { executeQuerySql } from './sql.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 */

/** The dataset chats are recorded in, with one row per message part and its folder. */
const CHAT_DATASET = 'ai_gateway_messages'

/**
 * Every folder the cache holds chat rows for, for the folder-ask switch
 * (LLP 0623) and its one-time upgrade step (LLP 0626). An install that has
 * never recorded a chat has no folders: that is an answer, not a failure.
 * Any other failure throws, because a caller must not turn the ask on over a
 * list it could not read. That includes the dataset not being registered in
 * this process while the cache holds rows for it (the plugin that owns it is
 * disabled or failed to activate): the rows are there and cannot be listed.
 *
 * Aggregated in the query engine, so what comes back is one row per folder,
 * not one per message. Only folder paths reach the caller, never content, so
 * the LLP 0105 visibility filter is bypassed as it is for the residual count.
 *
 * Lives beside the query engine, not with the CLI commands, because the
 * daemon calls it at start as well.
 *
 * @ref LLP 0623#rule [implements]: "already recorded" is read from the cache, the one record of what was collected
 * @param {Pick<CommandRunContext, 'query' | 'storage'> & { config?: CommandRunContext['config'] }} ctx
 * @returns {Promise<string[]>}
 */
export async function listRecordedFolders(ctx) {
  if (!ctx.query?.getDataset(CHAT_DATASET)) {
    // @ref LLP 0623#fail-closed [implements]: rows that exist but cannot be listed are a failure, not an empty answer
    const stored = await ctx.storage?.discoverCachePartitions?.({ datasets: [CHAT_DATASET] })
    if (stored && stored.length > 0) {
      throw new Error(`cannot list recorded folders: ${CHAT_DATASET} has cached rows but is not registered in this process`)
    }
    return []
  }
  const out = await executeQuerySql({
    query: `SELECT cwd FROM ${CHAT_DATASET} GROUP BY cwd`,
    registry: ctx.query,
    storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
    refresh: 'never',
    config: ctx.config,
    includeLocalOnly: true,
  })
  /** @type {string[]} */
  const folders = []
  for (const row of out.rows ?? []) {
    if (typeof row.cwd === 'string' && row.cwd !== '') folders.push(row.cwd)
  }
  return folders
}
