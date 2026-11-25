// @ts-check

import { executeQuerySql } from './sql.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 */

/**
 * Every folder the cache holds chat rows for, for the folder-ask switch
 * (LLP 0623) and its one-time upgrade step (LLP 0626). An install that has
 * never recorded a chat has no such dataset and so no folders: that is an
 * answer, not a failure. Any other failure throws, because a caller must not
 * turn the ask on over a list it could not read.
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
  if (!ctx.query?.getDataset('ai_gateway_messages')) return []
  const out = await executeQuerySql({
    query: 'SELECT cwd FROM ai_gateway_messages GROUP BY cwd',
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
