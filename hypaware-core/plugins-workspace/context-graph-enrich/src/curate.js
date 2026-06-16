// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'

import { columnsFor, COMMITTED_DATASET, enrichTablePath, PROSPECTS_DATASET, RESOLUTIONS_DATASET } from './datasets.js'
import { buildCurateBatchRequest, parseDecisions } from './prompts.js'
import { getCompletion, getVector, requireEnrichRuntime } from './runtime.js'
import { runSql, sqlQuote } from './sql.js'

/**
 * @import { CurateDecision, EnrichRuntime } from './types.d.ts'
 * @import { SourceStatus, StartedSource } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

const CURATOR = 'enrich.t2'
const CURATOR_VERSION = 1
const MAX_SOURCE_CHARS = 8_000

/**
 * Run one T2 curate tick. Selects pending prospects (no resolution yet),
 * orders by salience (novelty vs. committed knowledge), then **groups the
 * selection by anchor (session)** and makes ONE curator call per group:
 * the shared graph neighborhood and source excerpt are read once and reused
 * across the group's prospects, instead of re-reading the same session
 * source for every prospect. Committed items go to `enrichment_committed`
 * (the only dataset the graph contract reads); every decided prospect gets a
 * resolution row so it leaves the queue. Used by the daemon timer and
 * `enrich curate`.
 *
 * @param {EnrichRuntime} runtime
 * @param {{ deadlineMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ pending: number, processed: number, committed: number, rejected: number, skipped: number, calls: number }>}
 */
export async function runCurateTick(runtime, opts = {}) {
  const cfg = runtime.config
  const c = cfg.curate
  return withSpan(
    'enrich.curate_tick',
    { [Attr.COMPONENT]: 'plugin', [Attr.OPERATION]: 'enrich.curate_tick', [Attr.PLUGIN]: '@hypaware/context-graph-enrich', status: 'ok' },
    async (span) => {
      const resolvedRows = await runSql(runtime, `SELECT prospect_id FROM ${RESOLUTIONS_DATASET}`, { allowMissing: true })
      const resolved = new Set(resolvedRows.map((r) => strField(r.prospect_id)))
      const allProspects = await runSql(runtime, `SELECT * FROM ${PROSPECTS_DATASET}`, { allowMissing: true })
      const pending = dedupeById(allProspects.filter((p) => !resolved.has(strField(p.prospect_id))))

      const { ordered, skipped } = await orderBySalience(runtime, pending)
      const selected = ordered.slice(0, c.max_prospects_per_tick)

      // Group the selection by anchor (session) → one curator call per group.
      /** @type {Map<string, Record<string, unknown>[]>} */
      const groups = new Map()
      for (const p of selected) {
        const k = strField(p.anchor_key) || '(none)'
        const arr = groups.get(k) ?? []
        arr.push(p)
        groups.set(k, arr)
      }

      /** @type {Record<string, unknown>[]} */
      const committedRows = []
      /** @type {Record<string, unknown>[]} */
      const resolutionRows = []
      let processed = 0
      let rejected = 0
      let calls = 0
      const at = new Date().toISOString()

      for (const group of groups.values()) {
        if (opts.deadlineMs && Date.now() > opts.deadlineMs) break
        const rep = group[0]
        const anchorType = strField(rep.anchor_type)
        const anchorKey = strField(rep.anchor_key)

        // Per-prospect view + recall (cheap, local — not the cost driver).
        /** @type {Array<{ prospect: Record<string, unknown>, view: { type: string, label: string, summary: string, confidence: number | undefined }, recall: string }>} */
        const views = []
        for (const prospect of group) {
          const view = {
            type: strField(prospect.prospect_type),
            label: strField(prospect.label),
            summary: strField(asObject(prospect.props).summary),
            confidence: numField(prospect.confidence),
          }
          const recall = await safeRecall(runtime, `${view.type}: ${view.label} — ${view.summary}`.trim(), c.recall_top_k)
          views.push({ prospect, view, recall })
        }

        // Shared expand + deref: read once for the whole group. The source is
        // the union of every group prospect's provenance rows.
        const neighborhood = await safeExpand(runtime, anchorType, anchorKey)
        /** @type {Set<string>} */
        const idSet = new Set()
        for (const p of group) {
          const keys = asObject(p.source_keys)[cfg.id_column]
          if (Array.isArray(keys)) for (const k of keys) if (typeof k === 'string') idSet.add(k)
        }
        const source = await safeDeref(runtime, [...idSet])

        const maxTokens = Math.min(16_000, 2048 + group.length * 512)
        const completion = getCompletion(runtime)
        const result = await completion.complete(
          buildCurateBatchRequest({
            prospects: views.map((v) => ({ ...v.view, recall: v.recall })),
            neighborhood,
            source,
            model: c.t2_model,
            maxTokens,
            provider: completion.provider,
          }),
          { signal: opts.signal }
        )
        calls++

        const decisions = parseDecisions(result)
        if (decisions.length === 0) {
          // Refusal / no tool call — leave the whole group pending so it
          // retries next tick rather than mass-rejecting on a transient miss.
          runtime.log.warn('enrich.curate_no_decisions', { anchor: anchorKey, group_size: group.length })
          continue
        }
        const byIndex = new Map(decisions.map((d) => [d.index, d]))

        for (let i = 0; i < group.length; i++) {
          processed++
          const routed = routeDecision(group[i], views[i].view, byIndex.get(i + 1), at)
          if (routed.rejected) rejected++
          if (routed.committed) committedRows.push(routed.committed)
          resolutionRows.push(routed.resolution)
        }
      }

      // Sub-salience-threshold prospects are auto-skipped: a terminal `skip`
      // resolution (no curator call, nothing committed) drains them from the
      // pending queue so they don't re-score every tick. @ref LLP 0028#salience-drain
      for (const p of skipped) {
        resolutionRows.push(resolution(strField(p.prospect_id), 'skip', null, 'below salience threshold', at))
      }

      if (committedRows.length > 0) {
        await runtime.storage.appendRows(enrichTablePath(runtime.storage, COMMITTED_DATASET), [...columnsFor(COMMITTED_DATASET)], committedRows)
      }
      if (resolutionRows.length > 0) {
        await runtime.storage.appendRows(enrichTablePath(runtime.storage, RESOLUTIONS_DATASET), [...columnsFor(RESOLUTIONS_DATASET)], resolutionRows)
      }

      span.setAttribute('pending', pending.length)
      span.setAttribute('processed', processed)
      span.setAttribute('committed', committedRows.length)
      span.setAttribute('rejected', rejected)
      span.setAttribute('skipped', skipped.length)
      span.setAttribute('curate_calls', calls)
      return { pending: pending.length, processed, committed: committedRows.length, rejected, skipped: skipped.length, calls }
    },
    { component: 'plugin' }
  )
}

