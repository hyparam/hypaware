// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'

import { columnsFor, enrichTablePath, PROSPECTS_DATASET, prospectId } from './datasets.js'
import { buildProposeRequest, parseProspects } from './prompts.js'
import { getCompletion, requireEnrichRuntime } from './runtime.js'
import { contentFilterClauses, runSql, sqlQuote } from './sql.js'
import { readState, updateState } from './state.js'

/**
 * @import { EnrichConfig, EnrichRuntime, SessionMark } from './types.js'
 * @import { SourceStatus, StartedSource } from '../../../../collectivus-plugin-kernel-types.js'
 */

const EXTRACTOR = 'enrich.t1'
const EXTRACTOR_VERSION = 1

/**
 * Run one T1 propose tick over **whole sessions**. The two regimes differ only
 * in their session selector ([§two-regimes](LLP 0028)):
 *
 * - `ongoing` (default): settled, not-yet-enriched sessions. Latest part older
 *   than `settle_cutoff_minutes` AND past the session's watermark, capped at
 *   `max_sessions_per_tick`.
 * - `backfill`: every session, ignoring the settle cutoff and the watermark.
 *
 * Each selected session's filtered parts are stitched in DAG order, `tool_result`
 * excluded, and passed to a **single** frontier-model call, closing the old
 * 12k-char truncation defect. Prospects are deduped by a deterministic
 * {@link prospectId}, pre-write-filtered against the persisted set (idempotent
 * across ticks/regimes), appended, and the session's watermark is advanced.
 *
 * @ref LLP 0028#two-tiers-one-pipeline [implements]:
 *
 * @param {EnrichRuntime} runtime
 * @param {{ regime?: 'ongoing' | 'backfill', sessionIds?: string[], deadlineMs?: number, nowMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ regime: string, candidates: number, sessions: number, prospects: number }>}
 */
export async function runProposeTick(runtime, opts = {}) {
  const cfg = runtime.config
  const p = cfg.propose
  const regime = opts.regime ?? 'ongoing'
  return withSpan(
    'enrich.propose_tick',
    { [Attr.COMPONENT]: 'plugin', [Attr.OPERATION]: 'enrich.propose_tick', [Attr.PLUGIN]: '@hypaware/context-graph-enrich', regime, status: 'ok' },
    async (span) => {
      const state = readState(runtime.stateDir)
      const marks = state.session_marks
      const nowMs = opts.nowMs ?? Date.now()

      const sessionIds = opts.sessionIds ?? (await selectSessions(runtime, { regime, nowMs, marks }))

      // Per session: read its filtered parts, DAG-order them, extract in full.
      // Track which sessions advanced so the watermark only moves over the
      // sessions actually processed (an early deadline break must not skip the
      // rest: they re-qualify next tick).
      /** @type {Array<{ anchorKey: string, keys: string[], candidates: ReturnType<typeof parseProspects> }>} */
      const perSession = []
      /** @type {Record<string, SessionMark>} */
      const newMarks = {}
      let extracted = 0
      for (const sid of sessionIds) {
        if (opts.deadlineMs && Date.now() > opts.deadlineMs) break
        const partRows = await runSql(runtime, buildSessionPartsQuery(cfg, sid))
        const ordered = orderSessionParts(partRows, cfg)
        if (ordered.length === 0) continue
        const mark = sessionMark(ordered, cfg)
        // Re-qualify against this read's own parts: the selector already compared
        // the exact tuple, but its aggregate and this parts query are separate
        // reads. A part landing between them could make a just-selected session
        // already-covered (TOCTOU). Backfill re-extracts unconditionally: its
        // appends are idempotent ({@link filterNewProspects}).
        if (regime === 'ongoing') {
          const prev = marks[sid]
          if (prev && cmpMark(mark, prev) <= 0) continue
        }

        const { text, keys } = buildTranscript(ordered, cfg)
        if (text) {
          const result = await getCompletion(runtime).complete(
            buildProposeRequest({ text, model: p.t1_model, maxTokens: t1MaxTokens(p), maxCandidates: p.max_candidates }),
            { signal: opts.signal }
          )
          const candidates = parseProspects(result).filter((c) => (c.confidence ?? 1) >= p.confidence_floor)
          perSession.push({ anchorKey: sid, keys, candidates })
          extracted++
        }
        // Advance even for a settled session with no extractable text, so it
        // drains from the eligible pool instead of being re-fetched every tick.
        newMarks[sid] = mark
      }

      const createdAt = new Date().toISOString()
      const candidateRows = [...collectProspectRows(perSession, cfg, createdAt).values()]
      const newRows = await filterNewProspects(runtime, candidateRows)
      if (newRows.length > 0) {
        await runtime.storage.appendRows(enrichTablePath(runtime.storage, PROSPECTS_DATASET), [...columnsFor(PROSPECTS_DATASET)], newRows)
      }

      // Persist marks only AFTER the prospects are appended: a crash in between
      // re-reads the same sessions next tick (safe: idempotent), whereas
      // marking first then crashing would lose a session's prospects forever.
      const advanced = Object.keys(newMarks)
      if (advanced.length > 0) {
        // Read-modify-write the latest state, never the start-of-tick snapshot:
        // a curate tick may have submitted a job during this tick's await window,
        // so merge marks into the on-disk state and preserve its curate_job
        // rather than clobbering it back to null (lost update → orphaned batch +
        // double spend). @ref LLP 0028#two-regimes
        updateState(runtime.stateDir, (cur) => ({
          schema_version: 4,
          session_marks: { ...cur.session_marks, ...newMarks },
          curate_job: cur.curate_job,
        }))
      }

      span.setAttribute('candidate_sessions', sessionIds.length)
      span.setAttribute('sessions_extracted', extracted)
      span.setAttribute('sessions_marked', advanced.length)
      span.setAttribute('prospects_written', newRows.length)
      return { regime, candidates: sessionIds.length, sessions: extracted, prospects: newRows.length }
    },
    { component: 'plugin' }
  )
}

