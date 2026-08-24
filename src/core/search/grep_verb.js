// @ts-check

import { VerbUsageError } from '../cli/verb_errors.js'
import { buildQuerySqlOutput } from '../query/format.js'
import { renderLocalOnlyNotice } from '../query/verb.js'
// The matcher module is pulled in for its refusal kind alone, and imports
// nothing beyond the allowlist below, so the boot-path deferral that keeps
// hypgrep and the Iceberg store out of `hyp --help` is untouched.
import { GrepQueryError } from './matcher.js'
import { SEARCHABLE_COLUMNS } from './searchable_columns.js'

/**
 * @import { VerbRegistration } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { GrepSearchHit, GrepSearchResult } from '../../../src/core/search/types.js'
 * @import { LocalOnlyVisibilityReport } from '../../../src/core/query/types.js'
 */

/** The server's own defaults, mirrored so local and remote page the same. */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 1000

/**
 * The `hyp query grep` verb (LLP 0264 #verb): one declaration projects the
 * CLI command and the `grep_search` MCP tool, and because the tool name and
 * `inputSchema` match the server's own `grep_search`, `--remote <target>`
 * reaches the server's archive-backed search with no server-side feature
 * work. Locally the operation runs `executeGrepSearch` over this machine's
 * cache; the two answers share the hit shape, the sort order, and the
 * column allowlist through `hypaware/core/search`.
 *
 * `include-local-only` is the one local-only parameter, and it deliberately
 * carries NO schema default: `argvToParams` sends every defaulted property
 * over the wire on `--remote`, and the server's `grep_search` schema does
 * not know this name, so a default here would make every remote call fail
 * validation. Absent-unless-passed keeps the wire clean; passing it WITH
 * `--remote` is rejected by the server, which is the honest outcome (the
 * server enforces its own visibility, not the caller's).
 *
 * @type {VerbRegistration}
 * @ref LLP 0264#verb [implements]: read-class core verb, tool grep_search, wire-compatible with the server so --remote works day one
 */
