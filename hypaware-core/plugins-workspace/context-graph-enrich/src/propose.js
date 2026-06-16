// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'

import { columnsFor, enrichTablePath, PROSPECTS_DATASET, prospectId } from './datasets.js'
import { buildProposeRequest, parseProspects } from './prompts.js'
import { getCompletion, requireEnrichRuntime } from './runtime.js'
import { contentFilterClauses, runSql } from './sql.js'
import { readState, writeState } from './state.js'

/**
 * @import { EnrichConfig, EnrichRuntime, ProposeCursor } from './types.d.ts'
 * @import { SourceStatus, StartedSource } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

const EXTRACTOR = 'enrich.t1'
const EXTRACTOR_VERSION = 1
const T1_MAX_TOKENS = 2048
/** Bound the text handed to one T1 call so a long session can't blow the budget. */
const MAX_GROUP_CHARS = 12_000

/**
 * Run one T1 propose tick: read source rows since the watermark, group by
 * anchor (session), over-propose prospects per group, append them, and
 * advance the watermark. Used by both the daemon timer and `enrich propose`.
 *
 * @param {EnrichRuntime} runtime
 * @param {{ deadlineMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ groups: number, prospects: number, cursor: ProposeCursor | null }>}
 */
export async function runProposeTick(runtime, opts = {}) {
  const cfg = runtime.config
  const p = cfg.propose
  return withSpan(
    'enrich.propose_tick',
    { [Attr.COMPONENT]: 'plugin', [Attr.OPERATION]: 'enrich.propose_tick', [Attr.PLUGIN]: '@hypaware/context-graph-enrich', status: 'ok' },
    async (span) => {
      const state = readState(runtime.stateDir)
      const cursor = state.propose_cursor

      const rows = await runSql(runtime, buildProposeQuery(cfg, cursor, p.max_rows_per_tick))
      const { groups, rowMeta } = groupSourceRows(rows, cfg, cursor)

      // Over-propose per group, bounded by the per-tick deadline. Track which
      // groups we actually finished so the watermark advances only over the
      // processed prefix (an early deadline break must not skip the rest).
      /** @type {Set<string>} */
      const processedAnchors = new Set()
      /** @type {Array<{ anchorKey: string, keys: string[], candidates: ReturnType<typeof parseProspects> }>} */
      const perGroup = []
      for (const [anchorKey, g] of groups) {
        if (opts.deadlineMs && Date.now() > opts.deadlineMs) break
        const result = await getCompletion(runtime).complete(
          buildProposeRequest({ text: g.text, model: p.t1_model, maxTokens: T1_MAX_TOKENS, maxCandidates: p.max_candidates }),
          { signal: opts.signal }
        )
        processedAnchors.add(anchorKey)
        const candidates = parseProspects(result).filter((c) => (c.confidence ?? 1) >= p.confidence_floor)
        perGroup.push({ anchorKey, keys: g.keys, candidates })
      }

      const createdAt = new Date().toISOString()
      const candidateRows = [...collectProspectRows(perGroup, cfg, createdAt).values()]
      const newRows = await filterNewProspects(runtime, candidateRows)
      if (newRows.length > 0) {
        await runtime.storage.appendRows(enrichTablePath(runtime.storage, PROSPECTS_DATASET), [...columnsFor(PROSPECTS_DATASET)], newRows)
      }

      const nextCursor = nextProposeCursor(rowMeta, processedAnchors, cursor)
      if (!sameCursor(nextCursor, cursor)) writeState(runtime.stateDir, { schema_version: 2, propose_cursor: nextCursor })

      span.setAttribute('source_rows', rows.length)
      span.setAttribute('groups', processedAnchors.size)
      span.setAttribute('prospects_written', newRows.length)
      return { groups: processedAnchors.size, prospects: newRows.length, cursor: nextCursor }
    },
    { component: 'plugin' }
  )
}

/**
 * Build the SELECT for one propose tick. The watermark is the tuple
 * (timestamp, tiebreak) — `ai_gateway_messages` is part-level, so many rows
 * share one `message_created_at`. The query engine surfaces a TIMESTAMP
 * column as a `Date` and only compares it correctly against a **numeric epoch
 * literal** (`=` and string literals match nothing), so the boundary can't be
 * expressed in SQL. Instead we filter coarsely with `ts >= cursorMs` — which
 * *includes* the boundary millisecond so no same-`ts` part is lost — order by
 * the full tuple, and drop already-processed rows by exact tuple in JS (see
 * {@link groupSourceRows}). `cursor.ts` is a number, so it is interpolated
 * directly (no injection surface).
 *
 * On top of the watermark predicate the scan applies the shared
 * {@link contentFilterClauses} (drop empty-text rows + excluded part types like
 * `tool_result`), so the model only ever sees signal. Filtered-out rows are
 * never returned, which is safe for the watermark: they carry no useful content
 * to process, and the cursor advances over the rows it *did* see — so the next
 * tick's `ts >= cursor` naturally starts past them. The filter is applied
 * before `LIMIT`, so each tick's row budget is spent on useful rows, not
 * plumbing.
 *
 * @param {EnrichConfig} cfg
 * @param {ProposeCursor | null} cursor
 * @param {number} limit
 * @returns {string}
 */