/**
 * Select the sessions a tick should extract. One aggregate query
 * ({@link buildSessionAggregateQuery}) returns the **precise latest part tuple**
 * `(last_ts, last_id)` per session. One row per session, and the regime filters
 * it in JS:
 *
 * - `backfill`: every session with extractable content.
 * - `ongoing`: only **settled** sessions (latest part older than
 *   `settle_cutoff_minutes`) whose latest part is strictly past the stored
 *   watermark, oldest-settled first and capped at `max_sessions_per_tick`.
 *
 * The exclusion compares the **full `(ts, tiebreak)` tuple** against the mark
 * ({@link cmpMark}), not the timestamp alone: parts of one message share a
 * wall-clock millisecond, so a same-`ts` part that advanced the session past its
 * mark (higher tiebreak) must re-qualify. A timestamp-only check would silently
 * drop its text. The tuple match is also why an already-enriched session
 * (`cmpMark == 0`) is excluded rather than re-selected every tick (no
 * cap-flooding). {@link runProposeTick} keeps a precise re-check as a TOCTOU
 * guard against rows landing between the two queries.
 *
 * @ref LLP 0028#two-regimes [implements]:
 *
 * @param {EnrichRuntime} runtime
 * @param {{ regime: 'ongoing' | 'backfill', nowMs: number, marks: Record<string, SessionMark> }} args
 * @returns {Promise<string[]>}
 */
export async function selectSessions(runtime, { regime, nowMs, marks }) {
  const cfg = runtime.config
  const p = cfg.propose
  const rows = await runSql(runtime, buildSessionAggregateQuery(cfg), { allowMissing: false })
  const settleBeforeMs = nowMs - Math.round(p.settle_cutoff_minutes * 60_000)

  /** @type {Array<{ sid: string, lastTs: number }>} */
  const eligible = []
  for (const r of rows) {
    const sid = strField(r[cfg.anchor_key_column])
    if (!sid) continue
    const lastTs = toMillis(r.last_ts)
    if (regime === 'ongoing') {
      if (lastTs >= settleBeforeMs) continue // not settled yet
      const prev = marks[sid]
      // Exact tuple compare: a same-ts part with a higher tiebreak still counts
      // as new, and an enriched-through session (cmpMark == 0) is dropped.
      if (prev && cmpMark({ ts: lastTs, id: strField(r.last_id) }, prev) <= 0) continue
    }
    eligible.push({ sid, lastTs })
  }
  // Oldest-settled first, so the longest-waiting sessions are enriched soonest;
  // a stable tiebreak on the id keeps selection deterministic.
  eligible.sort((a, b) => a.lastTs - b.lastTs || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0))
  const ids = eligible.map((e) => e.sid)
  return regime === 'ongoing' ? ids.slice(0, p.max_sessions_per_tick) : ids
}

