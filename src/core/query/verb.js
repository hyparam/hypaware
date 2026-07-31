// @ts-check

import { buildQuerySqlOutput } from './format.js'
import { executeQuerySql } from './sql.js'

/**
 * @import { VerbRegistration } from '../../../collectivus-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
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
    },
    required: ['sql'],
    positional: ['sql'],
  },
  // The verb passes no `budget`, so `executeQuerySql` applies its own
  // conservative host-default ceiling (`DEFAULT_EXECUTION_BUDGET`, sql.js):
  // an un-configured `hyp query sql` and the `query_sql` MCP tool are both
  // bounded out of the box from this one call site. A refusal surfaces as
  // a normal thrown `QueryBudgetExceededError`: the CLI's generic verb
  // dispatcher (`runVerbCommand`) already turns any thrown `operation`
  // error into a stderr line plus a non-zero exit, and the MCP host's
  // generic `tools/call` handler already turns it into an `isError` tool
  // result, so neither surface needs special-case handling here.
  // @ref LLP 0054#uniform-surface [implements]: one budget/refusal, inherited by both the CLI and MCP projections of this verb
  async operation(params, ctx) {
    return executeQuerySql({
      query: String(params.sql),
      registry: ctx.query,
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      refresh: ctx.refresh,
      config: ctx.config,
      log: ctx.log,
    })
  },
  render(result, controls) {
    const r = /** @type {{ columns?: string[], rows?: Record<string, unknown>[], freshnessMessages?: string[] }} */ (result)
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
    return {
      stdout: out.stdout,
      stderr: freshness + out.stderr,
      ...(out.file ? { file: out.file } : {}),
    }
  },
}
