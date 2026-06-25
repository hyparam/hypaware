// @ts-check

import { queryNeighbors } from './query.js'
import { PLUGIN_NAME } from './datasets.js'

/**
 * @import { VerbRegistration, VerbRenderControls, VerbRenderResult } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
 * @import { Direction, TraversalOk, TraversalErr } from './types.d.ts'
 */

/** A graph this large strained the basic in-memory loader; nudge to the index path. */
const LARGE_GRAPH = 500_000

/**
 * `graph neighbors` as a verb: one declaration projecting the CLI command
 * **and** the `graph_neighbors` MCP tool. The traversal core
 * (`queryNeighbors`, LLP 0026) is already pure; this is the thin glue the
 * kernel owns once. Read-class — a query-scoped MCP client may call it.
 *
 * @type {VerbRegistration}
 * @ref LLP 0034#verbs [implements] — context-graph registers a verb; `graph_neighbors` becomes a tool with zero core change
 */
export const graphNeighborsVerb = {
  name: 'graph neighbors',
  tool: 'graph_neighbors',
  plugin: PLUGIN_NAME,
  summary: 'Walk the activity graph from a node out to N hops',
  authClass: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      node: { type: 'string', description: 'Seed node: node_id, natural_key, or label.' },
      depth: { type: 'integer', description: 'Hops to walk (default 1).', default: 1, minimum: 1 },
      type: { type: 'string', description: 'Restrict the seed to this node_type.' },
      edge_type: { type: 'array', items: { type: 'string' }, description: 'Restrict traversal to these edge types.' },
      direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Edge direction to follow (default both).', default: 'both' },
      limit: { type: 'integer', description: 'Max neighbors to return (default 100).', default: 100, minimum: 1 },
    },
    required: ['node'],
    positional: ['node'],
  },
  async operation(params, ctx) {
    const result = await queryNeighbors({
      query: ctx.query,
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      config: ctx.config,
      seed: String(params.node),
      depth: /** @type {number} */ (params.depth),
      type: /** @type {string | undefined} */ (params.type),
      edgeTypes: /** @type {string[] | undefined} */ (params.edge_type),
      direction: /** @type {Direction} */ (params.direction),
      limit: /** @type {number} */ (params.limit),
    })
    // Carry the query context onto a successful result so the renderer (and
    // an MCP consumer) can describe the walk without re-reading the params.
    return result.ok
      ? { ...result, depth: params.depth, direction: params.direction }
      : result
  },
  render(result, controls) {
    const r = /** @type {(TraversalOk & { depth: number, direction: Direction }) | TraversalErr} */ (result)
    if (!r.ok) {
      const lines = [`hyp graph neighbors: ${r.error}`]
      for (const c of (r.candidates ?? []).slice(0, 10)) {
        lines.push(`  ${c.node_type}\t${c.natural_key}\t(${shortId(c.node_id)})`)
      }
      return { stdout: '', stderr: lines.join('\n') + '\n', exitCode: 1 }
    }
    if (controls.json) {
      return { stdout: `${JSON.stringify(r, null, 2)}\n` }
    }
    return renderNeighbors(r)
  },
}

/**
 * Render a successful traversal as a human-readable list, grouped implicitly
 * by BFS order (hop ascending). Truncation and a large-graph memory note are
 * surfaced, never hidden.
 *
 * @param {TraversalOk & { depth: number, direction: Direction }} result
 * @returns {VerbRenderResult}
 * @ref LLP 0026#honest-limits [implements] — flag truncation with the true total; nudge to the index path on a large in-memory load
 */
function renderNeighbors(result) {
  const out = [`graph neighbors: ${display(result.seed)} (${result.seed.node_type}) [${shortId(result.seed.node_id)}]`]
  if (result.neighbors.length === 0) {
    const dir = result.direction === 'both' ? '' : `${result.direction} `
    out.push(`  (no ${dir}neighbors within ${result.depth} hop(s))`)
    return { stdout: out.join('\n') + '\n' }
  }
  // Distinct nodes can share a display label — most often Files with the same
  // basename but different paths, a genuine distinction the graph preserves
  // rather than collapses. Rendered by label alone they look like duplicate
  // rows. Disambiguate only the colliders (≥2 neighbors with one display text)
  // so unique labels stay readable; `--json` already carries `natural_key`.
  // @ref LLP 0026#query-reads-the-published-surface — same-basename Files are genuine distinct nodes, not duplicates to fold
  const labelCounts = new Map()
  for (const n of result.neighbors) {
    const text = display(n.node)
    labelCounts.set(text, (labelCounts.get(text) ?? 0) + 1)
  }
  // A long `natural_key` is tail-truncated, so two colliders that share a long
  // path suffix would still render identically — the same-row bug, surviving for
  // deep paths. Count the disambiguated rows too; any that *still* collide fall
  // back to the unique content-addressed node_id, the same escape `disambiguator`
  // already uses when the key adds nothing.
  const shownCounts = new Map()
  for (const n of result.neighbors) {
    const text = display(n.node)
    if (labelCounts.get(text) > 1) {
      const shown = `${text} (${disambiguator(n.node)})`
      shownCounts.set(shown, (shownCounts.get(shown) ?? 0) + 1)
    }
  }
  for (const n of result.neighbors) {
    const arrow = n.direction === 'out' ? `-${n.edge_type}→` : `←${n.edge_type}-`
    const text = display(n.node)
    let shown = text
    if (labelCounts.get(text) > 1) {
      shown = `${text} (${disambiguator(n.node)})`
      if (shownCounts.get(shown) > 1) shown = `${text} (${shortId(n.node.node_id)})`
    }
    out.push(`  ${n.hop}  ${arrow.padEnd(18)} ${n.node.node_type.padEnd(8)} ${shown}`)
  }
  if (result.truncated) {
    out.push(`${result.neighbors.length} of ${result.reachable} neighbor(s) within ${result.depth} hop(s) — truncated; raise --limit`)
  } else {
    out.push(`${result.reachable} neighbor(s) within ${result.depth} hop(s)`)
  }
  /** @type {string | undefined} */
  let stderr
  if (result.totalNodes + result.totalEdges >= LARGE_GRAPH) {
    stderr = `hyp graph neighbors: loaded ${result.totalNodes} node(s) + ${result.totalEdges} edge(s) in memory; at this size consider the persisted index path (LLP 0026 §honest-limits)\n`
  }
  return { stdout: out.join('\n') + '\n', ...(stderr ? { stderr } : {}) }
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
 * A suffix that tells two same-label nodes apart. The `natural_key` is the real
 * distinguisher (a File's full path vs its basename label); keep its tail when
 * long, since the distinguishing part of a path is the end. Fall back to a short
 * node_id when the key adds nothing over the label.
 *
 * @param {{ label: string | null, natural_key: string, node_id: string }} node
 * @returns {string}
 */
function disambiguator(node) {
  const key = node.natural_key
  if (key && key !== node.label) {
    return key.length > 48 ? `…${key.slice(key.length - 47)}` : key
  }
  return shortId(node.node_id)
}

/**
 * @param {string} id
 * @returns {string}
 */
function shortId(id) {
  return id.length > 12 ? id.slice(0, 12) : id
}
