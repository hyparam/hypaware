// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'

import { columnsFor, COMMITTED_DATASET, enrichTablePath, PROSPECTS_DATASET, RESOLUTIONS_DATASET } from './datasets.js'
import { buildCurateBatchRequest, parseDecisions } from './prompts.js'
import { getCompletion, getEmbedder, getVector } from './runtime.js'
import { contentFilterClauses, runSql, sqlQuote } from './sql.js'

/**
 * @import { CurateDecision, EnrichRuntime } from './types.d.ts'
 * @import { CompletionRequest, CompletionResult, VectorSearchHit } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

const CURATOR = 'enrich.t2'
const CURATOR_VERSION = 1
const MAX_SOURCE_CHARS = 8_000

/**
 * Run one **synchronous** T2 curate tick (the `hyp enrich curate` command path).
 * Selects pending prospects, scores them by novelty, clusters by
 * similarity/recall ([§curate-clustering](LLP 0028)), and makes ONE curator
 * call per cluster, blocking on each. The batch regimes (backfill command,
 * ongoing daemon) reuse the same {@link buildCurateClusters} /
 * {@link curateRequestForCluster} / {@link routeClusterDecisions} pieces but
 * submit through the Batch API instead (see batch.js).
 *
 * @ref LLP 0028#curate-clustering [implements]
 *
 * @param {EnrichRuntime} runtime
 * @param {{ deadlineMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ pending: number, processed: number, committed: number, rejected: number, merged: number, skipped: number, calls: number, clusters: number }>}
 */
export async function runCurateTick(runtime, opts = {}) {
  return withSpan(
    'enrich.curate_tick',
    { [Attr.COMPONENT]: 'plugin', [Attr.OPERATION]: 'enrich.curate_tick', [Attr.PLUGIN]: '@hypaware/context-graph-enrich', status: 'ok' },
    async (span) => {
      const pending = await selectPending(runtime)
      const { clusters, skipped, recallByProspect } = await buildCurateClusters(runtime, pending)

      /** @type {Record<string, unknown>[]} */
      const committedRows = []
      /** @type {Record<string, unknown>[]} */
      const resolutionRows = []
      let processed = 0
      let rejected = 0
      let merged = 0
      let calls = 0
      const at = new Date().toISOString()

      for (const cluster of clusters) {
        if (opts.deadlineMs && Date.now() > opts.deadlineMs) break
        const request = await curateRequestForCluster(runtime, cluster, recallByProspect)
        const result = await getCompletion(runtime).complete(request, { signal: opts.signal })
        calls++
        const routed = routeClusterDecisions(cluster, result, at)
        if (routed.noDecisions) {
          // Refusal / no tool call: leave the cluster pending for retry.
          runtime.log.warn('enrich.curate_no_decisions', { cluster_size: cluster.length })
          continue
        }
        committedRows.push(...routed.committedRows)
        resolutionRows.push(...routed.resolutionRows)
        processed += routed.processed
        rejected += routed.rejected
        merged += routed.merged
      }

      // Sub-salience-threshold prospects drain via a terminal `skip` resolution
      // (no curator call). @ref LLP 0028#salience-drain
      resolutionRows.push(...skipResolutionRows(skipped, at))

      await appendCommitted(runtime, committedRows)
      await appendResolutions(runtime, resolutionRows)

      span.setAttribute('pending', pending.length)
      span.setAttribute('clusters', clusters.length)
      span.setAttribute('processed', processed)
      span.setAttribute('committed', committedRows.length)
      span.setAttribute('rejected', rejected)
      span.setAttribute('merged', merged)
      span.setAttribute('skipped', skipped.length)
      span.setAttribute('curate_calls', calls)
      return { pending: pending.length, processed, committed: committedRows.length, rejected, merged, skipped: skipped.length, calls, clusters: clusters.length }
    },
    { component: 'plugin' }
  )
}