/**
 * Triage pending prospects by novelty (1 - best similarity to existing
 * committed knowledge): a cheap, no-LLM pass so the curator spends on the
 * least-covered prospects first. Returns the above-threshold prospects in
 * `ordered` (descending novelty) and the below-threshold ones in `skipped`
 * — the caller writes the skipped a terminal resolution so they drain instead
 * of re-scoring every tick (@ref LLP 0028#salience-drain). No recall index
 * configured → everything is `ordered` (FIFO), nothing skipped.
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[]} pending
 * @returns {Promise<{ ordered: Record<string, unknown>[], skipped: Record<string, unknown>[] }>}
 */
async function orderBySalience(runtime, pending) {
  const c = runtime.config.curate
  if (!runtime.config.recall_index || pending.length <= 1) return { ordered: pending, skipped: [] }
  /** @type {Array<{ row: Record<string, unknown>, novelty: number }>} */
  const scored = []
  /** @type {Record<string, unknown>[]} */
  const skipped = []
  for (const p of pending) {
    const text = `${strField(p.prospect_type)}: ${strField(p.label)}`
    let novelty = 1
    try {
      const hits = await getVector(runtime).search({ query: text, index: runtime.config.recall_index, topK: 1 })
      if (hits.length > 0) novelty = 1 - hits[0].score
    } catch {
      // recall unavailable — treat as fully novel
    }
    if (novelty >= c.salience_threshold) scored.push({ row: p, novelty })
    else skipped.push(p)
  }
  scored.sort((a, b) => b.novelty - a.novelty)
  return { ordered: scored.map((s) => s.row), skipped }
}

/**
 * Similar existing committed items for one prospect (best-effort).
 *
 * @param {EnrichRuntime} runtime
 * @param {string} text
 * @param {number} topK
 * @returns {Promise<string>}
 */
async function safeRecall(runtime, text, topK) {
  try {
    const hits = await getVector(runtime).search({ query: text, topK, ...(runtime.config.recall_index ? { index: runtime.config.recall_index } : {}) })
    return hits.map((h) => `- [${h.score.toFixed(2)}] ${h.text ?? h.id}`).join('\n')
  } catch {
    return ''
  }
}

/**
 * One-hop neighborhood of an anchor node, read from the published
 * `node`/`edge` datasets (not via a cross-plugin import — the substrate-true
 * "bring your own query over the published surface").
 *
 * @param {EnrichRuntime} runtime
 * @param {string} anchorType
 * @param {string} anchorKey
 * @returns {Promise<string>}
 */
