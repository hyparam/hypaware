// @ts-check

import { buildQuerySqlOutput } from './format.js'
import { executeQuerySql } from './sql.js'

/**
 * @import { VerbRegistration } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { LocalOnlyVisibilityReport } from '../../../src/core/query/types.js'
 */

/**
 * The intrinsic `query_sql` verb. SQL/dataset query is **intrinsic** (LLP
 * 0003), so core contributes this verb for free on every host with a
 * registered dataset; it projects the `query sql` CLI command and the
 * `query_sql` MCP tool from one declaration. Read-class: reachable by a
 * query-scoped credential.
 *
 * @type {VerbRegistration}
 * @ref LLP 0034#maps-onto-the-intrinsicplugin-boundary-llp-0003 [implements]: SQL surface is intrinsic → core's own verb, a tool on every host
 */
export const querySqlVerb = {
  name: 'query sql',
  tool: 'query_sql',
  summary: 'Run a SQL query against registered datasets',
  authClass: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'A single read-only SELECT over the registered datasets.',
        greedy: true,
      },
      // @ref LLP 0105#override [implements]: the informed-consent override; the help text names the transcript-capture consequence and bundled skills never pass it
      'include-local-only': {
        type: 'boolean',
        default: false,
        description:
          'Include local-only rows even when this context is synced. If this session ' +
          'is itself captured, their content enters the transcript and can be forwarded.',
      },
    },
    required: ['sql'],
    positional: ['sql'],
  },
  async operation(params, ctx) {
    return executeQuerySql({
      query: String(params.sql),
      registry: ctx.query,
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      refresh: ctx.refresh,
      config: ctx.config,
      log: ctx.log,
      // @ref LLP 0105 [constrained-by]: the caller's context rides every query; the shared filter in executeQuerySql decides visibility, never this verb
      callerCwd: ctx.callerCwd,
      includeLocalOnly: params['include-local-only'] === true,
    })
  },
  render(result, controls) {
    const r = /** @type {{ columns?: string[], rows?: Record<string, unknown>[], freshnessMessages?: string[], localOnly?: LocalOnlyVisibilityReport }} */ (result)
    // `--json` is a friendly shorthand for `--format json`; an explicit
    // `--format` still wins.
    const format = controls.json && controls.format === 'table' ? 'json' : controls.format
    const out = buildQuerySqlOutput(
      { columns: r.columns ?? [], rows: r.rows ?? [] },
      { format, output: controls.output, maxCell: controls.maxCell, maxBytes: controls.maxBytes }
    )
    // Cache-freshness messages are local-only signal; they precede the
    // client display-budget notice, both on stderr so stdout stays valid.
    const freshness = (r.freshnessMessages ?? []).map((m) => `${m}\n`).join('')
    // Withholding is never silent: report the count (only ever the count,
    // never the content) on stderr so a synced-context query that lost rows
    // says so. @ref LLP 0105 [implements]: result counts differ by context, so hyp query says when rows were withheld
    const withheld = renderLocalOnlyNotice(r.localOnly)
    return {
      stdout: out.stdout,
      stderr: freshness + withheld + out.stderr,
      ...(out.file ? { file: out.file } : {}),
    }
  },
}

/**
 * Stderr lines for the LLP 0105 visibility report: one when rows were
 * withheld, one when unprovenanced rows had content columns suppressed.
 * Empty when nothing was hidden (the quiet default).
 *
 * @param {LocalOnlyVisibilityReport | undefined} localOnly
 * @returns {string}
 */
export function renderLocalOnlyNotice(localOnly) {
  if (!localOnly) return ''
  let out = ''
  if (localOnly.withheldRows > 0) {
    out += `local-only: withheld ${localOnly.withheldRows} row(s) not visible from this ` +
      `${localOnly.callerClass === 'unknown' ? 'unknown-context' : localOnly.callerClass} caller ` +
      `(rerun with --include-local-only to include them; a captured session's transcript would then carry their content)\n`
  }
  if (localOnly.suppressedRows > 0) {
    out += `local-only: suppressed content columns on ${localOnly.suppressedRows} row(s) without ` +
      `per-row provenance (rerun with --include-local-only to include them)\n`
  }
  return out
}