/**
 * The pending curate queue: prospects with no resolution row, deduped by id.
 *
 * An optional `anchorKeys` allowlist scopes the queue to prospects anchored to
 * those sessions. This is the lever the bounded `hyp enrich backfill --since`
 * curate uses to keep the cold-backfill pool, and its per-prospect recall +
 * greedy O(n²) clustering ({@link buildCurateClusters}): tractable, *without*
 * mutating the append-only prospect table: out-of-window prospects stay pending
 * for a later, separately-scoped run rather than being deleted or skip-drained.
 *
 * @ref LLP 0028#curate-clustering [constrained-by]
 *
 * @param {EnrichRuntime} runtime
 * @param {{ anchorKeys?: Set<string> }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function selectPending(runtime, opts = {}) {
  const resolvedRows = await runSql(runtime, `SELECT prospect_id FROM ${RESOLUTIONS_DATASET}`, { allowMissing: true })
  const resolved = new Set(resolvedRows.map((r) => strField(r.prospect_id)))
  const allProspects = await runSql(runtime, `SELECT * FROM ${PROSPECTS_DATASET}`, { allowMissing: true })
  const { anchorKeys } = opts
  const pending = allProspects.filter((p) => {
    if (resolved.has(strField(p.prospect_id))) return false
    if (anchorKeys && !anchorKeys.has(strField(p.anchor_key))) return false
    return true
  })
  return dedupeById(pending)
}

/**
 * Score the pending pool by novelty and cluster it. The synchronous tick caps
 * the selection at `max_prospects_per_tick`; the **batch** regimes pass
 * `uncapped` and process the whole eligible pool ([§salience-drain](LLP 0028)).
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[]} pending
 * @param {{ uncapped?: boolean }} [opts]
 * @returns {Promise<{ clusters: Record<string, unknown>[][], skipped: Record<string, unknown>[], recallByProspect: Map<string, VectorSearchHit[]> }>}
 */
export async function buildCurateClusters(runtime, pending, opts = {}) {
  const c = runtime.config.curate
  const { ordered, skipped, recallByProspect } = await scoreAndRecall(runtime, pending)
  const selected = opts.uncapped ? ordered : ordered.slice(0, c.max_prospects_per_tick)
  const clusters = await clusterProspects(runtime, selected, recallByProspect)
  return { clusters, skipped, recallByProspect }
}

/**
 * Build the one curator request for a cluster: per-prospect views + recall, the
 * shared recalled-knowledge block, and the source excerpt behind the cluster's
 * combined provenance.
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[]} cluster
 * @param {Map<string, VectorSearchHit[]>} recallByProspect
 * @returns {Promise<CompletionRequest>}
 */
export async function curateRequestForCluster(runtime, cluster, recallByProspect) {
  const cfg = runtime.config
  const c = cfg.curate
  const completion = getCompletion(runtime)
  const prospects = cluster.map((p) => ({ ...viewOf(p), recall: formatHits(recallByProspect.get(strField(p.prospect_id)) ?? []) }))
  const sharedRecalled = formatSharedRecalled(cluster, recallByProspect)
  /** @type {Set<string>} */
  const idSet = new Set()
  for (const p of cluster) {
    const keys = asObject(p.source_keys)[cfg.id_column]
    if (Array.isArray(keys)) for (const k of keys) if (typeof k === 'string') idSet.add(k)
  }
  const source = await safeDeref(runtime, [...idSet])
  const maxTokens = Math.min(16_000, 2048 + cluster.length * 512)
  return buildCurateBatchRequest({ prospects, neighborhood: sharedRecalled, source, model: c.t2_model, maxTokens, provider: completion.provider })
}

/**
 * Route a cluster's curator result into committed + resolution rows. A null
 * result (refusal, batch error, or a per-request failure) or an empty decision
 * set leaves the whole cluster pending (`noDecisions`).
 *
 * @param {Record<string, unknown>[]} cluster
 * @param {CompletionResult | null} result
 * @param {string} at
 * @returns {{ committedRows: Record<string, unknown>[], resolutionRows: Record<string, unknown>[], rejected: number, merged: number, processed: number, pending: number, noDecisions: boolean }}
 */
export function routeClusterDecisions(cluster, result, at) {
  const decisions = result ? parseDecisions(result) : []
  /** @type {Record<string, unknown>[]} */
  const committedRows = []
  /** @type {Record<string, unknown>[]} */
  const resolutionRows = []
  if (decisions.length === 0) {
    return { committedRows, resolutionRows, rejected: 0, merged: 0, processed: 0, pending: 0, noDecisions: true }
  }
  const byIndex = new Map(decisions.map((d) => [d.index, d]))
  let rejected = 0
  let merged = 0
  let processed = 0
  let pending = 0
  for (let i = 0; i < cluster.length; i++) {
    const routed = routeDecision(cluster[i], viewOf(cluster[i]), byIndex.get(i + 1), at)
    // An under-specified merge ({@link routeDecision}) yields no resolution: it
    // is left in the pending queue for a better-specified later pass rather than
    // committed to the wrong node, so it is not counted as processed.
    if (!routed.resolution) {
      pending++
      continue
    }
    processed++
    if (routed.rejected) rejected++
    if (routed.merged) merged++
    if (routed.committed) committedRows.push(routed.committed)
    resolutionRows.push(routed.resolution)
  }
  return { committedRows, resolutionRows, rejected, merged, processed, pending, noDecisions: false }
}