/**
 * The per-session selector query: one row per session carrying the **precise
 * latest part tuple** `(last_ts, last_id)`. The timestamp *and* tiebreak of the
 * session's latest kept part, so the selector can compare the full mark, not the
 * timestamp alone ({@link selectSessions}). A plain `MAX(ts)` aggregate can't do
 * this: the tiebreak that wins at the max timestamp is not the global `MAX`
 * tiebreak, so we rank parts with `ROW_NUMBER() OVER (… ORDER BY ts DESC,
 * tiebreak DESC)` and keep `rn = 1`. The shared {@link contentFilterClauses} are
 * applied in the inner scan so a session that is *only* plumbing never appears
 * and the tuple reflects the latest part the proposer would actually read,
 * matching {@link sessionMark}, which is computed over the same filtered parts.
 *
 * @param {EnrichConfig} cfg
 * @returns {string}
 */
export function buildSessionAggregateQuery(cfg) {
  const anchor = cfg.anchor_key_column
  const ts = cfg.timestamp_column
  const tb = cfg.tiebreak_column
  const clauses = contentFilterClauses(cfg)
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  return (
    `SELECT ${anchor}, last_ts, last_id FROM (` +
    `SELECT ${anchor}, ${ts} AS last_ts, ${tb} AS last_id, ` +
    `ROW_NUMBER() OVER (PARTITION BY ${anchor} ORDER BY ${ts} DESC, ${tb} DESC) AS rn ` +
    `FROM ${cfg.source_dataset}${where}` +
    `) WHERE rn = 1`
  )
}

/**
 * Read **all** filtered parts of one session. The full transcript, no row
 * budget and no truncation (that was the defect). The shared content filter
 * keeps the proposer on signal, and the anchor value is `sqlQuote`'d (the only
 * interpolated value; column names are validated identifiers). Ordering is done
 * in JS ({@link orderSessionParts}) so the watermark and transcript are computed
 * from the same coerced tuples.
 *
 * @param {EnrichConfig} cfg
 * @param {string} sessionId
 * @returns {string}
 */
export function buildSessionPartsQuery(cfg, sessionId) {
  const cols = [...new Set([cfg.anchor_key_column, cfg.timestamp_column, cfg.tiebreak_column, cfg.id_column, cfg.text_column])]
  const clauses = [`${cfg.anchor_key_column} = '${sqlQuote(sessionId)}'`, ...contentFilterClauses(cfg)]
  return `SELECT ${cols.join(', ')} FROM ${cfg.source_dataset} WHERE ${clauses.join(' AND ')}`
}

/**
 * Order a session's parts into one coherent transcript. The gateway assigns
 * `message_created_at` in logical message order, so sorting by (timestamp,
 * row-unique tiebreak) reconstructs the conversation. The "DAG order" the
 * design calls for. Without coupling to `ai_gateway_messages`-specific columns
 * (`message_index` / `agent_id`), which a custom source may lack. Deterministic,
 * so re-runs over the same session yield the same transcript (hence the same
 * prospect ids).
 *
 * @ref LLP 0028#two-tiers-one-pipeline [implements]:
 *
 * @param {Record<string, unknown>[]} rows
 * @param {EnrichConfig} cfg
 * @returns {Record<string, unknown>[]}
 */
