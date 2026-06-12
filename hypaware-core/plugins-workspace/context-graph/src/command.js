// @ts-check

import { compactGraphTables } from './maintenance.js'
import { projectGraph } from './project.js'

/**
 * @import { CommandRunContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
 */

/**
 * `hyp graph project` — run the T0 projection over `ai_gateway_messages`.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runGraphProject(argv, ctx) {
  const dryRun = argv.includes('--dry-run')
  try {
    const r = await projectGraph({
      query: ctx.query,
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      config: ctx.config,
      dryRun,
    })
    if (dryRun) {
      ctx.stdout.write(`graph project (dry-run): ${r.nodes} node(s), ${r.edges} edge(s) would be projected\n`)
    } else {
      ctx.stdout.write(
        `graph project: ${r.nodes} node(s), ${r.edges} edge(s) — wrote ${r.nodesWritten} new node(s), ${r.edgesWritten} new edge(s)\n`
      )
    }
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp graph project: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/**
 * `hyp graph compact` — merge duplicate node/edge rows and rewrite
 * affected partitions into sorted replacement tables.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runGraphCompact(argv, ctx) {
  const dryRun = argv.includes('--dry-run')
  try {
    const r = await compactGraphTables({
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      dryRun,
    })
    for (const d of r.datasets) {
      if (dryRun) {
        ctx.stdout.write(
          `graph compact (dry-run): ${d.dataset} — ${d.duplicateIds} duplicate id(s) across ${d.partitionsRewritten} partition(s) would be merged\n`
        )
      } else {
        ctx.stdout.write(
          `graph compact: ${d.dataset} — merged ${d.rowsMerged} duplicate row(s) (${d.duplicateIds} id(s)), rewrote ${d.partitionsRewritten} partition(s)\n`
        )
      }
      for (const skip of d.partitionsSkipped) {
        ctx.stderr.write(`hyp graph compact: skipped ${skip.path} (${skip.reason})\n`)
      }
    }
    // A concurrent-write skip is a benign retry-later; an unreadable
    // cursor needs operator attention — exit nonzero so it can't pass
    // silently in scripts.
    const unreadable = r.datasets.some((d) => d.partitionsSkipped.some((s) => s.reason === 'unreadable-cursor'))
    return unreadable ? 1 : 0
  } catch (err) {
    ctx.stderr.write(`hyp graph compact: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}