/**
 * Terminal `skip` resolutions for below-salience prospects (no curator call).
 * @ref LLP 0028#salience-drain
 *
 * @param {Record<string, unknown>[]} skipped
 * @param {string} at
 * @returns {Record<string, unknown>[]}
 */
export function skipResolutionRows(skipped, at) {
  return skipped.map((p) => resolution(strField(p.prospect_id), 'skip', null, 'below salience threshold', at))
}

/**
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[]} rows
 */
export async function appendCommitted(runtime, rows) {
  if (rows.length > 0) {
    await runtime.storage.appendRows(enrichTablePath(runtime.storage, COMMITTED_DATASET), [...columnsFor(COMMITTED_DATASET)], rows)
  }
}

/**
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[]} rows
 */
export async function appendResolutions(runtime, rows) {
  if (rows.length > 0) {
    await runtime.storage.appendRows(enrichTablePath(runtime.storage, RESOLUTIONS_DATASET), [...columnsFor(RESOLUTIONS_DATASET)], rows)
  }
}

/**
 * One recall pass over the pending prospects: returns the per-prospect hits
 * (reused for clustering and the prompt), the salience-ordered above-threshold
 * prospects (`ordered`, descending novelty), and the below-threshold ones
 * (`skipped`). Novelty is `1 - top-1 similarity` to committed knowledge: a
 * cheap, no-LLM triage so the curator spends on the least-covered first; the
 * caller writes a terminal resolution for the skipped so they drain instead of
 * re-scoring every tick (@ref LLP 0028#salience-drain). Salience-skipping only
 * applies when a `recall_index` is configured (otherwise there is no meaningful
 * novelty); recall hits are still gathered best-effort for clustering.
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[]} pending
 * @returns {Promise<{ ordered: Record<string, unknown>[], skipped: Record<string, unknown>[], recallByProspect: Map<string, VectorSearchHit[]> }>}
 */
async function scoreAndRecall(runtime, pending) {
  const c = runtime.config.curate
  const recallIndex = runtime.config.recall_index
  /** @type {Map<string, VectorSearchHit[]>} */
  const recallByProspect = new Map()
  /** @type {Array<{ row: Record<string, unknown>, novelty: number }>} */
  const scored = []
  /** @type {Record<string, unknown>[]} */
  const skipped = []
  for (const p of pending) {
    const pid = strField(p.prospect_id)
    let hits = /** @type {VectorSearchHit[]} */ ([])
    try {
      hits = await getVector(runtime).search({ query: clusterText(p), topK: c.recall_top_k, ...(recallIndex ? { index: recallIndex } : {}) })
    } catch {
      // recall unavailable: treat as fully novel / cold
    }
    recallByProspect.set(pid, hits)
    const novelty = hits.length > 0 ? 1 - hits[0].score : 1
    if (!recallIndex || novelty >= c.salience_threshold) scored.push({ row: p, novelty })
    else skipped.push(p)
  }
  scored.sort((a, b) => b.novelty - a.novelty)
  return { ordered: scored.map((s) => s.row), skipped, recallByProspect }
}

/**
 * Group the selected prospects into curator-call clusters
 * ([§curate-clustering](LLP 0028)):
 *
 * - **Recall-region**: prospects whose top recall hit clears
 *   `recall_cluster_floor` are bucketed by that committed node id (dominates the
 *   warm ongoing regime).
 * - **Embedding**: the no-recall remainder is greedily clustered by its own
 *   embeddings so near-duplicate proposals from different sessions land in one
 *   call (dominates the cold backfill regime). Best-effort: if no embedder is
 *   resolvable the remainder falls back to session grouping.
 *
 * Every cluster is finally chunked to `max_cluster_size` so the decisions JSON
 * stays inside the output-token budget.
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[]} prospects
 * @param {Map<string, VectorSearchHit[]>} recallByProspect
 * @returns {Promise<Record<string, unknown>[][]>}
 */
