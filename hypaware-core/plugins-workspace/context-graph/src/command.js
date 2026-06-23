// @ts-check

import { compactGraphTables } from './maintenance.js'
import { projectGraph } from './project.js'
import { requireGraphRuntime } from './runtime.js'

/**
 * @import { CommandRunContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
 */

/**
 * `hyp graph project` — run the T0 projection over every registered source
 * contract (optionally filtered to one source with `--source <dataset>`).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runGraphProject(argv, ctx) {
  const parsed = parseProjectArgv(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp graph project: ${parsed.error}\n`)
    return 2
  }
  const { source, dryRun } = parsed
  try {
    const { registry } = requireGraphRuntime()
    const contracts = source
      ? registry.list().filter((c) => c.sourceDataset === source)
      : registry.list()

    if (contracts.length === 0) {
      ctx.stdout.write(
        source
          ? `graph project: no contract registered for source '${source}'\n`
          : 'graph project: no contracts registered — install a source connector (e.g. @hypaware/ai-gateway-graph)\n'
      )
      return 0
    }

    const r = await projectGraph({
      query: ctx.query,
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      contracts,
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
 * Parse `graph project` argv: flags only, no positional. `--source` takes a
 * value (the source dataset to filter to, `--source <ds>` or `--source=<ds>`);
 * `--dry-run` is boolean. A missing, empty, or flag-shaped `--source` value is
 * a usage error — so a malformed targeted
 * command can't silently fall back to projecting *all* contracts, a broader
 * write than was asked for. Unknown flags and stray positionals are rejected
 * for the same reason.
 *
 * @param {string[]} argv
 * @returns {{ ok: true, source: string | undefined, dryRun: boolean } | { ok: false, error: string }}
 */
function parseProjectArgv(argv) {
  /** @type {string | undefined} */
  let source
  let dryRun = false

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') {
      dryRun = true
    } else if (token === '--source') {
      const value = argv[i + 1]
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return { ok: false, error: '--source expects a value' }
      }
      i += 1
      source = value
    } else if (token.startsWith('--source=')) {
      const value = token.slice('--source='.length)
      if (value.length === 0) return { ok: false, error: '--source expects a value' }
      source = value
    } else if (token.startsWith('--')) {
      return { ok: false, error: `unknown flag ${token}` }
    } else {
      return { ok: false, error: `unexpected argument ${token} (graph project takes no positional)` }
    }
  }

  return { ok: true, source, dryRun }
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
