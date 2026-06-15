// @ts-check

import { compactGraphTables } from './maintenance.js'
import { projectGraph } from './project.js'
import { queryNeighbors } from './query.js'

/**
 * @import { CommandRunContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
 * @import { Direction, TraversalOk } from './query.js'
 */

/** @typedef {{ seed: string, depth: number, type: string | undefined, edgeTypes: string[], direction: Direction, limit: number, json: boolean }} ParsedNeighbors */

/** A graph this large strained the basic in-memory loader; nudge to the index path. */
const LARGE_GRAPH = 500_000

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

/**
 * `hyp graph neighbors <node>` — walk the activity graph from a seed node out
 * to `--depth` hops over the published `node`/`edge` datasets.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runGraphNeighbors(argv, ctx) {
  const parsed = parseNeighborsArgv(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp graph neighbors: ${parsed.error}\n`)
    return 2
  }
  try {
    const result = await queryNeighbors({
      query: ctx.query,
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      config: ctx.config,
      seed: parsed.seed,
      depth: parsed.depth,
      type: parsed.type,
      edgeTypes: parsed.edgeTypes,
      direction: parsed.direction,
      limit: parsed.limit,
    })
    if (!result.ok) {
      ctx.stderr.write(`hyp graph neighbors: ${result.error}\n`)
      for (const c of (result.candidates ?? []).slice(0, 10)) {
        ctx.stderr.write(`  ${c.node_type}\t${c.natural_key}\t(${shortId(c.node_id)})\n`)
      }
      return 1
    }
    if (parsed.json) {
      ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    }
    renderNeighbors(ctx, result, parsed)
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp graph neighbors: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/**
 * Parse `graph neighbors` argv: one positional `<node>` seed plus flags.
 * Manual loop (the house style — no shared flag parser), value flags consume
 * the next token; unknown flags and a second positional are usage errors.
 *
 * @param {string[]} argv
 * @returns {({ ok: true } & ParsedNeighbors) | { ok: false, error: string }}
 */
function parseNeighborsArgv(argv) {
  /** @type {string[]} */
  const positional = []
  let depth = 1
  /** @type {string | undefined} */
  let type
  /** @type {string[]} */
  const edgeTypes = []
  /** @type {Direction} */
  let direction = 'both'
  let limit = 100
  let json = false

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--json') {
      json = true
    } else if (
      token === '--depth' || token === '--type' || token === '--edge-type' ||
      token === '--direction' || token === '--limit'
    ) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `${token} expects a value` }
      }
      i += 1
      if (token === '--depth' || token === '--limit') {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 1) {
          return { ok: false, error: `${token} expects a positive integer (got ${value})` }
        }
        if (token === '--depth') depth = n
        else limit = n
      } else if (token === '--direction') {
        if (value !== 'out' && value !== 'in' && value !== 'both') {
          return { ok: false, error: `--direction expects out|in|both (got ${value})` }
        }
        direction = value
      } else if (token === '--type') {
        type = value
      } else {
        for (const part of value.split(',')) {
          const p = part.trim()
          if (p) edgeTypes.push(p)
        }
      }
    } else if (token.startsWith('--')) {
      return { ok: false, error: `unknown flag ${token}` }
    } else {
      positional.push(token)
    }
  }

  if (positional.length === 0) {
    return {
      ok: false,
      error: 'usage: hyp graph neighbors <node> [--depth N] [--type T] [--edge-type T] [--direction out|in|both] [--limit N] [--json]',
    }
  }
  if (positional.length > 1) {
    return { ok: false, error: `expected one <node>, got ${positional.length} (quote multi-word values)` }
  }
  return { ok: true, seed: positional[0], depth, type, edgeTypes, direction, limit, json }
}

/**
 * Render a successful traversal as a human-readable list, grouped implicitly by
 * BFS order (hop ascending). Truncation and a large-graph memory note are
 * surfaced, never hidden.
 *
 * @param {CommandRunContext} ctx
 * @param {TraversalOk} result
 * @param {ParsedNeighbors} parsed
 * @ref LLP 0026#honest-limits [implements] — flag truncation with the true total; nudge to the index path on a large in-memory load
 */
function renderNeighbors(ctx, result, parsed) {
  ctx.stdout.write(`graph neighbors: ${display(result.seed)} (${result.seed.node_type}) [${shortId(result.seed.node_id)}]\n`)
  if (result.neighbors.length === 0) {
    const dir = parsed.direction === 'both' ? '' : `${parsed.direction} `
    ctx.stdout.write(`  (no ${dir}neighbors within ${parsed.depth} hop(s))\n`)
    return
  }
  for (const n of result.neighbors) {
    const arrow = n.direction === 'out' ? `-${n.edge_type}→` : `←${n.edge_type}-`
    ctx.stdout.write(`  ${n.hop}  ${arrow.padEnd(18)} ${n.node.node_type.padEnd(8)} ${display(n.node)}\n`)
  }
  if (result.truncated) {
    ctx.stdout.write(`${result.neighbors.length} of ${result.reachable} neighbor(s) within ${parsed.depth} hop(s) — truncated; raise --limit\n`)
  } else {
    ctx.stdout.write(`${result.reachable} neighbor(s) within ${parsed.depth} hop(s)\n`)
  }
  if (result.totalNodes + result.totalEdges >= LARGE_GRAPH) {
    ctx.stderr.write(
      `hyp graph neighbors: loaded ${result.totalNodes} node(s) + ${result.totalEdges} edge(s) in memory; at this size consider the persisted index path (LLP 0026 §honest-limits)\n`
    )
  }
}

/**
 * @param {{ label: string | null, natural_key: string }} node
 * @returns {string}
 */
function display(node) {
  const text = node.label ?? node.natural_key
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

/**
 * @param {string} id
 * @returns {string}
 */
function shortId(id) {
  return id.length > 12 ? id.slice(0, 12) : id
}
