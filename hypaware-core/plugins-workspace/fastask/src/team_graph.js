// @ts-check

import path from 'node:path'

import { buildOperationContext } from '../../../../src/core/cli/verb_command.js'
import { resolveLiveControlRouteEndpointsFromStatus } from '../../../../src/core/daemon/status.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { canonicalOrigin, effectiveDefaultRemote } from '../../../../src/core/remote/builtin_remotes.js'
import { pluginStateDir } from '../../../../src/core/runtime/paths.js'
import { loadColdIndex, readLocalReplica } from './cold_replica.js'
import { PLUGIN_NAME, localSql, messageOf, ownerRepoOf, readToken, remoteSql, replicaSource, scopeReason, unusableReason, warmScope } from './commands.js'
import { DEFAULT_LEADS, DEFAULT_NEIGHBORS, MAX_LEADS, MAX_NEIGHBORS, MAX_STARTS, MAX_TERMS, MAX_VISITS, discover, neighbors } from './discovery.js'
import { evidenceCommand, scopeFlags, shellQuote } from './output.js'
import { connectRemote } from './remote_connect.js'
import { DISCOVER_ROUTE, NEIGHBORS_ROUTE, SOURCE_NAME } from './replica_source.js'
import { createDefaultTargetResolver } from './replica_target.js'
import { discoverBySql } from './sql_discovery.js'
import { DEFAULT_HITS_PER_SESSION, DEFAULT_HIT_CHARS, MAX_HITS_PER_SESSION, MAX_SEARCH_SESSIONS, searchSessions } from './team_search.js'
import { MAX_TEXT_CHARS } from './evidence.js'

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { DiscoveryResult, FastaskSource, GraphIndex, Neighbor, NeighborsResult, NeighborsStart, ReplicaTarget, SearchResult, TeamGraphArgs } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

/**
 * The agent-callable team-graph operations (LLP 0487#decision):
 * `query team-graph discover`, `neighbors` and `search`. Each reads the best
 * source that can answer, the way `hyp fastask` does: the replica warm through
 * the daemon or cold from disk, the team server, or local captures, and its
 * `--json` names that source with the replica state and the watermark age.
 * Every result carries the ids the next operation takes, and prints the
 * commands that take them, so an agent can chain discover, neighbors, search
 * and `query evidence` on its own path.
 */

export const DISCOVER_CONTRACT = 'team-graph-discover/1'
export const NEIGHBORS_CONTRACT = 'team-graph-neighbors/1'
export const SEARCH_CONTRACT = 'team-graph-search/1'

export const DISCOVER_USAGE = 'hyp query team-graph discover <term>... [--term <t>]... [--file <path>]... [--repo <path>] [--limit <n>] [--offset <n>] [--remote <target>] [--org <label>] [--json]'
export const NEIGHBORS_USAGE = 'hyp query team-graph neighbors <node-id>... [--key <natural key>]... [--direction in|out|both] [--edge-type <t>]... [--limit <n>] [--max-visits <n>] [--remote <target>] [--org <label>] [--json]'
export const SEARCH_USAGE = 'hyp query team-graph search --session <session id>... <term>... [--term <t>]... [--hits <n>] [--chars <n>] [--remote <target>] [--org <label>] [--json]'

/** Start nodes a team_server or local neighbors call reads: each is one graph query. */
export const QUERY_STARTS = 8
/** The server's verb this operation answers through on the team_server and local paths. */
export const GRAPH_NEIGHBORS_VERB = 'query graph neighbors'
const GRAPH_NEIGHBORS_TOOL = 'graph_neighbors'

/** A usage problem: exit 2. */
class UsageError extends Error {}

/**
 * Flags shared by the three commands, plus each command's own: a `list` flag
 * repeats, a `value` flag takes one string, a `number` flag one integer in
 * range. Non-flag words are positional.
 *
 * @param {string[]} argv
 * @param {{ lists?: string[], values?: string[], numbers?: Record<string, [number, number]> }} spec
 * @returns {TeamGraphArgs}
 */