async function safeExpand(runtime, anchorType, anchorKey) {
  try {
    if (!anchorType || !anchorKey) return ''
    const anchorId = runtime.graph.kit.nodeId(anchorType, anchorKey)
    const q = sqlQuote(anchorId)
    const limit = runtime.config.curate.recall_top_k
    const edges = await runSql(
      runtime,
      `SELECT edge_type, src_id, dst_id FROM edge WHERE src_id = '${q}' OR dst_id = '${q}' LIMIT ${limit}`,
      { allowMissing: true } // graph surface may not be projected yet
    )
    if (edges.length === 0) return ''
    /** @type {Set<string>} */
    const neighborIds = new Set()
    for (const e of edges) {
      const src = strField(e.src_id)
      const dst = strField(e.dst_id)
      if (src && src !== anchorId) neighborIds.add(src)
      if (dst && dst !== anchorId) neighborIds.add(dst)
    }
    if (neighborIds.size === 0) return ''
    const inList = [...neighborIds].map((id) => `'${sqlQuote(id)}'`).join(', ')
    const nodes = await runSql(runtime, `SELECT node_type, label FROM node WHERE node_id IN (${inList}) LIMIT 50`, { allowMissing: true })
    return nodes.map((n) => `- ${strField(n.node_type)}: ${strField(n.label)}`).join('\n')
  } catch {
    return ''
  }
}

/**
 * Targeted source excerpt behind a set of provenance row ids (the union
 * across a group's prospects). Bounded by {@link MAX_SOURCE_CHARS}.
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
    const rows = await runSql(
      runtime,
      `SELECT ${cfg.text_column} FROM ${cfg.source_dataset} WHERE ${cfg.id_column} IN (${inList}) LIMIT 40`
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
 * Route one curator decision into the rows it produces: always a resolution
 * row (so the prospect leaves the pending queue), plus a committed row for
 * `commit`/`deepen`. A `reject` — or a prospect the curator omitted from the
 * batch response (implicit reject) — commits nothing: that is exactly how a
 * rejected prospect never reaches `enrichment_committed`, hence never the
 * graph. Pure: no I/O, so the reject/merge/commit/deepen routing is testable.
 *
 * @param {Record<string, unknown>} prospect
 * @param {{ type: string, label: string, summary: string, confidence: number | undefined }} view
 * @param {CurateDecision | undefined} decision
 * @param {string} at
 * @returns {{ committed: Record<string, unknown> | null, resolution: Record<string, unknown>, rejected: boolean }}
 */
export function routeDecision(prospect, view, decision, at) {
  const pid = strField(prospect.prospect_id)

  // Omitted from the batch response = implicit reject (the model saw it and
  // chose not to decide); keeps the queue finite and draining.
  if (!decision || decision.decision === 'reject') {
    const note = decision?.note ?? (decision ? null : 'omitted by curator')
    return { committed: null, rejected: true, resolution: resolution(pid, 'reject', null, note, at) }
  }
  if (decision.decision === 'merge') {
    const into = decision.merge_into || decision.item_key || null
    return { committed: null, rejected: false, resolution: resolution(pid, 'merge', into ? [into] : null, decision.note ?? null, at) }
  }
  // commit | deepen → write a committed item
  const itemKey = decision.item_key || view.label
  const committed = {
    item_id: itemKey,
    item_type: decision.item_type || view.type,
    label: decision.label || view.label,
    props: decision.summary || view.summary ? { summary: decision.summary || view.summary } : null,
    confidence: decision.confidence ?? view.confidence ?? null,
    anchor_type: strField(prospect.anchor_type),
    anchor_key: strField(prospect.anchor_key),
    source_dataset: strField(prospect.source_dataset),
    source_keys: asObject(prospect.source_keys),
    curator: CURATOR,
    curator_version: CURATOR_VERSION,
    committed_at: at,
  }
  return { committed, rejected: false, resolution: resolution(pid, decision.decision, [itemKey], decision.note ?? null, at) }
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
 * Daemon source mirroring the propose source's timer shape.
 *
 * @returns {Promise<StartedSource>}
 */
export async function startCurateSource() {
  const runtime = requireEnrichRuntime()
  /** @type {ReturnType<typeof setInterval> | null} */
  let handle = null
  /** @type {Promise<unknown> | null} */
  let inFlight = null
  let lastTickAt = /** @type {string | null} */ (null)

  async function tick() {
    lastTickAt = new Date().toISOString()
    const c = runtime.config.curate
    try {
      await runCurateTick(runtime, { deadlineMs: Date.now() + c.max_tick_ms })
    } catch (err) {
      runtime.log.error('enrich.curate_tick_failed', {
        [Attr.ERROR_KIND]: 'enrich_curate_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function startTimer() {
    const c = runtime.config.curate
    if (!c.enabled) return
    const intervalMs = Math.max(1, Math.round(c.interval_minutes * 60_000))
    handle = setInterval(() => {
      if (inFlight) return
      inFlight = tick().finally(() => { inFlight = null })
    }, intervalMs)
    if (typeof handle.unref === 'function') handle.unref()
  }

  function stopTimer() {
    if (handle) clearInterval(handle)
    handle = null
  }

  startTimer()

  return {
    async status() {
      /** @type {SourceStatus} */
      const status = {
        state: handle !== null ? 'ready' : 'stopped',
        message: runtime.config.curate.enabled
          ? `curate every ${runtime.config.curate.interval_minutes}m`
          : 'disabled',
        details: { last_tick_at: lastTickAt },
      }
      return status
    },
    async reload() {
      stopTimer()
      startTimer()
    },
    async stop() {
      stopTimer()
      if (inFlight) await inFlight.catch(() => {})
    },
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
