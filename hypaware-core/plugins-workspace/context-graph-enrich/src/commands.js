// @ts-check

import { COMMITTED_DATASET, PROSPECTS_DATASET, RESOLUTIONS_DATASET } from './datasets.js'
import { runCurateTick } from './curate.js'
import { runProposeTick } from './propose.js'
import { requireEnrichRuntime } from './runtime.js'
import { runSql } from './sql.js'
import { readState } from './state.js'

/**
 * @import { CommandRunContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runEnrich(argv, ctx) {
  ctx.stdout.write(
    'hyp enrich <subcommand>\n' +
      '  propose   run one T1 propose tick now\n' +
      '  curate    run one T2 curate tick now\n' +
      '  status    show watermarks and prospect/committed counts\n'
  )
  return 0
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
    ctx.stdout.write(`enrich propose: ${r.groups} group(s) → ${r.prospects} prospect(s) written\n`)
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
      `enrich curate: ${r.processed}/${r.pending} processed — ${r.committed} committed, ${r.rejected} rejected\n` +
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
    const prospects = await count(runtime, PROSPECTS_DATASET)
    const resolutions = await count(runtime, RESOLUTIONS_DATASET)
    const committed = await count(runtime, COMMITTED_DATASET)
    ctx.stdout.write(
      `enrich status\n` +
        `  propose cursor: ${state.propose_cursor ?? '(none)'}\n` +
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
 * @param {import('./types.d.ts').EnrichRuntime} runtime
 * @param {string} dataset
 * @returns {Promise<number>}
 */
async function count(runtime, dataset) {
  const rows = await runSql(runtime, `SELECT COUNT(*) AS n FROM ${dataset}`)
  const n = rows[0]?.n
  return typeof n === 'number' ? n : Number(n ?? 0)
}