export async function clusterProspects(runtime, prospects, recallByProspect) {
  const c = runtime.config.curate
  if (prospects.length === 0) return []
  /** @type {Record<string, unknown>[]} */
  const warm = []
  /** @type {Record<string, unknown>[]} */
  const cold = []
  for (const p of prospects) {
    const hits = recallByProspect.get(strField(p.prospect_id)) ?? []
    if (hits.length > 0 && hits[0].score >= c.recall_cluster_floor) warm.push(p)
    else cold.push(p)
  }
  const regionClusters = clusterByRecallRegion(warm, recallByProspect)
  const coldClusters = await embeddingClusters(runtime, cold)
  return [...regionClusters, ...coldClusters].flatMap((cl) => chunkBySize(cl, c.max_cluster_size))
}

/**
 * Bucket warm prospects by their top recalled committed node id: prospects
 * that recall the same region of the graph are curated together against it.
 * Pure.
 *
 * @param {Record<string, unknown>[]} warm
 * @param {Map<string, VectorSearchHit[]>} recallByProspect
 * @returns {Record<string, unknown>[][]}
 */
export function clusterByRecallRegion(warm, recallByProspect) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const buckets = new Map()
  for (const p of warm) {
    const hits = recallByProspect.get(strField(p.prospect_id)) ?? []
    const key = hits[0]?.id || '(none)'
    const arr = buckets.get(key) ?? []
    arr.push(p)
    buckets.set(key, arr)
  }
  return [...buckets.values()]
}

/**
 * Embed + greedily cluster the no-recall remainder. Best-effort: if no embedder
 * is resolvable the remainder is grouped by session (anchor) instead, keeping a
 * bounded curator-call count without the embedding signal.
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[]} cold
 * @returns {Promise<Record<string, unknown>[][]>}
 */
async function embeddingClusters(runtime, cold) {
  const c = runtime.config.curate
  if (cold.length === 0) return []
  if (cold.length === 1) return [cold]
  try {
    const { vectors } = await getEmbedder(runtime).embed(cold.map((p) => clusterText(p)))
    const items = cold.map((p, i) => ({ p, v: vectors[i] }))
    return greedyCosineClusters(items, c.cluster_similarity)
  } catch (err) {
    runtime.log.warn('enrich.curate_embed_unavailable', {
      [Attr.ERROR_KIND]: 'enrich_embedder_unavailable',
      message: err instanceof Error ? err.message : String(err),
      cold: cold.length,
    })
    return groupByAnchor(cold)
  }
}

/**
 * Greedy single-pass cosine clustering: walk items in a deterministic order and
 * place each into the first cluster whose seed is within `threshold`, else start
 * a new cluster. Pure (the embedding call is the caller's). Deterministic order
 * keeps re-runs stable.
 *
 * @param {Array<{ p: Record<string, unknown>, v: ArrayLike<number> }>} items
 * @param {number} threshold
 * @returns {Record<string, unknown>[][]}
 */
