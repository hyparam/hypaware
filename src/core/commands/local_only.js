// @ts-check

import { executeQuerySql } from '../query/sql.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { CapturedDirectory } from '../../../src/core/commands/types.js'
 */

// Printed by an enrolling login to keep the durable CLI floor discoverable
// after the in-login picker's retirement (LLP 0102): the review window plus
// the hypaware-privacy skill are the enrollment-time refinement now, and this
// command is the client-independent way to withhold a directory at any time.
export const DURABLE_HINT = "tip: mark a directory local-only anytime with 'hyp ignore --local-only [path]'\n"

// The dataset the captured-directory enumeration reads. Exported so the
// hypaware-privacy skill's survey (LLP 0069 #enumerate, LLP 0100 §skill) and
// any future caller can name it without the string drifting from the SQL.
export const CAPTURE_DATASET = 'ai_gateway_messages'

const ENUMERATE_SQL = `SELECT cwd, repo_root, COUNT(*) AS rows, MAX(date) AS last_seen ` +
  `FROM ${CAPTURE_DATASET} WHERE cwd IS NOT NULL GROUP BY cwd, repo_root ORDER BY last_seen DESC`

/**
 * Enumerate the distinct working directories the user has captured
 * Claude/Codex exchanges in, read from this machine's local cache only
 * (R2 — never contacts the remote). One `executeQuerySql` call
 * (`refresh: 'never'`, so enumeration never triggers a partition
 * refresh/backfill of its own); results are collapsed to one candidate per
 * distinct `cwd` (a `cwd` seen under several `repo_root`s keeps the
 * most-recently-active group, since the query is already ordered
 * `last_seen DESC`).
 *
 * Best-effort: any failure (dataset not registered, engine error) resolves
 * to `null` rather than throwing. Survives the picker's retirement (LLP 0102)
 * as the substrate the hypaware-privacy skill's survey drives.
 *
 * @ref LLP 0069#enumerate [implements]: distinct captured cwds, local-cache-only, best-effort
 * @param {{ query: CommandRunContext['query'], storage: CommandRunContext['storage'], config?: CommandRunContext['config'] }} args
 * @returns {Promise<CapturedDirectory[] | null>}
 */
export async function listCapturedDirectories({ query, storage, config }) {
  try {
    const out = await executeQuerySql({
      query: ENUMERATE_SQL,
      registry: query,
      storage: /** @type {ExtendedQueryStorageService} */ (storage),
      refresh: 'never',
      config,
    })
    return collapseByCwd(out.rows ?? [])
  } catch {
    return null
  }
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {CapturedDirectory[]}
 */
function collapseByCwd(rows) {
  /** @type {Map<string, CapturedDirectory>} */
  const byCwd = new Map()
  for (const row of rows) {
    const cwd = row.cwd == null ? '' : String(row.cwd)
    if (cwd === '') continue
    // Rows arrive ordered by last_seen DESC, so the first (cwd, repo_root)
    // group encountered for a given cwd is already its most-recent one; a
    // cwd seen under a second, older repo_root is intentionally dropped
    // rather than merged (LLP 0080 #enumerate).
    if (byCwd.has(cwd)) continue
    const rowsCount = Number(row.rows)
    byCwd.set(cwd, {
      cwd,
      repoRoot: row.repo_root == null ? null : String(row.repo_root),
      rows: Number.isFinite(rowsCount) ? rowsCount : 0,
      lastSeen: row.last_seen == null ? null : String(row.last_seen),
    })
  }
  return [...byCwd.values()]
}
