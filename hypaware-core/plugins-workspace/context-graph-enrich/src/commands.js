// @ts-check

import { runCurateBatch } from './batch.js'
import { COMMITTED_DATASET, PROSPECTS_DATASET, RESOLUTIONS_DATASET } from './datasets.js'
import { runCurateTick } from './curate.js'
import { runProposeTick } from './propose.js'
import { requireEnrichRuntime } from './runtime.js'
import { runSql } from './sql.js'
import { readState } from './state.js'

/**
 * @import { CommandRunContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { EnrichRuntime } from './types.d.ts'
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
      '  status    show watermarks and prospect/committed counts\n'
  )
  return 0
}

/**
 * `hyp enrich backfill` — the deliberate, out-of-daemon backfill over **all**
 * sessions ([§two-regimes](LLP 0028)), mirroring `hyp graph project`. Proposes
 * every session (T1, synchronous) then curates the whole pending pool through
 * the Anthropic **Batch API**, polling to completion. Expensive and one-shot —
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
      ctx.stdout.write(`enrich backfill curate: submitting batch (polls to completion; the Batch API can take up to 24h)…\n`)
      const cr = await runCurateBatch(runtime, { onProgress: (s) => ctx.stdout.write(`  batch ${s.id}: ${s.status}\n`) })
      const via = cr.batched ? 'batch' : 'synchronous (provider has no batch API)'
      ctx.stdout.write(
        `enrich backfill curate (${via}): ${cr.processed}/${cr.pending} processed over ${cr.clusters} cluster(s) — ` +
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
 * Parse `hyp enrich backfill` argv. Pure + deterministic, so it carries its own
 * traditional test (CLAUDE.md: argv/config parsing-and-validation). Accepts the
 * two mutually-exclusive phase flags and rejects unknown flags or any positional.
 *
 * @param {string[]} argv
 * @returns {{ ok: true, proposeOnly: boolean, curateOnly: boolean } | { ok: false, error: string }}
 */
export function parseBackfillArgv(argv) {
  let proposeOnly = false
  let curateOnly = false
  for (const token of argv) {
    if (token === '--propose-only') proposeOnly = true
    else if (token === '--curate-only') curateOnly = true
    else if (token.startsWith('--')) return { ok: false, error: `unknown flag ${token}` }
    else return { ok: false, error: `unexpected argument ${token} (enrich backfill takes no positional)` }
  }
  if (proposeOnly && curateOnly) return { ok: false, error: '--propose-only and --curate-only are mutually exclusive' }
  return { ok: true, proposeOnly, curateOnly }
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
      `enrich curate: ${r.processed}/${r.pending} processed in ${r.calls} call(s) over ${r.clusters} cluster(s) — ` +
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
