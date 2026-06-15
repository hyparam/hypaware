// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'

import { columnsFor, COMMITTED_DATASET, enrichTablePath, PROSPECTS_DATASET, RESOLUTIONS_DATASET } from './datasets.js'
import { buildCurateRequest, parseDecision } from './prompts.js'
import { getCompletion, getVector, requireEnrichRuntime } from './runtime.js'
import { runSql, sqlQuote } from './sql.js'

/**
 * @import { EnrichRuntime } from './types.d.ts'
 * @import { SourceStatus, StartedSource } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

const CURATOR = 'enrich.t2'
const CURATOR_VERSION = 1
const T2_MAX_TOKENS = 4096
const MAX_SOURCE_CHARS = 8_000

/**
 * Run one T2 curate tick: select pending prospects (no resolution yet),
 * order by salience (novelty vs. committed knowledge), and for each assemble
 * the serve path (recall → expand → deref) and ask the curator to
 * prune/merge/deepen/commit. Committed items go to `enrichment_committed`
 * (the only dataset the graph contract reads); every processed prospect gets
 * a resolution row so it leaves the queue. Used by the daemon timer and
 * `enrich curate`.
 *
 * @param {EnrichRuntime} runtime
 * @param {{ deadlineMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ pending: number, processed: number, committed: number, rejected: number }>}
 */
export async function runCurateTick(runtime, opts = {}) {
  const cfg = runtime.config
  const c = cfg.curate
  return withSpan(
    'enrich.curate_tick',
    { [Attr.COMPONENT]: 'plugin', [Attr.OPERATION]: 'enrich.curate_tick', [Attr.PLUGIN]: '@hypaware/context-graph-enrich', status: 'ok' },
    async (span) => {
      const resolvedRows = await runSql(runtime, `SELECT prospect_id FROM ${RESOLUTIONS_DATASET}`)
      const resolved = new Set(resolvedRows.map((r) => strField(r.prospect_id)))
      const allProspects = await runSql(runtime, `SELECT * FROM ${PROSPECTS_DATASET}`)
      const pending = allProspects.filter((p) => !resolved.has(strField(p.prospect_id)))

      const ordered = await orderBySalience(runtime, pending)
      const selected = ordered.slice(0, c.max_prospects_per_tick)

      /** @type {Record<string, unknown>[]} */
      const committedRows = []
      /** @type {Record<string, unknown>[]} */
      const resolutionRows = []
      let processed = 0
      let rejected = 0
      const at = new Date().toISOString()

      for (const prospect of selected) {
        if (opts.deadlineMs && Date.now() > opts.deadlineMs) break
        const view = {
          type: strField(prospect.prospect_type),
          label: strField(prospect.label),
          summary: strField(asObject(prospect.props).summary),
          confidence: numField(prospect.confidence),
        }
        const prospectText = `${view.type}: ${view.label} — ${view.summary}`.trim()

        const recall = await safeRecall(runtime, prospectText, c.recall_top_k)
        const neighborhood = await safeExpand(runtime, prospect)
        const source = await safeDeref(runtime, prospect)

        const result = await getCompletion(runtime).complete(
          buildCurateRequest({ prospect: view, recall, neighborhood, source, model: c.t2_model, maxTokens: T2_MAX_TOKENS }),
          { signal: opts.signal }
        )
        const decision = parseDecision(result)
        processed++
        const prospectId = strField(prospect.prospect_id)

        if (!decision || decision.decision === 'reject') {
          rejected++
          resolutionRows.push(resolution(prospectId, 'reject', null, decision?.note ?? (decision ? null : 'no decision'), at))
          continue
        }
        if (decision.decision === 'merge') {
          const into = decision.merge_into || decision.item_key || null
          resolutionRows.push(resolution(prospectId, 'merge', into ? [into] : null, decision.note ?? null, at))
          continue
        }
        // commit | deepen → write a committed item
        const itemType = decision.item_type || view.type
        const itemKey = decision.item_key || view.label
        const label = decision.label || view.label
        committedRows.push({
          item_id: itemKey,
          item_type: itemType,
          label,
          props: decision.summary ? { summary: decision.summary } : asObject(prospect.props).summary ? { summary: asObject(prospect.props).summary } : null,
          confidence: decision.confidence ?? view.confidence ?? null,
          anchor_type: strField(prospect.anchor_type),
          anchor_key: strField(prospect.anchor_key),
          source_dataset: strField(prospect.source_dataset),
          source_keys: asObject(prospect.source_keys),
          curator: CURATOR,
          curator_version: CURATOR_VERSION,
          committed_at: at,
        })
        resolutionRows.push(resolution(prospectId, decision.decision, [itemKey], decision.note ?? null, at))
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
      return { pending: pending.length, processed, committed: committedRows.length, rejected }
    },
    { component: 'plugin' }
  )
}

/**
 * Order pending prospects by novelty (1 - best similarity to existing
 * committed knowledge). No recall index configured → FIFO. A cheap,
 * no-LLM triage so the curator spends on the least-covered prospects first.
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[]} pending
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function orderBySalience(runtime, pending) {
  const c = runtime.config.curate
  if (!runtime.config.recall_index || pending.length <= 1) return pending
  /** @type {Array<{ row: Record<string, unknown>, novelty: number }>} */
  const scored = []
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
  }
  scored.sort((a, b) => b.novelty - a.novelty)
  return scored.map((s) => s.row)
}

/**
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
 * One-hop neighborhood of the prospect's anchor node, read from the
 * published `node`/`edge` datasets (not via a cross-plugin import — the
 * substrate-true "bring your own query over the published surface").
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>} prospect
 * @returns {Promise<string>}
 */
async function safeExpand(runtime, prospect) {
  try {
    const anchorType = strField(prospect.anchor_type)
    const anchorKey = strField(prospect.anchor_key)
    if (!anchorType || !anchorKey) return ''
    const anchorId = runtime.graph.kit.nodeId(anchorType, anchorKey)
    const q = sqlQuote(anchorId)
    const limit = runtime.config.curate.recall_top_k
    const edges = await runSql(
      runtime,
      `SELECT edge_type, src_id, dst_id FROM edge WHERE src_id = '${q}' OR dst_id = '${q}' LIMIT ${limit}`
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
    const nodes = await runSql(runtime, `SELECT node_type, label FROM node WHERE node_id IN (${inList}) LIMIT 50`)
    return nodes.map((n) => `- ${strField(n.node_type)}: ${strField(n.label)}`).join('\n')
  } catch {
    return ''
  }
}

/**
 * Targeted source excerpt behind the prospect (its provenance rows).
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>} prospect
 * @returns {Promise<string>}
 */
async function safeDeref(runtime, prospect) {
  try {
    const cfg = runtime.config
    const keys = asObject(prospect.source_keys)[cfg.id_column]
    const ids = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : []
    if (ids.length === 0) return ''
    const inList = ids.slice(0, 20).map((id) => `'${sqlQuote(String(id))}'`).join(', ')
    const rows = await runSql(
      runtime,
      `SELECT ${cfg.text_column} FROM ${cfg.source_dataset} WHERE ${cfg.id_column} IN (${inList}) LIMIT 20`
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