export function buildProposeQuery(cfg, cursor, limit) {
  const ts = cfg.timestamp_column
  const tb = cfg.tiebreak_column
  const cols = [...new Set([cfg.id_column, cfg.text_column, cfg.anchor_key_column, ts, tb])]
  /** @type {string[]} */
  const clauses = []
  if (cursor) clauses.push(`${ts} >= ${Number(cursor.ts)}`)
  clauses.push(...contentFilterClauses(cfg))
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')} ` : ''
  return `SELECT ${cols.join(', ')} FROM ${cfg.source_dataset} ${where}ORDER BY ${ts}, ${tb} LIMIT ${limit}`
}

/**
 * Group fetched source rows by anchor (session), after dropping any row at or
 * before the `cursor` tuple — the `ts >= cursorMs` query re-includes the
 * boundary millisecond, so this exact-tuple drop is what makes the watermark
 * strictly monotonic without losing same-`ts` parts. Each surviving group
 * collects bounded text + provenance ids. `rowMeta` carries every surviving
 * row's tuple, tagged with the anchor it grouped under (or `null` if the row
 * had no anchor/text, so contributes nothing and never blocks the watermark)
 * — consumed by {@link nextProposeCursor}.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {EnrichConfig} cfg
 * @param {ProposeCursor | null} [cursor]
 * @returns {{ groups: Map<string, { text: string, keys: string[] }>, rowMeta: Array<{ ts: number, id: string, anchorKey: string | null }> }}
 */
export function groupSourceRows(rows, cfg, cursor = null) {
  /** @type {Map<string, { text: string, keys: string[] }>} */
  const groups = new Map()
  /** @type {Array<{ ts: number, id: string, anchorKey: string | null }>} */
  const rowMeta = []
  for (const r of rows) {
    const ts = toMillis(r[cfg.timestamp_column])
    const id = strField(r[cfg.tiebreak_column])
    if (cursor && cmpTuple({ ts, id }, cursor) <= 0) continue // already processed (boundary re-fetch)
    const anchorKey = strField(r[cfg.anchor_key_column])
    const text = anchorKey ? textField(r[cfg.text_column]) : ''
    if (anchorKey && text) {
      const g = groups.get(anchorKey) ?? { text: '', keys: [] }
      if (g.text.length < MAX_GROUP_CHARS) {
        g.text += (g.text ? '\n' : '') + text.slice(0, MAX_GROUP_CHARS - g.text.length)
      }
      const idVal = strField(r[cfg.id_column])
      if (idVal) g.keys.push(idVal)
      groups.set(anchorKey, g)
      rowMeta.push({ ts, id, anchorKey })
    } else {
      rowMeta.push({ ts, id, anchorKey: null })
    }
  }
  return { groups, rowMeta }
}

/**
 * Advance the watermark to the largest row tuple that is strictly below every
 * *unprocessed* group's rows — i.e. only over the fully-processed prefix.
 * Rows with no anchor never block. If the very first blocking row is at the
 * front, the cursor does not move (no safe progress). Order-independent: a
 * later-but-already-processed group can't pull the cursor past an earlier
 * un-proposed group. Reprocessing past the boundary is harmless (prospect ids
 * are deterministic and {@link filterNewProspects} drops already-persisted
 * ones); skipping is not — so this errs toward redo.
 *
 * @param {Array<{ ts: number, id: string, anchorKey: string | null }>} rowMeta
 * @param {Set<string>} processedAnchors
 * @param {ProposeCursor | null} currentCursor
 * @returns {ProposeCursor | null}
 */
export function nextProposeCursor(rowMeta, processedAnchors, currentCursor) {
  /** @type {ProposeCursor | null} */
  let minBlocking = null
  for (const m of rowMeta) {
    if (m.anchorKey && !processedAnchors.has(m.anchorKey)) {
      if (!minBlocking || cmpTuple(m, minBlocking) < 0) minBlocking = { ts: m.ts, id: m.id }
    }
  }
  let next = currentCursor
  for (const m of rowMeta) {
    if (m.anchorKey && !processedAnchors.has(m.anchorKey)) continue
    if (minBlocking && cmpTuple(m, minBlocking) >= 0) continue
    if (!next || cmpTuple(m, next) > 0) next = { ts: m.ts, id: m.id }
  }
  return next
}

