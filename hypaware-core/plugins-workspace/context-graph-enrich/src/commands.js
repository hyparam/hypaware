// @ts-check

import { runCurateBatch } from './batch.js'
import { COMMITTED_DATASET, PROSPECTS_DATASET, RESOLUTIONS_DATASET } from './datasets.js'
import { runCurateTick } from './curate.js'
import { runProposeTick } from './propose.js'
import { requireEnrichRuntime } from './runtime.js'
import { runSql } from './sql.js'
import { readState } from './state.js'

/**
 * @import { CommandRunContext } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { EnrichRuntime } from './types.js'
 */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runEnrich(argv, ctx) {
  ctx.stdout.write(
    'hyp enrich <subcommand>\n' +
      '  propose   run one T1 propose tick now (ongoing regime: settled sessions)\n' +
      '  curate    run one T2 curate tick now (synchronous)\n' +
      '  backfill  enrich ALL history: propose every session, curate via the Batch API\n' +
      '            flags: --propose-only | --curate-only | --since <YYYY-MM-DD> | --dry-run\n' +
      '  status    show watermarks and prospect/committed counts\n'
  )
  return 0
}

/**
 * `hyp enrich backfill`: the deliberate, out-of-daemon backfill over **all**
 * sessions ([§two-regimes](LLP 0028)), mirroring `hyp graph project`. Proposes
 * every session (T1, synchronous) then curates the whole pending pool through
 * the Anthropic **Batch API**, polling to completion. Expensive and one-shot:
 * never automatic.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runEnrichBackfill(argv, ctx) {
  const parsed = parseBackfillArgv(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp enrich backfill: ${parsed.error}\n`)
    return 2
  }
  try {
    const runtime = requireEnrichRuntime()
    if (!parsed.curateOnly) {
      const pr = await runProposeTick(runtime, { regime: 'backfill' })
      ctx.stdout.write(`enrich backfill propose: ${pr.sessions}/${pr.candidates} session(s) → ${pr.prospects} prospect(s)\n`)
    }
    if (!parsed.proposeOnly) {
      /** @type {Set<string> | undefined} */
      let anchorKeys
      if (parsed.since) {
        anchorKeys = await inWindowSessions(runtime, parsed.since)
        ctx.stdout.write(`enrich backfill curate: scoped to --since ${parsed.since} → ${anchorKeys.size} in-window session(s)\n`)
      }
      if (parsed.dryRun) {
        const dr = await runCurateBatch(runtime, { anchorKeys, dryRun: true })
        ctx.stdout.write(
          `enrich backfill curate (dry run): ${dr.pending} pending prospect(s) → ${dr.clusters} cluster(s), ` +
            `${dr.skipped} below salience - nothing submitted\n`
        )
        return 0
      }
      ctx.stdout.write(`enrich backfill curate: submitting batch (polls to completion; the Batch API can take up to 24h)…\n`)
      const cr = await runCurateBatch(runtime, { anchorKeys, onProgress: (s) => ctx.stdout.write(`  batch ${s.id}: ${s.status}\n`) })
      const via = cr.batched ? 'batch' : 'synchronous (provider has no batch API)'
      ctx.stdout.write(
        `enrich backfill curate (${via}): ${cr.processed}/${cr.pending} processed over ${cr.clusters} cluster(s) - ` +
          `${cr.committed} committed, ${cr.merged} merged, ${cr.rejected} rejected, ${cr.skipped} skipped\n`
      )
    }
    ctx.stdout.write(`run 'hyp graph project' to project committed knowledge into the graph\n`)
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp enrich backfill: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/**
 * Resolve the set of session ids ("anchor keys") whose latest source part is on
 * or after `since` (a `YYYY-MM-DD` day read as UTC midnight): the in-window
 * scope the `--since` curate restricts the pending pool to. Config-driven (the
 * `anchor_key_column` / `timestamp_column`), so it stays source-agnostic like
 * the rest of the plugin rather than hardcoding `ai_gateway_messages` columns.
 *
 * @param {EnrichRuntime} runtime
 * @param {string} since  YYYY-MM-DD
 * @returns {Promise<Set<string>>}
 */