export function greedyCosineClusters(items, threshold) {
  const sorted = [...items].sort((a, b) => {
    const ia = strField(a.p.prospect_id)
    const ib = strField(b.p.prospect_id)
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
  /** @type {Array<{ seed: ArrayLike<number>, members: Record<string, unknown>[] }>} */
  const clusters = []
  for (const it of sorted) {
    let placed = false
    for (const cl of clusters) {
      if (cosine(it.v, cl.seed) >= threshold) {
        cl.members.push(it.p)
        placed = true
        break
      }
    }
    if (!placed) clusters.push({ seed: it.v, members: [it.p] })
  }
  return clusters.map((cl) => cl.members)
}

/**
 * Cosine similarity over two numeric vectors. Returns 0 for a zero vector
 * (avoids NaN). Pure.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function cosine(a, b) {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Split a cluster into sub-clusters of at most `maxSize` items. Pure.
 *
 * @template T
 * @param {T[]} items
 * @param {number} maxSize
 * @returns {T[][]}
 */
export function chunkBySize(items, maxSize) {
  if (items.length <= maxSize) return [items]
  /** @type {T[][]} */
  const out = []
  for (let i = 0; i < items.length; i += maxSize) out.push(items.slice(i, i + maxSize))
  return out
}

/**
 * Fallback clustering when no embedder is available: one cluster per session
 * (anchor). Pure.
 *
 * @param {Record<string, unknown>[]} prospects
 * @returns {Record<string, unknown>[][]}
 */
function groupByAnchor(prospects) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const buckets = new Map()
  for (const p of prospects) {
    const k = strField(p.anchor_key) || '(none)'
    const arr = buckets.get(k) ?? []
    arr.push(p)
    buckets.set(k, arr)
  }
  return [...buckets.values()]
}

/**
 * The text used for recall + embedding clustering of a prospect.
 *
 * @param {Record<string, unknown>} p
 * @returns {string}
 */
function clusterText(p) {
  const summary = strField(asObject(p.props).summary)
  return `${strField(p.prospect_type)}: ${strField(p.label)}${summary ? ` - ${summary}` : ''}`.trim()
}

/**
 * @param {Record<string, unknown>} p
 * @returns {{ type: string, label: string, summary: string, confidence: number | undefined }}
 */
function viewOf(p) {
  return {
    type: strField(p.prospect_type),
    label: strField(p.label),
    summary: strField(asObject(p.props).summary),
    confidence: numField(p.confidence),
  }
}

/**
 * Render a hit list (per-prospect recall, or the shared union) for the prompt.
 *
 * @param {VectorSearchHit[]} hits
 * @returns {string}
 */
function formatHits(hits) {
  return hits.map((h) => `- [${h.score.toFixed(2)}] ${h.text ?? h.id}`).join('\n')
}

/**
 * The cluster's **shared recalled knowledge**: the union of every cluster
 * prospect's recall hits, deduped by committed node id and ordered by score:
 * the content-based context the curator reasons against (cold clusters yield an
 * empty block).
 *
 * @param {Record<string, unknown>[]} cluster
 * @param {Map<string, VectorSearchHit[]>} recallByProspect
 * @returns {string}
 */
function formatSharedRecalled(cluster, recallByProspect) {
  /** @type {Map<string, { score: number, text: string }>} */
  const seen = new Map()
  for (const p of cluster) {
    for (const h of recallByProspect.get(strField(p.prospect_id)) ?? []) {
      const prev = seen.get(h.id)
      if (!prev || h.score > prev.score) seen.set(h.id, { score: h.score, text: h.text ?? h.id })
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score).map((i) => `- [${i.score.toFixed(2)}] ${i.text}`).join('\n')
}

/**
 * Targeted source excerpt behind a set of provenance row ids (the union across a
 * cluster's prospects (possibly spanning sessions). Bounded by
 * {@link MAX_SOURCE_CHARS}.
 *
 * @param {EnrichRuntime} runtime
 * @param {string[]} ids
 * @returns {Promise<string>}
 */
async function safeDeref(runtime, ids) {
  try {
    const cfg = runtime.config
    const list = ids.filter((k) => typeof k === 'string' && k.length > 0)
    if (list.length === 0) return ''
    const inList = list.slice(0, 40).map((id) => `'${sqlQuote(id)}'`).join(', ')
    // Same content filter as the T1 scan: a message whose kept text part shares
    // its id with an excluded part (e.g. a tool_result) must not re-admit that
    // part into the curator excerpt. @ref LLP 0028#row-selection
    const where = [`${cfg.id_column} IN (${inList})`, ...contentFilterClauses(cfg)].join(' AND ')
    const rows = await runSql(
      runtime,
      `SELECT ${cfg.text_column} FROM ${cfg.source_dataset} WHERE ${where} LIMIT 40`
    )
    let out = ''
    for (const r of rows) {
      const t = r[cfg.text_column]
      const s = typeof t === 'string' ? t : t == null ? '' : JSON.stringify(t)
      if (!s) continue
      out += (out ? '\n' : '') + s.slice(0, MAX_SOURCE_CHARS - out.length)
      if (out.length >= MAX_SOURCE_CHARS) break
    }
    return out
  } catch {
    return ''
  }
}

/**
 * Route one curator decision into the rows it produces: normally a resolution
 * row (so the prospect leaves the pending queue), plus a committed row for
 * `commit`/`deepen`/**`merge`**. The merge case is what realizes
 * **provenance-per-contributing-session**: a merge contributes no *new* node,
 * but it writes a committed row carrying the merging session's anchor +
 * source_keys under the canonical `(item_type, item_key)`, so the
 * content-addressed graph id collapses the node while the projector emits this
 * session's `produced` edge ([§committed-only-projection](LLP 0028)). A `reject`
 * or a prospect the curator omitted (implicit reject) commits nothing, so a
 * rejected prospect never reaches `enrichment_committed`, hence never the graph.
 *
 * A merge converges only under the *target's* canonical `(item_type, item_id)`,
 * so it needs BOTH `merge_into` (the key) and `item_type` (the type). If either
 * is missing, falling back to the prospect's own type/key would derive a
 * *different* content-addressed id and attach the `produced` edge to the wrong
 * node. Silent provenance corruption. An under-specified merge is therefore
 * returned **pending** (`resolution: null`, no commit): it stays in the queue for
 * a later, better-specified pass rather than mis-routing. Pure: no I/O.
 *
 * @ref LLP 0028#committed-only-projection [implements]
 *
 * @param {Record<string, unknown>} prospect
 * @param {{ type: string, label: string, summary: string, confidence: number | undefined }} view
 * @param {CurateDecision | undefined} decision
 * @param {string} at
 * @returns {{ committed: Record<string, unknown> | null, resolution: Record<string, unknown> | null, rejected: boolean, merged: boolean }}
 */
export function routeDecision(prospect, view, decision, at) {
  const pid = strField(prospect.prospect_id)

  // Omitted from the batch response = implicit reject (the model saw it and
  // chose not to decide); keeps the queue finite and draining.
  if (!decision || decision.decision === 'reject') {
    const note = decision?.note ?? (decision ? null : 'omitted by curator')
    return { committed: null, rejected: true, merged: false, resolution: resolution(pid, 'reject', null, note, at) }
  }

  const isMerge = decision.decision === 'merge'
  // A merge without its target key + type cannot be routed to the right
  // content-addressed node: leave it pending rather than corrupt provenance.
  if (isMerge && (!decision.merge_into || !decision.item_type)) {
    return { committed: null, rejected: false, merged: false, resolution: null }
  }
  // merge: reuse the existing canonical (type, key) so the content-addressed
  // node id collapses across sessions; commit/deepen mint from the curator's
  // fields, falling back to the prospect view.
  const itemKey = (isMerge ? decision.merge_into : decision.item_key) || view.label
  const itemType = decision.item_type || view.type
  // For merge, props come only from what the curator supplies (it saw the
  // target); null leaves the node's first-sighting props untouched.
  const summary = decision.summary || (isMerge ? '' : view.summary)
  const committed = {
    item_id: itemKey,
    item_type: itemType,
    label: decision.label || view.label,
    props: summary ? { summary } : null,
    confidence: decision.confidence ?? (isMerge ? undefined : view.confidence) ?? null,
    anchor_type: strField(prospect.anchor_type),
    anchor_key: strField(prospect.anchor_key),
    source_dataset: strField(prospect.source_dataset),
    source_keys: asObject(prospect.source_keys),
    curator: CURATOR,
    curator_version: CURATOR_VERSION,
    committed_at: at,
  }
  return { committed, rejected: false, merged: isMerge, resolution: resolution(pid, decision.decision, [itemKey], decision.note ?? null, at) }
}

/**
 * @param {string} prospectId
 * @param {string} decision
 * @param {string[] | null} committedIds
 * @param {string | null} note
 * @param {string} at
 * @returns {Record<string, unknown>}
 */
function resolution(prospectId, decision, committedIds, note, at) {
  return {
    prospect_id: prospectId,
    decision,
    committed_ids: committedIds,
    note,
    curator: CURATOR,
    curator_version: CURATOR_VERSION,
    resolved_at: at,
  }
}

/**
 * Keep one row per `prospect_id`. Defense-in-depth against duplicate prospect
 * rows (e.g. rows persisted before propose became idempotent across ticks, or
 * a future concurrent proposer): curate must never process the same prospect
 * twice in a tick, which would emit duplicate committed/resolution rows and
 * double the model spend. @ref LLP 0028#idempotent-prospects
 *
 * @param {Record<string, unknown>[]} rows
 * @returns {Record<string, unknown>[]}
 */
function dedupeById(rows) {
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Record<string, unknown>[]} */
  const out = []
  for (const r of rows) {
    const id = strField(r.prospect_id)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(r)
  }
  return out
}

/** @param {unknown} v @returns {string} */
function strField(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** @param {unknown} v @returns {number | undefined} */
function numField(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * @param {unknown} v
 * @returns {Record<string, unknown>}
 */
function asObject(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return /** @type {Record<string, unknown>} */ (v)
  if (typeof v === 'string' && v.length > 0) {
    try {
      const parsed = JSON.parse(v)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // not JSON
    }
  }
  return {}
}
