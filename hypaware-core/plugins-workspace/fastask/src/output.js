// @ts-check

/**
 * @import { DiscoveryResult, EvidenceEntry, EvidenceResult, FastaskFollowup, FastaskOutput, FastaskOutputLead, FastaskSource, FastaskTextSearch, FastaskTimings, LeadEvidence } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

/**
 * The `fastask/1` document and its human rendering (LLP 0480#output). Leads,
 * not an answer: per lead the session, why it was chosen, a few excerpts and
 * coverage notes, then follow-up commands built from the same arguments, then
 * one freshness line. Every command here must run as printed; the tests parse
 * each one with the real verb parsers.
 */

export const FASTASK_CONTRACT = 'fastask/1'
/** Excerpts shown per lead in the human rendering. */
export const HUMAN_EXCERPTS = 3
/** Characters of one excerpt line in the human rendering. */
export const HUMAN_EXCERPT_CHARS = 240
/** Text search hits shown in the human rendering. */
export const HUMAN_TEXT_HITS = 5
/** How no-anchor text search hits are labeled (LLP 0480#discovery). */
export const TEXT_SEARCH_LABEL = 'found by text search, not the graph'

/**
 * @ref LLP 0480#output [implements]: the fastask/1 shape; timings separate load, connect, discovery, evidence and total
 * @param {{
 *   question: string,
 *   source: FastaskSource,
 *   discovery: DiscoveryResult,
 *   evidence: EvidenceResult | null,
 *   timings: FastaskTimings,
 *   org?: string | null,
 *   textSearch?: FastaskTextSearch | null,
 * }} args
 * @returns {FastaskOutput}
 */
export function buildFastaskOutput({ question, source, discovery, evidence, timings, org = null, textSearch = null }) {
  const remote = source.kind === 'local' ? null : source.remote
  // Follow-ups read the same scope the command read: its remote and its --org.
  const scope = remote ? { remote, org } : null
  const fallback = evidence?.path === 'query_sql'
  /** @type {FastaskOutputLead[]} */
  const leads = discovery.leads.map((lead, i) => ({
    session_id: lead.session_id,
    rank: lead.rank,
    group: lead.group,
    why: lead.why.map((w) => ({
      anchor: { type: w.anchor.type, key: w.anchor.key, match: w.anchor.match, proven: w.anchor.proven },
      edge: w.edge,
      touched_at: w.touched_at,
    })),
    session: lead.session,
    evidence: evidence && evidence.leads[i] ? leadEvidenceOut(evidence.leads[i], scope) : null,
  }))
  const truncated = discovery.coverage.truncated
  return {
    contract: FASTASK_CONTRACT,
    question,
    source,
    leads,
    ambiguous: discovery.ambiguous,
    followups: followups({ scope, discovery, question, fallback }),
    text_search: textSearch,
    coverage: {
      graph_visits: discovery.coverage.visits,
      graph_truncated: truncated,
      unresolved_edges_met: discovery.coverage.unresolved_edges_met,
      evidence_received_through: evidence?.received_through ?? null,
      evidence_read_path: evidence?.read_path ?? null,
      evidence_path: evidence?.path ?? null,
      evidence_label: evidence?.label ?? null,
      evidence_failure: evidence?.failure ?? null,
      partial: truncated || (evidence !== null && !evidence.complete),
    },
    timings_ms: {
      load: Math.round(timings.load),
      connect: Math.round(timings.connect),
      discovery: Math.round(timings.discovery),
      evidence: Math.round(timings.evidence),
      total: Math.round(timings.total),
    },
  }
}

/**
 * @param {LeadEvidence} evidence
 * @param {{ remote: string, org: string | null } | null} scope
 * @returns {NonNullable<FastaskOutputLead['evidence']>}
 */
function leadEvidenceOut(evidence, scope) {
  return {
    status: evidence.status,
    parts: evidence.parts,
    note: evidence.note,
    skipped_parts: evidence.skipped_parts,
    continuation: evidence.continuation && scope ? evidenceCommand(scope.remote, evidence.continuation, scope.org) : null,
  }
}

/**
 * The command that reads one evidence entry again: with its cursor, the next
 * page; without one, the entry from its start.
 *
 * @param {string} remote
 * @param {EvidenceEntry | { session_id: string }} entry
 * @param {string | null} [org] the command's --org, carried so the follow-up reads the same organization
 */
export function evidenceCommand(remote, entry, org = null) {
  return `hyp query evidence${scopeFlags({ remote, org })} --session ${shellQuote(JSON.stringify(entry))} --json`
}

/** @param {{ remote: string, org: string | null } | null} scope */
export function scopeFlags(scope) {
  if (!scope) return ''
  return ` --remote ${shellQuote(scope.remote)}${scope.org ? ` --org ${shellQuote(scope.org)}` : ''}`
}

/**
 * Follow-ups, generated from the command's own arguments: read the top
 * lead's whole conversation (through the verb, or through `query sql` on a
 * server without it), and search beyond the graph. With no anchor at all the
 * text search comes first.
 *
 * @param {{ scope: { remote: string, org: string | null } | null, discovery: DiscoveryResult, question: string, fallback: boolean }} args
 * @returns {FastaskFollowup[]}
 */