/**
 * Dedup proposed candidates into prospect rows keyed by a deterministic
 * {@link prospectId} — the same (extractor, version, anchor, type+label)
 * collapses to one row, so re-proposing the same content never duplicates.
 *
 * @param {Array<{ anchorKey: string, keys: string[], candidates: ReturnType<typeof parseProspects> }>} perGroup
 * @param {EnrichConfig} cfg
 * @param {string} createdAt
 * @returns {Map<string, Record<string, unknown>>}
 */
export function collectProspectRows(perGroup, cfg, createdAt) {
  /** @type {Map<string, Record<string, unknown>>} */
  const out = new Map()
  for (const { anchorKey, keys, candidates } of perGroup) {
    for (const c of candidates) {
      const id = prospectId({
        extractor: EXTRACTOR,
        extractorVersion: EXTRACTOR_VERSION,
        anchorKey,
        candidateKey: `${c.type} ${c.label}`,
      })
      if (out.has(id)) continue
      out.set(id, {
        prospect_id: id,
        prospect_type: c.type,
        label: c.label,
        props: c.summary ? { summary: c.summary } : null,
        confidence: c.confidence ?? null,
        evidence: c.evidence ?? null,
        anchor_type: cfg.anchor_type,
        anchor_key: anchorKey,
        source_dataset: cfg.source_dataset,
        source_keys: { [cfg.id_column]: keys },
        extractor: EXTRACTOR,
        extractor_version: EXTRACTOR_VERSION,
        created_at: createdAt,
      })
    }
  }
  return out
}

/**
 * Drop candidate prospect rows whose deterministic {@link prospectId} is
 * already persisted, making the append **idempotent across ticks**. The
 * watermark deliberately errs toward re-reading source rows (see
 * {@link nextProposeCursor}), and a tick that appends prospects but crashes
 * before advancing the watermark re-reads the same source next tick — so
 * without this filter a retried/overlapping tick would append duplicate
 * prospect rows that T2 then curates again (duplicate committed + resolution
 * rows and wasted model spend). Mirrors the graph projector's pre-write dedup
 * (read the committed id set, filter before append; only a missing dataset is
 * a benign failure there).
 *
 * @ref LLP 0028#idempotent-prospects [implements]
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[]} candidates
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function filterNewProspects(runtime, candidates) {
  if (candidates.length === 0) return candidates
  const existing = await runSql(runtime, `SELECT prospect_id FROM ${PROSPECTS_DATASET}`, { allowMissing: true })
  const seen = new Set(existing.map((r) => strField(r.prospect_id)))
  return candidates.filter((r) => !seen.has(strField(r.prospect_id)))
}

/**
 * @param {ProposeCursor | null} a
 * @param {ProposeCursor | null} b
 * @returns {boolean}
 */
function sameCursor(a, b) {
  if (a === null || b === null) return a === b
  return a.ts === b.ts && a.id === b.id
}

/**
 * @param {{ ts: number, id: string }} a
 * @param {{ ts: number, id: string }} b
 * @returns {number}
 */
function cmpTuple(a, b) {
  if (a.ts < b.ts) return -1
  if (a.ts > b.ts) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/**
 * Coerce a source timestamp cell to epoch milliseconds. The query engine
 * surfaces a TIMESTAMP column as a `Date`; spool/JSON paths may surface an
 * ISO string or a raw number. A missing/unparseable value sorts first (0).
 *
 * @param {unknown} v
 * @returns {number}
 */
function toMillis(v) {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? 0 : ms
  }
  return 0
}

/**
 * Daemon source: a refresh timer mirroring `@hypaware/vector-search`'s
 * `vector-search-refresh` (interval tick, in-flight guard, unref'd handle,
 * reload on config change).
 *
 * @returns {Promise<StartedSource>}
 */
export async function startProposeSource() {
  const runtime = requireEnrichRuntime()
  /** @type {ReturnType<typeof setInterval> | null} */
  let handle = null
  /** @type {Promise<unknown> | null} */
  let inFlight = null
  let lastTickAt = /** @type {string | null} */ (null)

  async function tick() {
    lastTickAt = new Date().toISOString()
    const p = runtime.config.propose
    try {
      await runProposeTick(runtime, { deadlineMs: Date.now() + p.max_tick_ms })
    } catch (err) {
      runtime.log.error('enrich.propose_tick_failed', {
        [Attr.ERROR_KIND]: 'enrich_propose_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function startTimer() {
    const p = runtime.config.propose
    if (!p.enabled) return
    const intervalMs = Math.max(1, Math.round(p.interval_minutes * 60_000))
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
        message: runtime.config.propose.enabled
          ? `propose every ${runtime.config.propose.interval_minutes}m`
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

/**
 * Coerce a source text cell to a string. The default source column
 * (`content_text` on `ai_gateway_messages`) is a part-level STRING; this
 * stays defensive for sources whose text column is a JSON value.
 *
 * @param {unknown} v
 * @returns {string}
 */
function textField(v) {
  if (typeof v === 'string') return v
  if (v == null) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