export function parseTeamGraphArgs(argv, spec) {
  /** @type {TeamGraphArgs} */
  const out = { positional: [], remote: null, org: null, json: false, lists: {}, values: {}, numbers: {} }
  for (const name of spec.lists ?? []) out.lists[name] = []
  let flagsDone = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (flagsDone || !arg.startsWith('--')) {
      if (!flagsDone && arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown flag '${arg}'`)
      out.positional.push(arg)
      continue
    }
    if (arg === '--') { flagsDone = true; continue }
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const name = flag.slice(2)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`)
      i++
      return next
    }
    if (flag === '--json') {
      if (inline !== undefined) throw new UsageError('--json takes no value')
      out.json = true
    } else if (flag === '--remote') {
      out.remote = value()
      if (!out.remote) throw new UsageError('--remote needs a target name')
    } else if (flag === '--org') {
      out.org = value()
    } else if (spec.lists?.includes(name)) {
      out.lists[name].push(value())
    } else if (spec.values?.includes(name)) {
      out.values[name] = value()
    } else if (spec.numbers && Object.hasOwn(spec.numbers, name)) {
      const raw = value()
      const [min, max] = spec.numbers[name]
      const n = Number(raw)
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new UsageError(`${flag} must be an integer from ${min} to ${max}`)
      out.numbers[name] = n
    } else {
      throw new UsageError(`unknown flag '${flag}'`)
    }
  }
  return out
}

/**
 * Where a call can be answered, before trying: no remote means local
 * captures; a replica is kept only for the default remote's login org, so
 * another remote or an explicit `--org` reads the server.
 *
 * @param {CommandRunContext} ctx
 * @param {TeamGraphArgs} args
 * @param {{ pluginDir?: string }} deps
 */
async function selectTarget(ctx, args, deps) {
  const stateRoot = readObservabilityEnv(ctx.env).stateDir
  const pluginDir = deps.pluginDir ?? pluginStateDir(stateRoot, PLUGIN_NAME)
  const defaultTarget = effectiveDefaultRemote(ctx.config)
  const login = await createDefaultTargetResolver({ config: ctx.config, env: ctx.env, hypStateDir: stateRoot })()
  const target = args.remote ?? (login ? defaultTarget : null)
  /** @type {string | null} */
  let unusable = null
  if (target !== null) {
    if (target !== defaultTarget || !login) unusable = `a replica is kept only for the default remote (${defaultTarget})`
    else if (args.org) unusable = 'the replica follows the login org; --org reads the server'
  }
  return { stateRoot, pluginDir, target, login, unusable }
}

/**
 * The replica, warm through the daemon's `route` or cold from disk, with the
 * caller's scope (review r1 F1): the daemon answers only for the remote, org
 * and login its replica was confirmed for, and so does the record on disk.
 *
 * @template T
 * @param {{ stateRoot: string, pluginDir: string, target: string, login: ReplicaTarget, route: string, body: Record<string, unknown>, cold: (index: GraphIndex) => T, signal?: AbortSignal, fetchImpl?: typeof fetch }} args
 * @returns {Promise<{ ok: true, result: T, source: FastaskSource } | { ok: false, reason: string }>}
 */