export const queryGrepVerb = {
  name: 'query grep',
  tool: 'grep_search',
  // The coverage clause is not decoration. An MCP caller sees only this
  // text, so without it zero hits are indistinguishable from "that text is
  // not stored" - the exact wrong answer an agent would then report.
  // @ref LLP 0264#shared [implements]: the allowlist stated at the one surface a machine caller reads, with the SQL escape hatch named
  summary:
    'Grep stored ai_gateway_messages: case-insensitive substring or regex, served from ' +
    'hypgrep sidecar indexes where they exist plus a scan of the rest. Covers only these ' +
    `columns: ${[...SEARCHABLE_COLUMNS].join(', ')}. Every other column, including system ` +
    'prompts (system_text), tool definitions (tools), attributes, and raw frames, is NOT ' +
    'searched, so zero hits is not evidence the text is absent from those columns - read ' +
    'them with query_sql instead',
  authClass: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Substring to find (case-insensitive), or a regex pattern with regex: true',
        greedy: true,
      },
      // @ref LLP 0303#regex-reachability [constrained-by]: local regex stays ungated while the client's only tool transport is stdio; an HTTP one has to gate it
      regex: {
        type: 'boolean',
        description:
          'Treat query as a regular expression (compiled case-insensitive). ' +
          'Servers restrict regex mode to the operator; local search does not',
      },
      session_id: { type: 'string', description: 'Only messages of this session' },
      chain_id: { type: 'string', description: 'Only this chain (matches agent_id or conversation_id)' },
      from: { type: 'string', description: 'Earliest day, YYYY-MM-DD (page older results by narrowing to)' },
      to: { type: 'string', description: 'Latest day, YYYY-MM-DD' },
      // `integer` with a `minimum`, not a bare `number`: the codec turns
      // both into a usage refusal naming the offending value, and this is
      // also the schema an MCP caller validates against. A bare `number`
      // let `--limit 0`, `--limit -5` and `--limit 2.5` fall through to a
      // silent rewrite to 50, so a caller asking for fewer rows got more
      // and exit 0. The ceiling stays out of the schema: it clamps rather
      // than refuses (see `operation`).
      // @ref LLP 0302#usage-exit [constrained-by]: a value the flag cannot use is refused, not quietly replaced with a different answer
      limit: { type: 'integer', minimum: 1, default: DEFAULT_LIMIT, description: `Max hits (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      // @ref LLP 0105#override [implements]: the informed-consent override; the help text names the transcript-capture consequence and bundled skills never pass it
      'include-local-only': {
        type: 'boolean',
        description:
          'Include local-only rows even when this context is synced. If this session ' +
          'is itself captured, their content enters the transcript and can be forwarded. ' +
          'Local search only; a server enforces its own visibility',
      },
    },
    required: ['query'],
    positional: ['query'],
  },
  async operation(params, ctx) {
    const rawLimit = params.limit
    // Only the ceiling is applied here; the schema above already refused
    // every value the flag cannot use, so nothing unusable reaches this
    // line and the fallback is just the absent case. Above the ceiling
    // clamps rather than refuses, because refusing would answer a request
    // for MORE rows with an error where a capped answer is what the help
    // text promises, and "raise --limit" is advice a caller at the ceiling
    // cannot follow.
    const limit =
      typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit >= 1
        ? Math.min(rawLimit, MAX_LIMIT)
        : DEFAULT_LIMIT
    // Loaded on demand, not at module scope: `registerCoreCommands`
    // projects every `CORE_VERBS` entry pre-boot so `hyp --help` can
    // render, so a top-level import would pull hypgrep, hyparquet and the
    // Iceberg store into the front door of every `hyp` invocation (measured
    // at ~16ms on `hyp --help`, ~10%) for the one command that needs them.
    // The remote stack in `verb_command.js` is deferred for the same reason.
    const { executeGrepSearch } = await import('./grep_service.js')
    const from = dayBound(params.from, 'from')
    const to = dayBound(params.to, 'to')
    // An inverted window selects no day at all, so the walk would prune
    // every file and answer zero with nothing on stderr - the forged
    // "nothing is recorded" the shape check below exists to prevent, just
    // reached with two individually well-formed days. The schema cannot
    // state this rule (it relates two properties), so it is checked here
    // and refused with the same usage code the codec would have used.
    // @ref LLP 0302#usage-exit [implements]: the window is a cross-field rule, refused as a usage error rather than answered with a silent zero
    if (from !== undefined && to !== undefined && from > to) {
      throw new VerbUsageError(`--from ${from} is after --to ${to}, so the window selects no days`)
    }
    let result
    try {
      result = await executeGrepSearch({
        storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
        query: String(params.query ?? ''),
        regex: params.regex === true,
        sessionId: typeof params.session_id === 'string' ? params.session_id : undefined,
        chainId: typeof params.chain_id === 'string' ? params.chain_id : undefined,
        from,
        to,
        limit,
        refresh: ctx.refresh,
        // @ref LLP 0105 [constrained-by]: the caller's context rides every search; the service's shared predicate decides visibility, never this verb
        callerCwd: ctx.callerCwd,
        includeLocalOnly: params['include-local-only'] === true,
      })
    } catch (err) {
      // `hyp query grep '(' --regex` is a typo, not a failed search, and it
      // reached the caller as exit 1 because the refusal is raised three
      // modules down in the shared matcher. Translating at this boundary is
      // what keeps that module free of the CLI: the matcher names the kind,
      // the verb names the exit code, and the same refusal can mean 400 on
      // a serving surface that never heard of `VerbUsageError`.
      // @ref LLP 0303#query-refusal-exit [implements]: the shared module's refusal becomes this surface's usage error at the surface, not inside it
      if (err instanceof GrepQueryError) throw new VerbUsageError(err.message)
      throw err
    }
    // The clamp's own promise, carried through to the render: at the
    // ceiling there is no larger `--limit` left to ask for, so the
    // truncation notice must not send the caller back to a flag that
    // cannot move. Local-only, like the freshness and visibility fields; a
    // server result carries none of them and falls back to the general
    // wording.
    return { ...result, limitCeilingReached: limit >= MAX_LIMIT }
  },
  render(result, controls) {
    const r = /** @type {Partial<GrepSearchResult> & { localOnly?: LocalOnlyVisibilityReport, freshnessMessages?: string[], limitCeilingReached?: boolean, indexedFiles?: number, scannedFiles?: number }} */ (result)
    const hits = Array.isArray(r.hits) ? r.hits : []
    // One row per matched column, rg-style: the locator columns lead, the
    // snippet trails. Delegating to the query formatter gives grep the same
    // LLP 0225 contract as sql for free: `table`/`markdown` escape every
    // cell for a human reader, `json`/`jsonl` stay byte-exact for a
    // pipeline, and the context budgets (`--max-cell`/`--max-bytes`) and
    // `--output` spill behave identically across the two query surfaces.
    const flattened = flattenHits(hits)
    const format = controls.json && controls.format === 'table' ? 'json' : controls.format
    const out = buildQuerySqlOutput(flattened, {
      format,
      output: controls.output,
      maxCell: controls.maxCell,
      maxBytes: controls.maxBytes,
    })
    let stderr = (r.freshnessMessages ?? []).map((m) => `${m}\n`).join('')
    stderr += renderLocalOnlyNotice(r.localOnly)
    // The two completeness signals, on stderr so stdout stays a valid
    // render: the limit cut the answer (narrow or raise --limit), and/or
    // the walk stopped early (an abort or server deadline mid-search).
    //
    // BOTH, not one or the other. They are independent facts and the
    // shipped skill doc teaches them as meaning different things, so a
    // search that filled its limit AND aborted must say so twice: "raise
    // --limit" alone points at a lever that cannot reach the files the
    // walk never opened. The service reports `exhausted` for an abort
    // only, so an ordinary capped search still prints one line.
    // @ref LLP 0303#completeness-signals [implements]: each notice reports its own fact, so neither can hide the other
    if (r.truncated === true) {
      stderr += r.limitCeilingReached === true
        ? `grep: more matches exist beyond the ${MAX_LIMIT}-hit ceiling - narrow with --from/--to or --session-id\n`
        : 'grep: more matches exist beyond the limit - narrow with --from/--to or --session-id, or raise --limit\n'
    }
    if (r.exhausted === false) {
      stderr += 'grep: the search stopped before covering every file; results may be incomplete\n'
    }
    // Zero hits over zero files is not the answer the summary's coverage
    // clause promises to make honest: "searched everything, found nothing"
    // and "searched nothing" render identically otherwise, and on the MCP
    // surface an agent sees only the rows. The file counts are the local
    // service's own; a server result carries none, so this stays quiet on
    // `--remote`.
    //
    // Only for a walk that finished. An abort landing before the first file
    // was served whole leaves both counters at zero over a cache full of
    // data (the indexed tier deliberately does not count an interrupted
    // file), and "nothing is recorded on this machine yet" is then the one
    // wrong thing to tell the caller. `exhausted === false` is exactly that
    // case here: with no hits the budget break cannot have fired, so the
    // only other way to leave the walk early is the abort the notice above
    // already reported.
    if (hits.length === 0 && r.exhausted !== false && r.indexedFiles === 0 && r.scannedFiles === 0) {
      stderr += 'grep: no ai_gateway_messages data files were searched - nothing is recorded on this machine yet, ' +
        'or --from/--to excluded every file\n'
    }
    return {
      stdout: out.stdout,
      stderr: stderr + out.stderr,
      ...(out.file ? { file: out.file } : {}),
    }
  },
}

/**
 * A `from`/`to` day bound, refused unless it is shaped `YYYY-MM-DD`.
 * The window is compared lexicographically against the row's own day
 * (and prunes whole files the same way), so `2026-8-1` sorts below every
 * real day and returns an empty answer with nothing on stderr. The
 * summary works hard to make "zero hits" mean something; a mistyped flag
 * must not be able to forge one.
 *
 * Refused as a `VerbUsageError`, so the caller gets exit 2 and the usage
 * line rather than exit 1: `hyp query grep x --from 2026-8-1` is a typo, and
 * a script that retries on 1 (the cache was busy) and reports on 2 (the
 * command was wrong) must be able to tell them apart. The rule cannot move
 * into the schema, whose vocabulary has no string-shape word.
 *
 * @ref LLP 0302#usage-exit [implements]: a value shape the schema cannot state is still a usage refusal
 * @param {unknown} value
 * @param {'from' | 'to'} flag
 * @returns {string | undefined}
 */
function dayBound(value, flag) {
  if (typeof value !== 'string') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new VerbUsageError(`--${flag} expects a day as YYYY-MM-DD (got ${value})`)
  }
  return value
}

/**
 * Flatten hits to one row per matched column for the shared formatter.
 * Locators ride every row so a reader can pivot any line straight into
 * `hyp query sql` (`part_id`) or `hyp query grep --session-id`.
 *
 * The snippet is last on purpose: it is the one unbounded cell (up to the
 * `--max-cell` budget), and `renderTable` pads a column to its widest
 * value only up to 80 columns without truncating the cell, so a snippet
 * anywhere but the final position shoves every locator after it out of
 * its column on exactly the rows a reader most wants to scan.
 *
 * @param {GrepSearchHit[]} hits
 * @returns {{ columns: string[], rows: Record<string, unknown>[] }}
 */
function flattenHits(hits) {
  const columns = ['date', 'session_id', 'column', 'message_id', 'part_id', 'snippet']
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const hit of hits) {
    // Keys are inserted in `columns` order: `--format json` serializes the
    // row objects themselves, so insertion order IS the key order a
    // pipeline reads, and a table and a json render of one answer should
    // not disagree about where the snippet sits.
    /** @param {string | null} column @param {string | null} snippet */
    const row = (column, snippet) => ({
      date: hit.date,
      session_id: hit.sessionId,
      column,
      message_id: hit.messageId,
      part_id: hit.partId,
      snippet,
    })
    if (!Array.isArray(hit.matches) || hit.matches.length === 0) {
      rows.push(row(null, null))
      continue
    }
    for (const match of hit.matches) rows.push(row(match.column, match.snippet))
  }
  return { columns, rows }
}