export function orderSessionParts(rows, cfg) {
  return [...rows].sort((a, b) => {
    const ta = toMillis(a[cfg.timestamp_column])
    const tb = toMillis(b[cfg.timestamp_column])
    if (ta !== tb) return ta - tb
    const ia = strField(a[cfg.tiebreak_column])
    const ib = strField(b[cfg.tiebreak_column])
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
}

/**
 * Stitch ordered parts into the transcript text + deduped provenance ids. Empty
 * parts are skipped; provenance keys are the (deduped) source `id_column` values
 * the curator later derefs.
 *
 * @param {Record<string, unknown>[]} orderedRows
 * @param {EnrichConfig} cfg
 * @returns {{ text: string, keys: string[] }}
 */
export function buildTranscript(orderedRows, cfg) {
  let text = ''
  /** @type {Set<string>} */
  const keys = new Set()
  for (const r of orderedRows) {
    const t = textField(r[cfg.text_column])
    if (t) text += (text ? '\n' : '') + t
    const idVal = strField(r[cfg.id_column])
    if (idVal) keys.add(idVal)
  }
  return { text, keys: [...keys] }
}

/**
 * The session's watermark: the (timestamp, tiebreak) tuple of its latest
 * ordered part. {@link orderSessionParts} sorts ascending, so the last row is
 * the max.
 *
 * @param {Record<string, unknown>[]} orderedRows
 * @param {EnrichConfig} cfg
 * @returns {SessionMark}
 */
export function sessionMark(orderedRows, cfg) {
  const last = orderedRows[orderedRows.length - 1]
  return { ts: toMillis(last[cfg.timestamp_column]), id: strField(last[cfg.tiebreak_column]) }
}

/**
 * Bound the T1 output to the JSON for `max_candidates` prospects (a full
 * session legitimately yields more knowledge than the old slice), with headroom.
 *
 * @param {EnrichConfig['propose']} p
 * @returns {number}
 */
function t1MaxTokens(p) {
  return Math.min(8192, 1024 + p.max_candidates * 256)
}

/**
 * Dedup proposed candidates into prospect rows keyed by a deterministic
 * {@link prospectId}. The same (extractor, version, anchor, type+label)
 * collapses to one row, so re-proposing the same content never duplicates.
 *
 * @param {Array<{ anchorKey: string, keys: string[], candidates: ReturnType<typeof parseProspects> }>} perSession
 * @param {EnrichConfig} cfg
 * @param {string} createdAt
 * @returns {Map<string, Record<string, unknown>>}
 */
export function collectProspectRows(perSession, cfg, createdAt) {
  /** @type {Map<string, Record<string, unknown>>} */
  const out = new Map()
  for (const { anchorKey, keys, candidates } of perSession) {
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
 * already persisted, making the append **idempotent across ticks and regimes**.
 * A session seen by both backfill and a later ongoing run (or a resumed session
 * re-extracted after it settles again) re-derives the same ids and appends
 * nothing new. Mirrors the graph projector's pre-write dedup (read the committed
 * id set, filter before append; only a missing dataset is benign there).
 *
 * @ref LLP 0028#idempotent-prospects [implements]:
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
 * @param {SessionMark} a
 * @param {SessionMark} b
 * @returns {number}
 */
function cmpMark(a, b) {
  if (a.ts < b.ts) return -1
  if (a.ts > b.ts) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/**
 * Coerce a source timestamp cell to epoch milliseconds. The query engine
 * surfaces a TIMESTAMP column (and a MAX over one) as a `Date`; spool/JSON
 * paths may surface an ISO string or a raw number. A missing/unparseable value
 * sorts first (0).
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
 * Daemon source for the **ongoing** regime: a refresh timer mirroring
 * `@hypaware/vector-search`'s `vector-search-refresh` (interval tick, in-flight
 * guard, unref'd handle, reload on config change). Each tick extracts a bounded
 * batch of settled sessions synchronously; the backfill regime is the
 * out-of-daemon command path.
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
      await runProposeTick(runtime, { regime: 'ongoing', deadlineMs: Date.now() + p.max_tick_ms })
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
          ? `propose settled sessions every ${runtime.config.propose.interval_minutes}m`
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