function followups({ scope, discovery, question, fallback }) {
  const terms = discovery.terms.map((t) => t.text).slice(0, 3).join(' ') || question
  const remoteFlag = scopeFlags(scope)
  const search = { why: 'search beyond the graph', command: `hyp query grep${remoteFlag} ${shellQuote(terms)}` }
  /** @type {FastaskFollowup[]} */
  const out = []
  const top = discovery.leads[0]
  if (top) {
    const command = scope && !fallback
      ? evidenceCommand(scope.remote, { session_id: top.session_id }, scope.org)
      : `hyp query sql${remoteFlag} ${shellQuote(conversationSql(top.session_id))}`
    out.push({ why: 'read the whole conversation', command })
  }
  if (discovery.no_anchor) out.unshift(search)
  else out.push(search)
  return out
}

/** @param {string} sessionId */
function conversationSql(sessionId) {
  return `SELECT message_created_at, role, part_type, content_text FROM ai_gateway_messages WHERE session_id = '${sessionId.replace(/'/g, "''")}' ORDER BY message_created_at, message_index, part_index LIMIT 200`
}

/**
 * Quote one argument for a POSIX shell: single quotes, with an embedded
 * quote closed, escaped and reopened.
 * @param {string} value
 */
export function shellQuote(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The human rendering: a short list of leads, the follow-ups, and one
 * freshness line.
 *
 * @param {FastaskOutput} out
 * @param {{ now?: number }} [opts]
 * @returns {string}
 */
export function renderFastaskText(out, { now = Date.now() } = {}) {
  /** @type {string[]} */
  const lines = []
  // Every result names the source that answered (LLP 0480#sources).
  lines.push(`source: ${out.source.kind} (${out.source.path})${out.source.remote ? ` on ${out.source.remote}` : ''}${out.source.note ? ` - ${out.source.note}` : ''}`)
  if (out.leads.length === 0) lines.push('No leads: nothing in the team graph matched this question.')
  if (out.text_search) lines.push(...textSearchLines(out.text_search))
  if (out.ambiguous) lines.push('Ambiguous: several files match; leads from each are shown.')
  for (const lead of out.leads) {
    const s = lead.session
    const where = [s.first_seen, s.cwd, s.git_branch, s.client_name].filter(Boolean).join('  ')
    lines.push(`${lead.rank}. ${lead.session_id}  ${where}`)
    for (const w of lead.why.slice(0, 2)) {
      lines.push(`   why: ${w.anchor.key} (${w.anchor.match}${w.anchor.proven ? '' : ', unproven'}) ${w.edge}${w.touched_at ? ` at ${w.touched_at}` : ''}`)
    }
    const ev = lead.evidence
    if (!ev) continue
    lines.push(`   evidence: ${ev.status}${ev.note ? ` - ${ev.note}` : ''}`)
    for (const part of ev.parts.slice(0, HUMAN_EXCERPTS)) {
      const text = oneLine(part.content_text ?? '')
      lines.push(`     ${part.role} ${part.message_created_at ?? ''}: ${text}${part.text_truncated ? ' [cut]' : ''}`)
    }
    if (ev.continuation) lines.push(`   more: ${ev.continuation}`)
  }
  if (out.coverage.evidence_label) lines.push(`Evidence read through query_sql: ${out.coverage.evidence_label} (slower, same rows).`)
  if (out.coverage.evidence_failure) lines.push(`Evidence not read: ${out.coverage.evidence_failure.message}`)
  if (out.followups.length) {
    lines.push('Follow-ups:')
    for (const f of out.followups) lines.push(`  ${f.why}: ${f.command}`)
  }
  lines.push(freshnessLine(out, now))
  return `${lines.join('\n')}\n`
}

/** @param {FastaskTextSearch} search */
function textSearchLines(search) {
  const terms = search.terms.map((t) => `'${t}'`).join(', ')
  if (search.error) return [`Text search for ${terms || 'the question'} did not run: ${search.error}`]
  if (search.hits.length === 0) return [`Text search for ${terms}: no matches.`]
  const lines = [`${search.hits.length}${search.truncated ? '+' : ''} ${search.hits.length === 1 ? 'match' : 'matches'} for ${terms}, ${search.label}:`]
  for (const hit of search.hits.slice(0, HUMAN_TEXT_HITS)) {
    lines.push(`  ${hit.session_id}  ${hit.message_created_at ?? ''}: ${oneLine(hit.snippet ?? '')}`)
  }
  return lines
}

/**
 * @param {FastaskOutput} out
 * @param {number} now
 */
function freshnessLine(out, now) {
  if (out.source.kind === 'local') return 'local captures only'
  const evidenceThrough = out.coverage.evidence_received_through ? `evidence received through ${out.coverage.evidence_received_through}` : 'evidence freshness unknown'
  // The server's own graph, read now: there is no replica age to report.
  if (out.source.kind === 'team_server') return `team graph read from the server just now, ${evidenceThrough}`
  const graph = out.source.watermark
    ? `team graph as of ${out.source.watermark} (${age(out.source.watermark_age_s ?? Math.max(0, Math.round((now - Date.parse(out.source.watermark)) / 1000)))})`
    : 'team graph age unknown'
  return `${graph}, ${evidenceThrough}`
}

/** @param {number} seconds */
function age(seconds) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 48 * 3600) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** @param {string} text */
function oneLine(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > HUMAN_EXCERPT_CHARS ? `${flat.slice(0, HUMAN_EXCERPT_CHARS - 1)}…` : flat
}