export async function inWindowSessions(runtime, since) {
  const cfg = runtime.config
  const rows = await runSql(
    runtime,
    `SELECT ${cfg.anchor_key_column} AS sid, MAX(${cfg.timestamp_column}) AS last_ts FROM ${cfg.source_dataset} GROUP BY ${cfg.anchor_key_column}`
  )
  const sinceMs = Date.parse(`${since}T00:00:00Z`)
  /** @type {Set<string>} */
  const keys = new Set()
  for (const r of rows) {
    const v = r.last_ts
    const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
    if (Number.isFinite(ms) && ms >= sinceMs) keys.add(String(r.sid))
  }
  return keys
}

/**
 * Parse `hyp enrich backfill` argv. Pure + deterministic, so it carries its own
 * traditional test (CLAUDE.md: argv/config parsing-and-validation). Accepts the
 * two mutually-exclusive phase flags and rejects unknown flags or any positional.
 *
 * `--since <YYYY-MM-DD>` bounds the **curate** pool to sessions active on or
 * after that day (the lever that keeps the cold-backfill clustering tractable);
 * `--dry-run` reports the scoped pool + cluster count without submitting.
 *
 * @param {string[]} argv
 * @returns {{ ok: true, proposeOnly: boolean, curateOnly: boolean, since?: string, dryRun: boolean } | { ok: false, error: string }}
 */
export function parseBackfillArgv(argv) {
  let proposeOnly = false
  let curateOnly = false
  let dryRun = false
  /** @type {string | undefined} */
  let since
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--propose-only') proposeOnly = true
    else if (token === '--curate-only') curateOnly = true
    else if (token === '--dry-run') dryRun = true
    else if (token === '--since' || token.startsWith('--since=')) {
      const val = token.startsWith('--since=') ? token.slice('--since='.length) : argv[++i]
      if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return { ok: false, error: '--since expects a YYYY-MM-DD date' }
      since = val
    } else if (token.startsWith('--')) return { ok: false, error: `unknown flag ${token}` }
    else return { ok: false, error: `unexpected argument ${token} (enrich backfill takes no positional)` }
  }
  if (proposeOnly && curateOnly) return { ok: false, error: '--propose-only and --curate-only are mutually exclusive' }
  if (since && proposeOnly) return { ok: false, error: '--since scopes the curate pool; it does not apply to --propose-only' }
  return { ok: true, proposeOnly, curateOnly, dryRun, ...(since !== undefined ? { since } : {}) }
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runEnrichPropose(_argv, ctx) {
  try {
    const runtime = requireEnrichRuntime()
    const r = await runProposeTick(runtime)
    ctx.stdout.write(`enrich propose (${r.regime}): ${r.sessions}/${r.candidates} session(s) → ${r.prospects} prospect(s) written\n`)
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp enrich propose: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runEnrichCurate(_argv, ctx) {
  try {
    const runtime = requireEnrichRuntime()
    const r = await runCurateTick(runtime)
    ctx.stdout.write(
      `enrich curate: ${r.processed}/${r.pending} processed in ${r.calls} call(s) over ${r.clusters} cluster(s) - ` +
        `${r.committed} committed, ${r.merged} merged, ${r.rejected} rejected, ${r.skipped} skipped\n` +
        `run 'hyp graph project' to project committed knowledge into the graph\n`
    )
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp enrich curate: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runEnrichStatus(_argv, ctx) {
  try {
    const runtime = requireEnrichRuntime()
    const state = readState(runtime.stateDir)
    const sessionsEnriched = Object.keys(state.session_marks).length
    const prospects = await count(runtime, PROSPECTS_DATASET)
    const resolutions = await count(runtime, RESOLUTIONS_DATASET)
    const committed = await count(runtime, COMMITTED_DATASET)
    ctx.stdout.write(
      `enrich status\n` +
        `  sessions enriched-through: ${sessionsEnriched}\n` +
        `  prospects:      ${prospects}\n` +
        `  resolutions:    ${resolutions} (pending: ${Math.max(0, prospects - resolutions)})\n` +
        `  committed:      ${committed}\n`
    )
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp enrich status: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/**
 * @param {EnrichRuntime} runtime
 * @param {string} dataset
 * @returns {Promise<number>}
 */
async function count(runtime, dataset) {
  const rows = await runSql(runtime, `SELECT COUNT(*) AS n FROM ${dataset}`, { allowMissing: true })
  const n = rows[0]?.n
  return typeof n === 'number' ? n : Number(n ?? 0)
}
