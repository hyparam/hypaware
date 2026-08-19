// @ts-check

import { buildQuerySqlOutput } from '../query/format.js'
import { renderLocalOnlyNotice } from '../query/verb.js'
import { executeGrepSearch } from './grep_service.js'
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
      limit: { type: 'number', default: DEFAULT_LIMIT, description: `Max hits (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
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
    const limit =
      typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_LIMIT
        ? rawLimit
        : DEFAULT_LIMIT
    return executeGrepSearch({
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      query: String(params.query ?? ''),
      regex: params.regex === true,
      sessionId: typeof params.session_id === 'string' ? params.session_id : undefined,
      chainId: typeof params.chain_id === 'string' ? params.chain_id : undefined,
      from: typeof params.from === 'string' ? params.from : undefined,
      to: typeof params.to === 'string' ? params.to : undefined,
      limit,
      refresh: ctx.refresh,
      // @ref LLP 0105 [constrained-by]: the caller's context rides every search; the service's shared predicate decides visibility, never this verb
      callerCwd: ctx.callerCwd,
      includeLocalOnly: params['include-local-only'] === true,
    })
  },
  render(result, controls) {
    const r = /** @type {Partial<GrepSearchResult> & { localOnly?: LocalOnlyVisibilityReport, freshnessMessages?: string[] }} */ (result)
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
    // render: the limit cut the answer (narrow or raise --limit), or the
    // walk stopped early (an abort or server deadline mid-search).
    if (r.truncated === true) {
      stderr += 'grep: more matches exist beyond the limit - narrow with --from/--to or --session-id, or raise --limit\n'
    } else if (r.exhausted === false) {
      stderr += 'grep: the search stopped before covering every file; results may be incomplete\n'
    }
    return {
      stdout: out.stdout,
      stderr: stderr + out.stderr,
      ...(out.file ? { file: out.file } : {}),
    }
  },
}

/**
 * Flatten hits to one row per matched column for the shared formatter.
 * Locators ride every row so a reader can pivot any line straight into
 * `hyp query sql` (`part_id`) or `hyp query grep --session-id`.
 *
 * @param {GrepSearchHit[]} hits
 * @returns {{ columns: string[], rows: Record<string, unknown>[] }}
 */
function flattenHits(hits) {
  const columns = ['date', 'session_id', 'column', 'snippet', 'message_id', 'part_id']
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const hit of hits) {
    const base = {
      date: hit.date,
      session_id: hit.sessionId,
      message_id: hit.messageId,
      part_id: hit.partId,
    }
    if (!Array.isArray(hit.matches) || hit.matches.length === 0) {
      rows.push({ ...base, column: null, snippet: null })
      continue
    }
    for (const match of hit.matches) {
      rows.push({ ...base, column: match.column, snippet: match.snippet })
    }
  }
  return { columns, rows }
}