async function fromReplica({ stateRoot, pluginDir, target, login, route, body, cold, signal, fetchImpl }) {
  const scope = await warmScope(target, login)
  const endpoint = resolveLiveControlRouteEndpointsFromStatus({ stateRoot, route }).find((e) => e.source === SOURCE_NAME)?.endpoint ?? null
  const token = endpoint ? readToken(pluginDir) : null
  if (endpoint && token) {
    try {
      const res = await (fetchImpl ?? globalThis.fetch)(`${endpoint}/_hypaware/${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, scope }),
        signal,
      })
      const answer = /** @type {any} */ (await res.json().catch(() => null))
      if (res.status === 200 && answer?.result) return { ok: true, result: answer.result, source: replicaSource(target, 'warm', answer.replica, null) }
      if (res.status === 503) return { ok: false, reason: unusableReason(answer?.replica) }
      if (res.status === 409 && answer?.error === 'scope_mismatch') return { ok: false, reason: scopeReason(answer.reason) }
    } catch {
      // The daemon advertised the route but did not answer: read the replica cold.
    }
  }
  const origin = canonicalOrigin(login.url)
  const local = origin ? await readLocalReplica(pluginDir, { target, origin, org: login.org, credential: scope.credential_fp }, Date.now()) : null
  if (!local) return { ok: false, reason: 'the team graph has not been downloaded yet' }
  if (!local.servable || !local.dir) return { ok: false, reason: unusableReason({ state: local.state, reason: local.reason }) }
  try {
    const loaded = await loadColdIndex(local.dir, signal)
    const view = { ...local.record, state: local.state }
    return { ok: true, result: cold(loaded.index), source: replicaSource(target, 'cold', view, `daemon not running: loaded the team graph in ${loaded.ms} ms`) }
  } catch (err) {
    return { ok: false, reason: `the team graph could not be loaded: ${messageOf(err)}` }
  }
}

/**
 * @param {string | null} target
 * @param {string | null} org
 * @param {string} note
 * @returns {FastaskSource}
 */
function serverSource(target, org, note) {
  return { kind: 'team_server', path: 'team_server', remote: target, org, generation: null, watermark: null, watermark_age_s: null, replica_state: null, note }
}

/** @param {string} note @returns {FastaskSource} */
function localSource(note) {
  return { kind: 'local', path: 'local', remote: null, org: null, generation: null, watermark: null, watermark_age_s: null, replica_state: null, note }
}

/**
 * A span per operation: counts, states and timings only, never terms, keys
 * or text (LLP 0480#privacy).
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
 * Parses, runs and prints one operation, mapping usage errors to exit 2.
 *
 * @param {string} name e.g. `discover`
 * @param {string} usage
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {(argv: string[]) => TeamGraphArgs} parse
 * @param {(args: TeamGraphArgs) => Promise<number>} run
 */
async function command(name, usage, argv, ctx, parse, run) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write(`${usage}\n`)
    return 0
  }
  let args
  try {
    args = parse(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    ctx.stderr.write(`hyp query team-graph ${name}: ${err.message}\nusage: ${usage}\n`)
    return 2
  }
  return run(args)
}

// ---------------------------------------------------------------------------
// discover

/**
 * `hyp query team-graph discover <term>...`: Files of the team graph whose
 * keys match the agent's terms or `--file` paths, and the sessions that
 * touched them, paged.
 *
 * @ref LLP 0487#decision [implements]: discover with explicit terms and paging, over the warm route, the cold replica, the server or local captures
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ pluginDir?: string, fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<number>}
 */
export function runTeamGraphDiscover(argv, ctx, deps = {}) {
  const parse = (/** @type {string[]} */ a) => {
    const args = parseTeamGraphArgs(a, { lists: ['term', 'file'], values: ['repo'], numbers: { limit: [1, MAX_LEADS], offset: [0, MAX_VISITS] } })
    const terms = [...args.positional, ...args.lists.term]
    if (terms.length === 0 && args.lists.file.length === 0) throw new UsageError('give at least one term or --file')
    if (terms.length > MAX_TERMS) throw new UsageError(`at most ${MAX_TERMS} terms`)
    return args
  }
  return command('discover', DISCOVER_USAGE, argv, ctx, parse, (args) =>
    span('fastask.team_graph.discover', { json: args.json }, async (s) => {
      const terms = [...args.positional, ...args.lists.term]
      const repoRoot = path.resolve(ctx.cwd ?? process.cwd(), args.values.repo ?? '.')
      const input = {
        question: '', terms, files: args.lists.file, repo: ownerRepoOf(repoRoot), repoRoot,
        leads: args.numbers.limit ?? DEFAULT_LEADS, offset: args.numbers.offset ?? 0,
      }
      const sel = await selectTarget(ctx, args, deps)
      /** @type {FastaskSource} */
      let source
      /** @type {DiscoveryResult} */
      let result
      if (sel.target === null) {
        const hasGraph = ctx.query.getDataset('node') && ctx.query.getDataset('edge')
        result = (await discoverBySql({ runSql: hasGraph ? (sql) => localSql(ctx, sql) : async () => [], ...input })).result
        source = localSource(hasGraph ? 'local captures only' : 'local captures only; no capture graph here (enable @hypaware/context-graph and run hyp graph project)')
      } else {
        let unusable = sel.unusable
        /** @type {{ result: DiscoveryResult, source: FastaskSource } | null} */
        let replica = null
        if (!unusable && sel.login) {
          const r = await fromReplica({ ...sel, target: sel.target, login: sel.login, route: DISCOVER_ROUTE, body: input, cold: (index) => discover(index, input), fetchImpl: deps.fetchImpl })
          if (r.ok && r.result.fallback) unusable = `the team graph has no touched edges (${r.result.fallback.reason})`
          else if (r.ok) replica = r
          else unusable = r.reason
        }
        if (replica) {
          ({ result, source } = replica)
        } else {
          const conn = await connectRemote({ config: ctx.config, env: ctx.env, stateDir: sel.stateRoot, target: sel.target, org: args.org, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
          if (!conn.ok) {
            ctx.stderr.write(`hyp query team-graph discover: cannot read '${sel.target}': ${conn.message}\n`)
            return 1
          }
          try {
            result = (await discoverBySql({ runSql: (sql) => remoteSql(conn.client, sql), ...input })).result
          } catch (err) {
            ctx.stderr.write(`hyp query team-graph discover: team graph discovery on '${sel.target}' failed: ${messageOf(err)}\n`)
            return 1
          }
          source = serverSource(sel.target, args.org ?? sel.login?.org ?? null, `read the team graph from the server (slow): ${unusable}`)
        }
      }
      s.setAttribute('source_kind', source.kind)
      s.setAttribute('source_path', source.path)
      s.setAttribute('sessions', result.leads.length)
      const out = discoverOutput({ source, result, args, input })
      ctx.stdout.write(args.json ? `${JSON.stringify(out, null, 2)}\n` : renderDiscover(out))
      return 0
    }))
}

/**
 * The `team-graph-discover/1` document.
 *
 * @param {{ source: FastaskSource, result: DiscoveryResult, args: TeamGraphArgs, input: { terms: string[], files: string[], leads: number, offset: number } }} args
 */
export function discoverOutput({ source, result, args, input }) {
  const flags = followFlags(source, args)
  const sessions = result.leads.map((lead) => ({
    session_id: lead.session_id,
    node_id: lead.node_id,
    rank: lead.rank,
    score: lead.score,
    group: lead.group,
    touched_at: lead.touched_at,
    why: lead.why,
    exemplar: lead.exemplar,
    session: lead.session,
  }))
  const topSessions = sessions.slice(0, MAX_SEARCH_SESSIONS).map((s) => s.session_id)
  const terms = result.terms.map((t) => t.text)
  return {
    contract: DISCOVER_CONTRACT,
    operation: 'discover',
    source,
    terms: result.terms,
    files: input.files,
    anchors: result.anchors.map((a) => ({ node_id: a.node_id, key: a.key, term: a.term, match: a.match, proven: a.proven, in_repo: a.in_repo })),
    sessions,
    ambiguous: result.ambiguous,
    groups: result.groups,
    no_anchor: result.no_anchor,
    page: result.page,
    coverage: result.coverage,
    next: {
      neighbors: result.anchors.length ? `hyp query team-graph neighbors ${result.anchors.slice(0, MAX_STARTS).map((a) => shellQuote(a.node_id)).join(' ')} --direction in${flags} --json` : null,
      search: topSessions.length && terms.length ? `hyp query team-graph search ${topSessions.map((id) => `--session ${shellQuote(id)}`).join(' ')} ${terms.map(shellQuote).join(' ')}${flags} --json` : null,
      next_page: result.page.next_offset !== null ? `hyp query team-graph discover ${[...input.terms.map(shellQuote), ...input.files.map((f) => `--file ${shellQuote(f)}`)].join(' ')} --limit ${input.leads} --offset ${result.page.next_offset}${flags} --json` : null,
    },
  }
}

/** @param {ReturnType<typeof discoverOutput>} out */
function renderDiscover(out) {
  const lines = [sourceLine(out.source)]
  if (out.no_anchor) lines.push('no file of the team graph matches these terms; try other names, or search inside known sessions')
  for (const a of out.anchors) lines.push(`file ${a.key}${a.proven ? '' : ' (candidate)'}  [${a.node_id}]`)
  for (const s of out.sessions) {
    const why = s.why.map((w) => w.anchor.key).join(', ')
    lines.push(`${s.rank}. ${s.session_id}  touched ${s.touched_at ?? 'at an unknown time'}  ${s.session.client_name ?? ''} ${s.session.git_branch ?? ''}`.trimEnd())
    lines.push(`   via ${why}`)
  }
  if (out.ambiguous) lines.push('several files match the same name: the sessions are grouped per file')
  pushNext(lines, out.next)
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// neighbors

/**
 * `hyp query team-graph neighbors <node-id>...`: one bounded hop from the
 * given nodes, over the warm index, the cold replica, or (team_server and
 * local) the existing `query graph neighbors` verb, named in the output.
 *
 * @ref LLP 0487#decision [implements]: neighbors over the warm route or cold index; team_server answers through query graph neighbors --remote
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ pluginDir?: string, fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<number>}
 */
export function runTeamGraphNeighbors(argv, ctx, deps = {}) {
  const parse = (/** @type {string[]} */ a) => {
    const args = parseTeamGraphArgs(a, { lists: ['id', 'key', 'edge-type'], values: ['direction'], numbers: { limit: [1, MAX_NEIGHBORS], 'max-visits': [1, MAX_VISITS] } })
    const direction = args.values.direction ?? 'both'
    if (direction !== 'in' && direction !== 'out' && direction !== 'both') throw new UsageError('--direction must be in, out or both')
    if (args.positional.length + args.lists.id.length + args.lists.key.length === 0) throw new UsageError('give at least one node id or --key')
    return args
  }
  return command('neighbors', NEIGHBORS_USAGE, argv, ctx, parse, (args) =>
    span('fastask.team_graph.neighbors', { json: args.json }, async (s) => {
      const input = {
        ids: [...args.positional, ...args.lists.id],
        keys: args.lists.key,
        direction: /** @type {'in' | 'out' | 'both'} */ (args.values.direction ?? 'both'),
        edgeTypes: args.lists['edge-type'],
        limit: args.numbers.limit ?? DEFAULT_NEIGHBORS,
        maxVisits: args.numbers['max-visits'] ?? MAX_VISITS,
      }
      const sel = await selectTarget(ctx, args, deps)
      /** @type {FastaskSource} */
      let source
      /** @type {NeighborsResult} */
      let result
      /** @type {string | null} */
      let unusable = sel.unusable
      /** @type {{ result: NeighborsResult, source: FastaskSource } | null} */
      let replica = null
      if (sel.target !== null && !unusable && sel.login) {
        const r = await fromReplica({ ...sel, target: sel.target, login: sel.login, route: NEIGHBORS_ROUTE, body: input, cold: (index) => neighbors(index, input), fetchImpl: deps.fetchImpl })
        if (r.ok) replica = r
        else unusable = r.reason
      }
      if (replica) {
        ({ result, source } = replica)
      } else if (sel.target === null) {
        const verb = ctx.verbs?.get(GRAPH_NEIGHBORS_VERB)
        if (!verb) {
          ctx.stderr.write('hyp query team-graph neighbors: no capture graph here (enable @hypaware/context-graph and run hyp graph project)\n')
          return 1
        }
        const opCtx = buildOperationContext(ctx, 'auto')
        result = await viaGraphQuery(input, async (params) => verb.operation(params, opCtx))
        source = localSource(`local captures only, answered by ${GRAPH_NEIGHBORS_VERB}`)
      } else {
        const conn = await connectRemote({ config: ctx.config, env: ctx.env, stateDir: sel.stateRoot, target: sel.target, org: args.org, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
        if (!conn.ok) {
          ctx.stderr.write(`hyp query team-graph neighbors: cannot read '${sel.target}': ${conn.message}\n`)
          return 1
        }
        result = await viaGraphQuery(input, (params) => remoteTool(conn.client, GRAPH_NEIGHBORS_TOOL, params))
        source = serverSource(sel.target, args.org ?? sel.login?.org ?? null, `answered by ${GRAPH_NEIGHBORS_VERB} --remote (slow): ${unusable}`)
      }
      s.setAttribute('source_kind', source.kind)
      s.setAttribute('source_path', source.path)
      s.setAttribute('neighbors', result.neighbors.length)
      s.setAttribute('truncated', result.coverage.truncated || result.coverage.results_truncated)
      const out = neighborsOutput({ source, result, args, input })
      ctx.stdout.write(args.json ? `${JSON.stringify(out, null, 2)}\n` : renderNeighbors(out))
      return result.starts.some((st) => st.found) ? 0 : 1
    }))
}

/**
 * One `graph_neighbors` query per start (depth 1), mapped to this command's
 * shape. At most `QUERY_STARTS` starts, one at a time: each is a full graph
 * query on the server or the local cache.
 *
 * @param {{ ids: string[], keys: string[], direction: 'in' | 'out' | 'both', edgeTypes: string[], limit: number }} input
 * @param {(params: Record<string, unknown>) => Promise<any>} query
 * @returns {Promise<NeighborsResult>}
 */
export async function viaGraphQuery(input, query) {
  const asked = [...input.ids.map((v) => ({ input: v, by: /** @type {const} */ ('id') })), ...input.keys.map((v) => ({ input: v, by: /** @type {const} */ ('key') }))]
  const kept = asked.slice(0, QUERY_STARTS)
  /** @type {NeighborsStart[]} */
  const starts = []
  /** @type {Neighbor[]} */
  const out = []
  let visits = 0
  let truncated = false
  let resultsTruncated = false
  for (const a of kept) {
    if (out.length >= input.limit) {
      resultsTruncated = true
      break
    }
    /** @type {any} */
    let r
    try {
      r = await query({ node: a.input, depth: 1, direction: input.direction, limit: input.limit - out.length, ...(input.edgeTypes.length ? { edge_type: input.edgeTypes } : {}) })
    } catch (err) {
      r = { ok: false, error: messageOf(err) }
    }
    if (!r?.ok || !r.seed) {
      starts.push({ input: a.input, by: a.by, found: false, node_id: null, type: null, key: null })
      continue
    }
    starts.push({ input: a.input, by: a.by, found: true, node_id: r.seed.node_id, type: r.seed.node_type, key: r.seed.natural_key })
    if (typeof r.totalEdges === 'number') visits += r.totalEdges
    if (r.truncated) truncated = true
    for (const n of Array.isArray(r.neighbors) ? r.neighbors : []) {
      if (n.hop !== undefined && n.hop !== 1) continue
      if (out.length === input.limit) { resultsTruncated = true; break }
      const keys = n.source_keys && typeof n.source_keys === 'object' ? n.source_keys : null
      out.push({
        from: String(n.from ?? r.seed.node_id),
        direction: n.direction === 'in' ? 'in' : 'out',
        edge_type: String(n.edge_type),
        first_seen: null,
        exemplar: keys && (keys.message_id || keys.part_id) ? { message_id: keys.message_id ?? null, part_id: keys.part_id ?? null } : null,
        node: { node_id: String(n.node?.node_id), type: String(n.node?.node_type), key: n.node?.natural_key ?? null, label: n.node?.label ?? n.node?.natural_key ?? null, placeholder: false },
      })
    }
  }
  return {
    starts,
    neighbors: out,
    coverage: { visits, truncated, results_truncated: resultsTruncated, unresolved_met: 0, starts_dropped: asked.length - kept.length },
  }
}

/**
 * @param {{ callTool(name: string, args: unknown): Promise<any> }} client
 * @param {string} tool
 * @param {Record<string, unknown>} params
 */
async function remoteTool(client, tool, params) {
  const res = await client.callTool(tool, params)
  const text = Array.isArray(res?.content) ? res.content.find((/** @type {any} */ c) => c?.type === 'text')?.text : undefined
  if (res?.isError) return { ok: false, error: typeof text === 'string' ? text : `${tool} failed` }
  return res?.structuredContent ?? (typeof text === 'string' ? JSON.parse(text) : null)
}

/**
 * The `team-graph-neighbors/1` document.
 *
 * @param {{ source: FastaskSource, result: NeighborsResult, args: TeamGraphArgs, input: { direction: string, edgeTypes: string[], limit: number } }} args
 */
export function neighborsOutput({ source, result, args, input }) {
  const flags = followFlags(source, args)
  const sessionIds = [...new Set(result.neighbors.filter((n) => n.node.type === 'Session' && n.node.key).map((n) => /** @type {string} */ (n.node.key)))]
  const onward = [...new Set(result.neighbors.filter((n) => !n.node.placeholder).map((n) => n.node.node_id))].slice(0, MAX_STARTS)
  return {
    contract: NEIGHBORS_CONTRACT,
    operation: 'neighbors',
    source,
    direction: input.direction,
    edge_types: input.edgeTypes,
    starts: result.starts,
    neighbors: result.neighbors,
    coverage: result.coverage,
    next: {
      neighbors: onward.length ? `hyp query team-graph neighbors ${onward.map(shellQuote).join(' ')}${flags} --json` : null,
      search: sessionIds.length ? `hyp query team-graph search ${sessionIds.slice(0, MAX_SEARCH_SESSIONS).map((id) => `--session ${shellQuote(id)}`).join(' ')} <term>...${flags} --json` : null,
    },
  }
}

/** @param {ReturnType<typeof neighborsOutput>} out */
function renderNeighbors(out) {
  const lines = [sourceLine(out.source)]
  for (const st of out.starts) if (!st.found) lines.push(`not found: ${st.input}`)
  for (const n of out.neighbors) {
    const arrow = n.direction === 'out' ? `-${n.edge_type}->` : `<-${n.edge_type}-`
    lines.push(`${n.from} ${arrow} ${n.node.type} ${n.node.key ?? '(not in the graph file)'}  [${n.node.node_id}]`)
  }
  if (out.coverage.truncated || out.coverage.results_truncated) lines.push('truncated: raise --limit or --max-visits, or narrow with --edge-type')
  pushNext(lines, out.next)
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// search

/**
 * `hyp query team-graph search --session <id>... <term>...`: text search
 * inside candidate sessions on the team server (or local captures), each
 * session reported on its own. The replica holds no text, so this always
 * reads the server.
 *
 * @ref LLP 0487#decision [implements]: search fans out query_sql per candidate session; no new server tool
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ pluginDir?: string, fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<number>}
 */
export function runTeamGraphSearch(argv, ctx, deps = {}) {
  const parse = (/** @type {string[]} */ a) => {
    const args = parseTeamGraphArgs(a, { lists: ['session', 'term'], numbers: { hits: [1, MAX_HITS_PER_SESSION], chars: [40, MAX_TEXT_CHARS] } })
    const terms = [...args.positional, ...args.lists.term]
    if (args.lists.session.length === 0) throw new UsageError('give at least one --session')
    if (args.lists.session.length > MAX_SEARCH_SESSIONS) throw new UsageError(`at most ${MAX_SEARCH_SESSIONS} sessions`)
    if (terms.length === 0) throw new UsageError('give at least one term')
    if (terms.length > MAX_TERMS) throw new UsageError(`at most ${MAX_TERMS} terms`)
    return args
  }
  return command('search', SEARCH_USAGE, argv, ctx, parse, (args) =>
    span('fastask.team_graph.search', { json: args.json }, async (s) => {
      const terms = [...args.positional, ...args.lists.term]
      const sel = await selectTarget(ctx, args, deps)
      /** @type {FastaskSource} */
      let source
      /** @type {(sql: string) => Promise<Record<string, unknown>[]>} */
      let runSql
      if (sel.target === null) {
        runSql = (sql) => localSql(ctx, sql)
        source = localSource('local captures only')
      } else {
        const conn = await connectRemote({ config: ctx.config, env: ctx.env, stateDir: sel.stateRoot, target: sel.target, org: args.org, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
        if (!conn.ok) {
          ctx.stderr.write(`hyp query team-graph search: cannot read '${sel.target}': ${conn.message}\n`)
          return 1
        }
        runSql = (sql) => remoteSql(conn.client, sql)
        source = serverSource(sel.target, args.org ?? sel.login?.org ?? null, 'session text is read from the server (query_sql per session)')
      }
      const result = await searchSessions({
        runSql, sessions: args.lists.session, terms,
        hitsPerSession: args.numbers.hits ?? DEFAULT_HITS_PER_SESSION, hitChars: args.numbers.chars ?? DEFAULT_HIT_CHARS,
      })
      s.setAttribute('source_kind', source.kind)
      s.setAttribute('sessions', result.sessions.length)
      s.setAttribute('hits', result.coverage.hits)
      s.setAttribute('failed_sessions', result.sessions.filter((x) => x.error).length)
      const out = searchOutput({ source, result, args })
      ctx.stdout.write(args.json ? `${JSON.stringify(out, null, 2)}\n` : renderSearch(out))
      // Nothing could be read at all: every session's query failed.
      return result.sessions.every((x) => x.error) ? 1 : 0
    }))
}

/**
 * The `team-graph-search/1` document. Each hit carries a `query evidence`
 * entry for the conversation around it, and the command that reads it.
 *
 * @param {{ source: FastaskSource, result: SearchResult, args: TeamGraphArgs }} args
 */
export function searchOutput({ source, result, args }) {
  const remote = source.remote
  const org = args.org
  return {
    contract: SEARCH_CONTRACT,
    operation: 'search',
    source,
    terms: result.terms,
    sessions: result.sessions.map((session) => ({
      ...session,
      hits: session.hits.map((hit) => ({ ...hit, read_command: remote ? evidenceCommand(remote, hit.read, org) : null })),
    })),
    coverage: result.coverage,
  }
}

/** @param {ReturnType<typeof searchOutput>} out */
function renderSearch(out) {
  const lines = [sourceLine(out.source)]
  for (const session of out.sessions) {
    const state = session.error ? `failed: ${session.error}` : `${session.hits.length} hit${session.hits.length === 1 ? '' : 's'}${session.truncated ? ' (more not shown; raise --hits)' : ''}`
    lines.push(`${session.session_id}: ${state}`)
    for (const hit of session.hits) {
      lines.push(`  ${hit.message_created_at ?? ''} ${hit.role ?? ''}: ${hit.excerpt.replace(/\s+/g, ' ').trim()}`)
      if (hit.read_command) lines.push(`    read: ${hit.read_command}`)
    }
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// shared output

/**
 * Follow-ups read the same scope the command read: its remote (when a server
 * or replica answered) and its `--org`.
 *
 * @param {FastaskSource} source
 * @param {TeamGraphArgs} args
 */
function followFlags(source, args) {
  return source.remote ? scopeFlags({ remote: source.remote, org: args.org }) : ''
}

/** @param {FastaskSource} source */
function sourceLine(source) {
  const age = source.watermark_age_s === null ? '' : `, data as of ${Math.round(source.watermark_age_s / 60)} min ago`
  const where = source.kind === 'team_replica' ? `team graph replica (${source.path}${source.replica_state ? `, ${source.replica_state}` : ''}${age})`
    : source.kind === 'team_server' ? `team server ${source.remote}` : 'local captures'
  return `source: ${where}${source.note ? `: ${source.note}` : ''}`
}

/**
 * @param {string[]} lines
 * @param {Record<string, string | null>} next
 */
function pushNext(lines, next) {
  const commands = Object.entries(next).filter(([, cmd]) => cmd)
  if (commands.length === 0) return
  lines.push('next:')
  for (const [name, cmd] of commands) lines.push(`  ${name}: ${cmd}`)
}
