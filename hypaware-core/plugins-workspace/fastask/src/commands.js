// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { parseControlFlags } from '../../../../src/core/cli/verb_codec.js'
import { buildOperationContext } from '../../../../src/core/cli/verb_command.js'
import { VerbUsageError } from '../../../../src/core/cli/verb_errors.js'
import { readStatusFile, resolveLiveControlRouteEndpointsFromStatus } from '../../../../src/core/daemon/status.js'
import { runRemoteVerb } from '../../../../src/core/mcp/remote_verb.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { executeQuerySql } from '../../../../src/core/query/sql.js'
import { canonicalOrigin, effectiveDefaultRemote } from '../../../../src/core/remote/builtin_remotes.js'
import { pluginStateDir } from '../../../../src/core/runtime/paths.js'
import { readLocalReplica, loadColdIndex } from './cold_replica.js'
import { credentialFingerprint } from './replica_sync.js'
import { DEFAULT_LEADS, MAX_LEADS, discover } from './discovery.js'
import { CURSOR_UNRESOLVABLE_NOTE, EVIDENCE_CONTRACT, EVIDENCE_TOOL, FRESHNESS_UNAVAILABLE_NOTE, NOT_FOUND_NOTE, callEvidence, evidenceSupport, fallbackEvidence, fetchEvidence, planEntries, skippedNote } from './evidence.js'
import { TEXT_SEARCH_LABEL, buildFastaskOutput, renderFastaskText } from './output.js'
import { connectRemote } from './remote_connect.js'
import { DISCOVER_ROUTE, REFRESH_ROUTE, SOURCE_NAME, TOKEN_FILE } from './replica_source.js'
import { createDefaultTargetResolver } from './replica_target.js'
import { discoverBySql } from './sql_discovery.js'
import { summaryLine } from './summary_line.js'
import { SCOPE_MISMATCH, createWarmEvidenceClient } from './warm_client.js'

/**
 * @import { CommandRunContext, VerbRegistration } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { DiscoveryResult, EvidenceMcpClient, EvidenceResult, FastaskSource, FastaskTextHit, FastaskTextSearch, FastaskTimings, ReplicaStatus, ReplicaTarget, WarmScope } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

export const PLUGIN_NAME = '@hypaware/fastask'
/** Question terms a no-anchor text search looks for, one search each. */
export const TEXT_SEARCH_TERMS = 3
/** Hits asked for per term, and kept in all. */
export const TEXT_SEARCH_LIMIT = 10
export const DEFAULT_BUDGET_MS = 2000
/** The longest budget a caller may ask for. */
export const MAX_BUDGET_MS = 120_000
export const EVIDENCE_NEEDS_REMOTE = 'query evidence reads a team server; pass --remote'

export const FASTASK_USAGE = 'hyp fastask "<question>" [--remote <target>] [--org <label>] [--repo <path>] [--file <path>]... [--budget-ms <n>] [--leads <n>] [--json]'
export const EVIDENCE_USAGE = "hyp query evidence --remote <target> [--org <label>] --session '<entry json>' [--session ...] [--max-text-chars <n>] [--deadline-ms <n>] [--roles user,assistant] [--part-types text] [--json]"

/** A usage problem: exit 2. */
class UsageError extends Error {}

/**
 * A fastask span. Attributes are counts, states and timings only: never the
 * question, terms, keys or text (LLP 0480#privacy).
 *
 * @template T
 * @param {string} name
 * @param {Record<string, string | number | boolean>} attrs
 * @param {(span: { setAttribute(key: string, value: string | number | boolean): unknown }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
function span(name, attrs, fn) {
  return withSpan(name, { [Attr.COMPONENT]: 'fastask', [Attr.OPERATION]: name, [Attr.PLUGIN]: PLUGIN_NAME, ...attrs }, fn, { component: 'fastask' })
}

/**
 * The parsed `hyp fastask` arguments.
 * @param {string[]} argv
 */
export function parseFastaskArgs(argv) {
  /** @type {{ question: string, remote: string | null, org: string | null, repo: string | null, files: string[], budgetMs: number, leads: number, json: boolean }} */
  const out = { question: '', remote: null, org: null, repo: null, files: [], budgetMs: DEFAULT_BUDGET_MS, leads: DEFAULT_LEADS, json: false }
  /** @type {string[]} */
  const words = []
  let flagsDone = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (flagsDone || !arg.startsWith('--')) {
      if (!flagsDone && arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown flag '${arg}'`)
      words.push(arg)
      continue
    }
    if (arg === '--') { flagsDone = true; continue }
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`)
      i++
      return next
    }
    switch (flag) {
      case '--remote': out.remote = value(); break
      case '--org': out.org = value(); break
      case '--repo': out.repo = value(); break
      case '--file': out.files.push(value()); break
      case '--budget-ms': out.budgetMs = integerIn(flag, value(), 100, MAX_BUDGET_MS); break
      case '--leads': out.leads = integerIn(flag, value(), 1, MAX_LEADS); break
      case '--json':
        if (inline !== undefined) throw new UsageError('--json takes no value')
        out.json = true
        break
      default: throw new UsageError(`unknown flag '${flag}'`)
    }
  }
  out.question = words.join(' ').trim()
  if (!out.question) throw new UsageError('a question is required')
  if (out.remote === '') throw new UsageError('--remote needs a target name')
  return out
}

/** @param {string} flag @param {string} raw @param {number} min @param {number} max */
function integerIn(flag, raw, min, max) {
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new UsageError(`${flag} must be an integer from ${min} to ${max}`)
  return n
}

/**
 * `hyp fastask "<question>"`: leads plus evidence from the best source that
 * can answer, within the budget. Exit 0 with leads or an explicit "no leads",
 * 1 when nothing could be read, 2 on usage.
 *
 * @ref LLP 0480#command [implements]: flags, budget and the 0/1/2 exit codes of hyp fastask
 * @ref LLP 0480#sources [implements]: warm replica, cold replica, team_server, local, in that order; every result names its source
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ pluginDir?: string, now?: () => number, fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<number>}
 */
export async function runFastask(argv, ctx, deps = {}) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write(`${FASTASK_USAGE}\n`)
    return 0
  }
  let args
  try {
    args = parseFastaskArgs(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    ctx.stderr.write(`hyp fastask: ${err.message}\nusage: ${FASTASK_USAGE}\n`)
    return 2
  }
  const now = deps.now ?? (() => performance.now())
  const started = now()
  const deadlineAt = started + args.budgetMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('fastask budget spent')), args.budgetMs)
  timer.unref?.()
  try {
    // @ref LLP 0480#observability [implements]: fastask.run carries source kind, path, leads, ambiguity and the timings
    return await span('fastask.run', { budget_ms: args.budgetMs, json: args.json }, (runSpan) =>
      runWithin(args, ctx, { ...deps, now, started, deadlineAt, signal: controller.signal, runSpan }))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {ReturnType<typeof parseFastaskArgs>} args
 * @param {CommandRunContext} ctx
 * @param {{ pluginDir?: string, now: () => number, started: number, deadlineAt: number, signal: AbortSignal, fetchImpl?: typeof fetch, runSpan: { setAttribute(key: string, value: string | number | boolean): unknown } }} run
 * @returns {Promise<number>}
 */
async function runWithin(args, ctx, run) {
  const { now, signal } = run
  const stateRoot = readObservabilityEnv(ctx.env).stateDir
  const pluginDir = run.pluginDir ?? pluginStateDir(stateRoot, PLUGIN_NAME)
  const repoRoot = path.resolve(ctx.cwd ?? process.cwd(), args.repo ?? '.')
  const repo = ownerRepoOf(repoRoot)
  /** @type {FastaskTimings} */
  const timings = { load: 0, connect: 0, discovery: 0, evidence: 0, total: 0 }
  const discoveryInput = { question: args.question, repo, repoRoot, files: args.files, leads: args.leads }

  const defaultTarget = effectiveDefaultRemote(ctx.config)
  const resolveDefault = createDefaultTargetResolver({ config: ctx.config, env: ctx.env, hypStateDir: stateRoot })
  const defaultLogin = await resolveDefault()
  const target = args.remote ?? (defaultLogin ? defaultTarget : null)

  /** @type {FastaskSource} */
  let source
  /** @type {DiscoveryResult} */
  let discovery
  /** @type {EvidenceResult | null} */
  let evidence = null
  /** @type {null | (() => Promise<EvidenceResult>)} */
  let readEvidence = null
  /** @type {Awaited<ReturnType<typeof connectRemote>> | null} */
  let remote = null

  /** Connect to the target once, timing the handshake as `connect`. */
  const connected = async () => {
    if (remote) return remote
    const t0 = now()
    remote = await connectRemote({ config: ctx.config, env: ctx.env, stateDir: stateRoot, target: /** @type {string} */ (target), org: args.org, signal, ...(run.fetchImpl ? { fetchImpl: run.fetchImpl } : {}) })
    timings.connect += now() - t0
    return remote
  }

  if (target === null) {
    // No remote configured or logged in: this machine's own captures.
    const t0 = now()
    const local = await span('fastask.discover', { source_kind: 'local' }, async (s) => {
      const r = await localDiscovery(ctx, discoveryInput)
      s.setAttribute('leads', r.result.leads.length)
      return r
    })
    timings.discovery = now() - t0
    source = { kind: 'local', path: 'local', remote: null, org: null, generation: null, watermark: null, watermark_age_s: null, replica_state: null, note: local.note }
    discovery = local.result
    readEvidence = () => localEvidence(ctx, discovery, run)
  } else {
    /** Why the replica cannot answer, when it cannot. @type {string | null} */
    let unusable = null
    /** @type {{ discovery: DiscoveryResult, source: FastaskSource, endpoint: string | null, token: string | null, scope: WarmScope } | null} */
    let replica = null
    if (target !== defaultTarget || !defaultLogin) unusable = `a replica is kept only for the default remote (${defaultTarget})`
    else if (args.org) unusable = 'the replica follows the login org; --org reads the server'
    else {
      const attempt = await span('fastask.discover', { source_kind: 'team_replica' }, async (s) => {
        const a = await replicaDiscovery({ stateRoot, pluginDir, target, login: defaultLogin, input: discoveryInput, timings, now, signal, fetchImpl: run.fetchImpl })
        s.setAttribute('usable', a.ok)
        if (a.ok) {
          s.setAttribute('path', a.source.path)
          s.setAttribute('leads', a.discovery.leads.length)
        }
        return a
      })
      if (attempt.ok) replica = attempt
      else unusable = attempt.reason
    }
    if (replica && replica.discovery.fallback) {
      unusable = `the team graph has no ${'touched'} edges (${replica.discovery.fallback.reason})`
      replica = null
    }
    if (replica) {
      const r = replica
      source = r.source
      discovery = r.discovery
      readEvidence = () => remoteEvidence({ discovery, run, warm: r.endpoint && r.token ? { endpoint: r.endpoint, token: r.token, scope: r.scope } : null, connected })
    } else {
      // team_server: discovery by SQL on the server, labeled slow.
      const conn = await connected()
      if (!conn.ok) {
        ctx.stderr.write(`hyp fastask: cannot read '${target}': ${conn.message}\n`)
        return 1
      }
      const client = conn.client
      const t0 = now()
      try {
        const sqlRun = await span('fastask.discover', { source_kind: 'team_server' }, async (s) => {
          const r = await discoverBySql({ runSql: (sql) => remoteSql(client, sql), ...discoveryInput })
          s.setAttribute('queries', r.queries)
          s.setAttribute('capped', r.capped)
          s.setAttribute('leads', r.result.leads.length)
          return r
        })
        discovery = sqlRun.result
      } catch (err) {
        ctx.stderr.write(`hyp fastask: team graph discovery on '${target}' failed: ${messageOf(err)}\n`)
        return 1
      }
      timings.discovery = now() - t0
      source = {
        kind: 'team_server', path: 'team_server', remote: target, org: args.org ?? defaultLogin?.org ?? null,
        generation: null, watermark: null, watermark_age_s: null, replica_state: null,
        note: `read the team graph from the server (slow): ${unusable}`,
      }
      readEvidence = () => remoteEvidence({ discovery, run, warm: null, connected })
    }
  }

  /** @type {FastaskTextSearch | null} */
  let textSearch = null
  if (discovery.no_anchor) {
    const t0 = now()
    const local = source.kind === 'local'
    textSearch = await span('fastask.text_search', { source_kind: source.kind }, async (s) => {
      const r = await runTextSearch({
        terms: discovery.terms.slice(0, TEXT_SEARCH_TERMS).map((t) => t.text),
        path: local ? 'local_grep' : 'grep_search',
        search: local ? localGrep(ctx) : remoteGrep(connected),
        deadlineAt: run.deadlineAt,
        now,
      })
      s.setAttribute('terms', r.terms.length)
      s.setAttribute('hits', r.hits.length)
      if (r.error) s.setAttribute('error_kind', 'text_search')
      return r
    })
    timings.discovery += now() - t0
  }

  if (discovery.leads.length > 0 && readEvidence) {
    const t0 = now()
    const read = readEvidence
    evidence = await span('fastask.evidence', { source_kind: source.kind }, async (s) => {
      const e = await read()
      s.setAttribute('entries', e.leads.length)
      s.setAttribute('path', e.path)
      s.setAttribute('fallback', e.path === 'query_sql')
      s.setAttribute('deadline_reached', e.deadline_reached)
      s.setAttribute('complete', e.complete)
      for (const status of new Set(e.leads.map((l) => l.status))) s.setAttribute(`status_${status}`, e.leads.filter((l) => l.status === status).length)
      if (e.failure) s.setAttribute('error_kind', e.failure.code)
      return e
    })
    timings.evidence = now() - t0
  }
  timings.total = now() - run.started
  const out = buildFastaskOutput({ question: args.question, source, discovery, evidence, timings, org: args.org, textSearch })
  run.runSpan.setAttribute('source_kind', source.kind)
  run.runSpan.setAttribute('source_path', source.path)
  run.runSpan.setAttribute('leads', out.leads.length)
  run.runSpan.setAttribute('ambiguous', out.ambiguous)
  for (const [phase, ms] of Object.entries(out.timings_ms)) run.runSpan.setAttribute(`timing_${phase}_ms`, ms)
  ctx.stdout.write(args.json ? `${JSON.stringify(out, null, 2)}\n` : renderFastaskText(out))
  // Nothing at all could be read for the leads found: an aggregate failure.
  if (evidence?.failure) {
    if (!args.json) ctx.stderr.write(`hyp fastask: evidence could not be read: ${evidence.failure.message}\n`)
    return 1
  }
  return 0
}

/**
 * The text search a question with no anchor falls back to: one search per
 * term (substring, as the server allows a caller), hits merged and
 * deduplicated up to the limit, within the budget.
 *
 * @ref LLP 0480#discovery [implements]: no anchor runs the text search (grep_search --remote, or local grep) and labels its hits "found by text search, not the graph"
 * @param {{ terms: string[], path: FastaskTextSearch['path'], search: (query: string) => Promise<any>, deadlineAt: number, now: () => number }} args
 * @returns {Promise<FastaskTextSearch>}
 */
async function runTextSearch({ terms, path: searchPath, search, deadlineAt, now }) {
  /** @type {FastaskTextSearch} */
  const out = { label: TEXT_SEARCH_LABEL, path: searchPath, terms, hits: [], truncated: false, error: null }
  const seen = new Set()
  try {
    for (const term of terms) {
      if (deadlineAt - now() <= 0) { out.error = 'the budget ran out before every term was searched'; break }
      const result = await search(term)
      if (!Array.isArray(result?.hits)) throw new Error('the text search returned no hits')
      if (result.truncated === true) out.truncated = true
      for (const hit of result.hits) {
        const key = `${hit.sessionId}\0${hit.partId ?? hit.messageId ?? ''}`
        if (seen.has(key)) continue
        if (out.hits.length === TEXT_SEARCH_LIMIT) { out.truncated = true; break }
        seen.add(key)
        out.hits.push(textHit(hit, term))
      }
    }
  } catch (err) {
    out.error = messageOf(err)
  }
  return out
}

/**
 * @param {any} hit a grep_search hit
 * @param {string} term
 * @returns {FastaskTextHit}
 */
function textHit(hit, term) {
  const match = Array.isArray(hit.matches) ? hit.matches[0] : null
  return {
    session_id: String(hit.sessionId),
    message_id: hit.messageId ?? null,
    part_id: hit.partId ?? null,
    message_created_at: hit.messageCreatedAt ?? null,
    term,
    column: typeof match?.column === 'string' ? match.column : null,
    snippet: typeof match?.snippet === 'string' ? match.snippet : null,
  }
}

/**
 * The server's `grep_search`, over the command's own connection to the
 * caller's remote.
 *
 * @param {() => Promise<Awaited<ReturnType<typeof connectRemote>>>} connected
 * @returns {(query: string) => Promise<any>}
 */
function remoteGrep(connected) {
  return async (query) => {
    const conn = await connected()
    if (!conn.ok) throw new Error(conn.message)
    const res = await conn.client.callTool('grep_search', { query, limit: TEXT_SEARCH_LIMIT })
    const text = Array.isArray(res?.content) ? res.content.find((/** @type {any} */ c) => c?.type === 'text')?.text : undefined
    if (res?.isError) throw new Error(typeof text === 'string' ? text : 'grep_search failed')
    return res?.structuredContent ?? (typeof text === 'string' ? JSON.parse(text) : null)
  }
}

/**
 * This machine's grep, through the registered `grep_search` verb.
 *
 * @param {CommandRunContext} ctx
 * @returns {(query: string) => Promise<any>}
 */
function localGrep(ctx) {
  return async (query) => {
    const verb = ctx.verbs?.getByTool('grep_search')
    if (!verb) throw new Error('local text search is not available (enable @hypaware/grep)')
    return verb.operation({ query, limit: TEXT_SEARCH_LIMIT }, buildOperationContext(ctx, 'auto'))
  }
}

/**
 * The replica, warm through the daemon or cold from disk.
 *
 * @param {{ stateRoot: string, pluginDir: string, target: string, login: ReplicaTarget, input: any, timings: FastaskTimings, now: () => number, signal: AbortSignal, fetchImpl?: typeof fetch }} args
 * @returns {Promise<{ ok: true, discovery: DiscoveryResult, source: FastaskSource, endpoint: string | null, token: string | null, scope: WarmScope } | { ok: false, reason: string }>}
 */
async function replicaDiscovery({ stateRoot, pluginDir, target, login, input, timings, now, signal, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const origin = canonicalOrigin(login.url)
  // What this call is for: the daemon answers only when its replica belongs
  // to the same remote, org and login (review r1 F1).
  // @ref LLP 0483#credential-change [implements]: every warm request carries the caller's resolved remote, org and credential fingerprint
  const credential = await credentialFingerprint(login)
  const scope = { target, origin: origin ?? '', org: login.org ?? null, credential_fp: credential }
  const endpoint = resolveLiveControlRouteEndpointsFromStatus({ stateRoot, route: DISCOVER_ROUTE }).find((e) => e.source === SOURCE_NAME)?.endpoint ?? null
  const token = endpoint ? readToken(pluginDir) : null
  if (endpoint && token) {
    const t0 = now()
    try {
      const res = await doFetch(`${endpoint}/_hypaware/${DISCOVER_ROUTE}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, scope }),
        signal,
      })
      const body = /** @type {any} */ (await res.json().catch(() => null))
      timings.discovery = now() - t0
      if (res.status === 200 && body?.result) {
        return { ok: true, discovery: body.result, source: replicaSource(target, 'warm', body.replica, null), endpoint, token, scope }
      }
      if (res.status === 503) return { ok: false, reason: unusableReason(body?.replica) }
      // The running daemon holds another remote's, org's or login's graph:
      // the files on disk are that replica too, so read the server instead.
      if (res.status === 409 && body?.error === 'scope_mismatch') return { ok: false, reason: scopeReason(body.reason) }
    } catch {
      // The daemon advertised the route but did not answer: read the replica cold.
    }
  }
  const local = origin ? await readLocalReplica(pluginDir, { target, origin, org: login.org, credential }, Date.now()) : null
  if (!local) return { ok: false, reason: 'the team graph has not been downloaded yet' }
  if (!local.servable || !local.dir) return { ok: false, reason: unusableReason({ state: local.state, reason: local.reason }) }
  try {
    const cold = await loadColdIndex(local.dir, signal)
    timings.load = cold.ms
    const t0 = now()
    const result = discover(cold.index, input)
    timings.discovery = now() - t0
    const view = { ...local.record, state: local.state }
    return { ok: true, discovery: result, source: replicaSource(target, 'cold', view, `daemon not running: loaded the team graph in ${cold.ms} ms`), endpoint: null, token: null, scope }
  } catch (err) {
    return { ok: false, reason: `the team graph could not be loaded: ${messageOf(err)}` }
  }
}

/** @param {unknown} reason why the daemon's replica does not match this call */
function scopeReason(reason) {
  const what = reason === 'org' ? 'organization' : reason === 'login' ? 'login' : 'remote'
  return `the running daemon's team graph belongs to another ${what}`
}

/**
 * @param {string} target @param {'warm' | 'cold'} pathKind @param {any} view @param {string | null} note
 * @returns {FastaskSource}
 */
function replicaSource(target, pathKind, view, note) {
  const watermarkMs = view?.watermark ? Date.parse(view.watermark) : NaN
  return {
    kind: 'team_replica',
    path: pathKind,
    remote: target,
    org: view?.org ?? null,
    generation: view?.generation ?? null,
    watermark: view?.watermark ?? null,
    watermark_age_s: typeof view?.watermark_age_s === 'number' ? view.watermark_age_s : Number.isNaN(watermarkMs) ? null : Math.max(0, Math.round((Date.now() - watermarkMs) / 1000)),
    replica_state: view?.state ?? null,
    note,
  }
}

/** @param {any} view */
function unusableReason(view) {
  const state = view?.state
  if (state === 'expired') return 'the team graph lease expired'
  if (state === 'withdrawn') return 'access to the team graph was withdrawn'
  if (state === 'unsupported') return 'the server does not offer team graph snapshots'
  if (view?.reason === 'login_changed') return 'the login changed since the team graph was last checked; the daemon re-checks it'
  if (state === 'unavailable') return 'the server has not published a team graph'
  return `the team graph is not ready${state ? ` (${state}${view?.reason ? `: ${view.reason}` : ''})` : ''}`
}

/**
 * Evidence from a team server: through the daemon on the warm path (a
 * server without the verb then falls back over a cold connection), else over
 * the command's own connection.
 *
 * @param {{ discovery: DiscoveryResult, run: { now: () => number, deadlineAt: number, signal: AbortSignal, fetchImpl?: typeof fetch }, warm: { endpoint: string, token: string, scope: WarmScope } | null, connected: () => Promise<Awaited<ReturnType<typeof connectRemote>>> }} args
 * @returns {Promise<EvidenceResult>}
 */
async function remoteEvidence({ discovery, run, warm, connected }) {
  const { now, deadlineAt, signal } = run
  const planned = planEntries(discovery.leads)
  const leadCount = planned.reduce((n, p) => Math.max(n, p.lead + 1), 0)
  if (warm) {
    const client = createWarmEvidenceClient({ endpoint: warm.endpoint, token: warm.token, scope: warm.scope, signal, ...(run.fetchImpl ? { fetchImpl: run.fetchImpl } : {}) })
    const answer = await callEvidence({ client, planned, leadCount, deadlineAt, signal, now })
    if (answer !== 'fallback' && !answer.failure?.message.startsWith(SCOPE_MISMATCH)) return answer
    const conn = await connected()
    if (!conn.ok) return failure(leadCount, conn.message)
    // The daemon's remote changed between discovery and evidence: read evidence
    // over this command's own connection to the caller's remote instead.
    if (answer !== 'fallback') return fetchEvidence({ client: conn.client, leads: discovery.leads, remainingMs: deadlineAt - now(), support: evidenceSupport(conn.tools), signal, now })
    return fallbackEvidence({ client: conn.client, planned, leadCount, deadlineAt, signal, now })
  }
  const conn = await connected()
  if (!conn.ok) return failure(leadCount, conn.message)
  return fetchEvidence({ client: conn.client, leads: discovery.leads, remainingMs: deadlineAt - now(), support: evidenceSupport(conn.tools), signal, now })
}

/**
 * @param {number} leadCount @param {string} message
 * @returns {EvidenceResult}
 */
function failure(leadCount, message) {
  return {
    path: 'session_evidence', label: null, complete: false, deadline_reached: false, received_through: null, read_path: null, retries: 0, resends: 0,
    failure: { code: 'transport', message },
    leads: Array.from({ length: leadCount }, () => ({ status: /** @type {const} */ ('error'), parts: [], continuation: null, note: message, skipped_parts: 0 })),
  }
}

/**
 * @param {EvidenceMcpClient} client @param {string} sql
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function remoteSql(client, sql) {
  const res = await client.callTool('query_sql', { sql })
  const text = Array.isArray(res?.content) ? res.content.find((/** @type {any} */ c) => c?.type === 'text')?.text : undefined
  if (res?.isError) throw new Error(typeof text === 'string' ? text : 'query_sql failed')
  const structured = res?.structuredContent ?? (typeof text === 'string' ? JSON.parse(text) : null)
  return Array.isArray(structured?.rows) ? structured.rows : []
}

/**
 * This machine's capture graph, when `@hypaware/context-graph` provides one.
 *
 * @param {CommandRunContext} ctx
 * @param {any} input
 * @returns {Promise<{ result: DiscoveryResult, note: string }>}
 */
async function localDiscovery(ctx, input) {
  const hasGraph = ctx.query.getDataset('node') && ctx.query.getDataset('edge')
  if (!hasGraph) {
    const empty = await discoverBySql({ runSql: async () => [], ...input })
    return { result: empty.result, note: 'local captures only; no capture graph here (enable @hypaware/context-graph and run hyp graph project)' }
  }
  const run = await discoverBySql({ runSql: (sql) => localSql(ctx, sql), ...input })
  return { result: run.result, note: 'local captures only' }
}

/**
 * Local evidence: the same per-session reads as the server fallback, through
 * local `query sql`.
 *
 * @param {CommandRunContext} ctx
 * @param {DiscoveryResult} discovery
 * @param {{ now: () => number, deadlineAt: number, signal: AbortSignal }} run
 * @returns {Promise<EvidenceResult>}
 */
async function localEvidence(ctx, discovery, run) {
  const planned = planEntries(discovery.leads)
  const leadCount = planned.reduce((n, p) => Math.max(n, p.lead + 1), 0)
  /** @type {EvidenceMcpClient} */
  const client = {
    async callTool(name, args) {
      if (name !== 'query_sql') throw new Error(`local evidence has no ${name}`)
      const rows = await localSql(ctx, String(args?.sql))
      return { structuredContent: { rows } }
    },
  }
  const result = await fallbackEvidence({ client, planned, leadCount, deadlineAt: run.deadlineAt, signal: run.signal, now: run.now })
  result.label = null
  for (const lead of result.leads) if (lead.note) lead.note = null
  return result
}

/** @param {CommandRunContext} ctx @param {string} sql */
async function localSql(ctx, sql) {
  const out = await executeQuerySql({
    query: sql,
    registry: ctx.query,
    storage: /** @type {any} */ (ctx.storage),
    refresh: 'auto',
    config: /** @type {any} */ (ctx.config),
    callerCwd: typeof ctx.cwd === 'string' && ctx.cwd.length > 0 ? ctx.cwd : null,
  })
  return out.rows
}

/** @param {string} pluginDir */
function readToken(pluginDir) {
  try {
    const token = fs.readFileSync(path.join(pluginDir, TOKEN_FILE), 'utf8').trim()
    return token || null
  } catch {
    return null
  }
}

/**
 * The caller's `owner/repo` from the repository's origin remote, github.com
 * only, as the activity graph keys repositories (LLP 0032).
 *
 * @param {string} start a directory inside the repository
 * @returns {string | null}
 */
export function ownerRepoOf(start) {
  let dir = start
  for (let i = 0; i < 64; i++) {
    const dotGit = path.join(dir, '.git')
    let stat
    try { stat = fs.statSync(dotGit) } catch { stat = null }
    if (stat) {
      let gitDir = dotGit
      if (stat.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? '')
        if (!m) return null
        gitDir = path.resolve(dir, m[1].trim())
        // A linked worktree keeps its remotes in the common directory.
        const common = readText(path.join(gitDir, 'commondir'))
        if (common) gitDir = path.resolve(gitDir, common.trim())
      }
      const config = readText(path.join(gitDir, 'config')) ?? ''
      const section = /\[remote "origin"\]([^[]*)/.exec(config)
      const url = section ? /^\s*url\s*=\s*(.+)$/m.exec(section[1])?.[1].trim() : undefined
      return url ? githubOwnerRepo(url) : null
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** @param {string} file */
function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

/** @param {string} url */
function githubOwnerRepo(url) {
  const m = /^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url)
  return m ? `${m[1]}/${m[2]}` : null
}

/**
 * `hyp graph replica status`: the replica's one-line state, from the running
 * daemon when there is one, else from the record on disk.
 *
 * @ref LLP 0480#command [implements]: graph replica status beside graph project and compact
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ pluginDir?: string, now?: () => number }} [deps]
 */
export async function runReplicaStatus(argv, ctx, deps = {}) {
  const json = argv.includes('--json')
  const extra = argv.filter((a) => a !== '--json')
  if (extra.length) {
    ctx.stderr.write(`hyp graph replica status: unexpected argument '${extra[0]}'\nusage: hyp graph replica status [--json]\n`)
    return 2
  }
  const now = deps.now ?? Date.now
  const stateRoot = readObservabilityEnv(ctx.env).stateDir
  const pluginDir = deps.pluginDir ?? pluginStateDir(stateRoot, PLUGIN_NAME)
  const live = resolveLiveControlRouteEndpointsFromStatus({ stateRoot, route: DISCOVER_ROUTE }).some((e) => e.source === SOURCE_NAME)
  if (live) {
    const details = liveDetails(stateRoot)
    if (details) {
      const line = typeof details.summary_line === 'string' ? details.summary_line : summaryLine(/** @type {ReplicaStatus} */ (details), { now: now() })
      ctx.stdout.write(json ? `${JSON.stringify({ daemon: 'running', ...pickStatus(details), summary_line: line }, null, 2)}\n` : `${line}\n`)
      return 0
    }
  }
  const target = await createDefaultTargetResolver({ config: ctx.config, env: ctx.env, hypStateDir: stateRoot })()
  if (!target) {
    const line = 'team graph: no default remote login, nothing is replicated (hyp remote login)'
    ctx.stdout.write(json ? `${JSON.stringify({ daemon: live ? 'running' : 'not_running', state: null, summary_line: line }, null, 2)}\n` : `${line}\n`)
    return 0
  }
  const origin = canonicalOrigin(target.url)
  const local = origin ? await readLocalReplica(pluginDir, { target: target.target, origin, org: target.org, credential: await credentialFingerprint(target) }, now()) : null
  const daemonNote = live ? '' : ' (daemon not running)'
  if (!local) {
    const line = `team graph: not downloaded yet${daemonNote}`
    ctx.stdout.write(json ? `${JSON.stringify({ daemon: live ? 'running' : 'not_running', state: null, target: target.target, summary_line: line }, null, 2)}\n` : `${line}\n`)
    return 0
  }
  const r = local.record
  const watermarkMs = r.watermark ? Date.parse(r.watermark) : NaN
  /** @type {ReplicaStatus} */
  const status = {
    state: local.state, reason: local.reason, servable: local.servable, target: r.target, origin: r.origin, org: r.org,
    generation: r.generation, watermark: r.watermark,
    watermark_age_s: Number.isNaN(watermarkMs) ? null : Math.max(0, Math.round((now() - watermarkMs) / 1000)),
    published_at: r.published_at, last_check: r.last_check, last_success: r.last_success, lease_expires_at: r.lease_expires_at,
    bytes_on_disk: await dirBytes(local.dir), rows: r.rows, refresh_in_progress: false, generation_dir: local.dir,
  }
  const line = `${summaryLine(status, { now: now() })}${daemonNote}`
  ctx.stdout.write(json ? `${JSON.stringify({ daemon: live ? 'running' : 'not_running', ...pickStatus(status), summary_line: line }, null, 2)}\n` : `${line}\n`)
  return 0
}

/** @param {string} stateRoot @returns {Record<string, any> | null} */
function liveDetails(stateRoot) {
  try {
    const status = readStatusFile(stateRoot)
    const source = (status?.sources ?? []).find((s) => s?.name === SOURCE_NAME)
    return source && typeof source.details === 'object' ? /** @type {Record<string, any>} */ (source.details) : null
  } catch {
    return null
  }
}

/** The status fields a caller reads; never paths, ports or tokens. @param {Record<string, any>} s */
function pickStatus(s) {
  const keys = ['state', 'reason', 'servable', 'target', 'origin', 'org', 'generation', 'watermark', 'watermark_age_s', 'published_at', 'last_check', 'last_success', 'lease_expires_at', 'bytes_on_disk', 'rows', 'refresh_in_progress']
  return Object.fromEntries(keys.filter((k) => k in s).map((k) => [k, s[k]]))
}

/** @param {string | null} dir */
async function dirBytes(dir) {
  if (!dir) return 0
  let total = 0
  for (const name of await fs.promises.readdir(dir).catch(() => [])) {
    const st = await fs.promises.stat(path.join(dir, name)).catch(() => null)
    if (st?.isFile()) total += st.size
  }
  return total
}

/**
 * `hyp graph replica refresh`: ask the running daemon to check now. The
 * check is coalesced with any in flight; the command does not wait for it.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ pluginDir?: string, fetchImpl?: typeof fetch }} [deps]
 */
export async function runReplicaRefresh(argv, ctx, deps = {}) {
  if (argv.length) {
    ctx.stderr.write(`hyp graph replica refresh: unexpected argument '${argv[0]}'\nusage: hyp graph replica refresh\n`)
    return 2
  }
  const stateRoot = readObservabilityEnv(ctx.env).stateDir
  const pluginDir = deps.pluginDir ?? pluginStateDir(stateRoot, PLUGIN_NAME)
  const endpoint = resolveLiveControlRouteEndpointsFromStatus({ stateRoot, route: REFRESH_ROUTE }).find((e) => e.source === SOURCE_NAME)?.endpoint
  const token = endpoint ? readToken(pluginDir) : null
  if (!endpoint || !token) {
    ctx.stderr.write('hyp graph replica refresh: the daemon is not running; the replica is checked when it starts (hyp daemon start)\n')
    return 1
  }
  try {
    const res = await (deps.fetchImpl ?? globalThis.fetch)(`${endpoint}/_hypaware/${REFRESH_ROUTE}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    })
    if (res.status !== 202) {
      ctx.stderr.write(`hyp graph replica refresh: the daemon refused the request (HTTP ${res.status})\n`)
      return 1
    }
  } catch (err) {
    ctx.stderr.write(`hyp graph replica refresh: the daemon did not answer: ${messageOf(err)}\n`)
    return 1
  }
  ctx.stdout.write('team graph: check started; see hyp graph replica status\n')
  return 0
}

/**
 * The `query evidence` verb: the server's `session_evidence` tool, CLI only.
 * Its CLI is the command below (the codec cannot take repeated JSON
 * `--session` values); the registration keeps the tool slot.
 *
 * @type {VerbRegistration}
 */
export const queryEvidenceVerb = {
  name: 'query evidence',
  plugin: PLUGIN_NAME,
  category: 'explore-share',
  audience: 'everyday',
  tool: EVIDENCE_TOOL,
  exposure: 'cli-only',
  summary: 'Read original session text from a team server (session_evidence); used by fastask follow-ups',
  authClass: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      contract: { type: 'string', description: 'Contract version', default: EVIDENCE_CONTRACT },
      sessions: { type: 'array', items: { type: 'string' }, description: 'Entries, each a JSON object string' },
    },
    required: ['sessions'],
  },
  operation() {
    throw new VerbUsageError(EVIDENCE_NEEDS_REMOTE)
  },
  render(result, controls) {
    return { stdout: controls.json || controls.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : renderEvidenceText(result), stderr: '' }
  },
}

/**
 * `hyp query evidence --remote <t> --session '<entry json>'...`: the runnable
 * follow-up and continuation fastask prints. Without `--remote` it is a usage
 * error.
 *
 * @ref LLP 0480#command [implements]: query evidence forwards to the server tool; without --remote it exits 2
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runQueryEvidence(argv, ctx) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write(`${EVIDENCE_USAGE}\n`)
    return 0
  }
  const usage = (/** @type {string} */ msg) => {
    ctx.stderr.write(`hyp query evidence: ${msg}\nusage: ${EVIDENCE_USAGE}\n`)
    return 2
  }
  const ctrl = parseControlFlags(argv)
  if (!ctrl.ok) return usage(ctrl.error)
  /** @type {string[]} */
  const sessions = []
  /** @type {Record<string, unknown>} */
  const params = { contract: EVIDENCE_CONTRACT }
  const rest = ctrl.rest
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg
    const value = () => (eq !== -1 && arg.startsWith('--') ? arg.slice(eq + 1) : rest[++i])
    if (flag === '--session') {
      const v = value()
      if (v === undefined) return usage('--session needs an entry')
      try {
        const parsed = JSON.parse(v)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.session_id !== 'string') return usage('--session must be a JSON object with a session_id')
      } catch {
        return usage('--session must be a JSON object')
      }
      sessions.push(v)
    } else if (flag === '--max-text-chars' || flag === '--deadline-ms') {
      const v = Number(value())
      if (!Number.isSafeInteger(v) || v < 1) return usage(`${flag} must be a positive integer`)
      params[flag === '--max-text-chars' ? 'max_text_chars' : 'deadline_ms'] = v
    } else if (flag === '--roles' || flag === '--part-types') {
      const v = value()
      if (!v) return usage(`${flag} needs a value`)
      params[flag === '--roles' ? 'roles' : 'part_types'] = v.split(',').map((s) => s.trim()).filter(Boolean)
    } else {
      return usage(`unexpected argument '${arg}'`)
    }
  }
  if (ctrl.controls.remote === undefined) return usage(EVIDENCE_NEEDS_REMOTE)
  if (sessions.length === 0) return usage('at least one --session is required')
  params.sessions = sessions
  const target = ctrl.controls.remote === '' ? effectiveDefaultRemote(ctx.config) : ctrl.controls.remote
  const result = /** @type {any} */ (await runRemoteVerb({ verb: queryEvidenceVerb, params, target, org: ctrl.controls.org, ctx }))
  if (!result?.ok) {
    ctx.stderr.write(`hyp query evidence: ${result?.error ?? 'failed'}\n`)
    return result?.exitCode ?? 1
  }
  const body = result.result
  const wantsJson = ctrl.controls.json === true || ctrl.controls.format === 'json'
  ctx.stdout.write(wantsJson ? `${JSON.stringify(body, null, 2)}\n` : renderEvidenceText(body))
  return 0
}

/** @param {any} body */
export function renderEvidenceText(body) {
  /** @type {string[]} */
  const lines = []
  for (const s of Array.isArray(body?.sessions) ? body.sessions : []) {
    const code = s.error?.code
    const reason = s.status === 'not_found' ? NOT_FOUND_NOTE
      : code === 'freshness_unavailable' ? FRESHNESS_UNAVAILABLE_NOTE
        : code === 'cursor_unresolvable' ? CURSOR_UNRESOLVABLE_NOTE
          : s.error?.message ?? null
    const skipped = Number.isSafeInteger(s.skipped_parts) && s.skipped_parts > 0 ? skippedNote(s.skipped_parts) : null
    const note = [reason, skipped].filter(Boolean).join('; ')
    lines.push(`${s.session_id}: ${s.status}${note ? ` - ${note}` : ''}`)
    for (const p of Array.isArray(s.parts) ? s.parts : []) {
      lines.push(`  ${p.role} ${p.message_created_at}: ${String(p.content_text ?? '').replace(/\s+/g, ' ').trim()}${p.text_truncated ? ' [cut]' : ''}`)
    }
    if (s.next_cursor) lines.push('  more: pass the same --session with "cursor" set to the next_cursor in --json output')
  }
  return `${lines.join('\n')}\n`
}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}
