// @ts-check

import { applyContextControls, renderResult } from '../../../../src/core/query/format.js'
import { getVectorSearchRuntime } from './runtime.js'
import { searchVectorIndexes } from './search.js'
import { partitionLabel } from './shards.js'
import { collectIndexStatus } from './status.js'

/**
 * @import { CommandRunContext, HypError } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { QueryFormat } from '../../../../src/core/query/types.d.ts'
 */

// Mirrors the `hyp query sql` inline-output defaults so vector results
// are bounded the same way SQL results are.
const DEFAULT_MAX_CELL = 200
const DEFAULT_MAX_BYTES = 32_768

const SEARCH_USAGE =
  'usage: hyp vector search <query> [--index <name>] [--dataset <name>] [--top-k <n>] [--no-refresh] [--format <fmt>] [--max-cell <n>] [--max-bytes <n>]'

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
export async function runVector(_argv, ctx) {
  ctx.stdout.write('hyp vector <subcommand>\n')
  ctx.stdout.write('  search <query>   similarity search across configured indexes\n')
  ctx.stdout.write('  status           per-index shard coverage and staleness\n')
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0024#cli-surface [implements]: contributed through the CLI registry; results format through the intrinsic formatter
 */
export async function runVectorSearch(argv, ctx) {
  const parsed = parseVectorSearchArgv(argv)
  if (!parsed.ok) {
    ctx.stderr.write(parsed.error + '\n')
    return 2
  }
  try {
    const runtime = getVectorSearchRuntime()
    const hits = await searchVectorIndexes({
      runtime,
      opts: {
        query: parsed.query,
        index: parsed.index,
        dataset: parsed.dataset,
        topK: parsed.topK,
        refresh: parsed.refresh,
      },
      onProgress: (line) => ctx.stderr.write(line + '\n'),
    })

    const rows = hits.map((hit) => ({
      score: Math.round(hit.score * 10_000) / 10_000,
      index: hit.index,
      partition: partitionLabel(hit.partition),
      id: hit.id,
      text: hit.text ?? null,
    }))
    const { result, notice } = applyContextControls(
      { columns: ['score', 'index', 'partition', 'id', 'text'], rows },
      { maxCell: parsed.maxCell, maxBytes: parsed.maxBytes }
    )
    if (notice) ctx.stderr.write(notice + '\n')
    ctx.stdout.write(renderResult(result, parsed.format))
    return 0
  } catch (err) {
    const kind = /** @type {HypError} */ (err)?.hypErrorKind
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp vector search: ${message}\n`)
    return kind === 'vector_no_indexes' ? 2 : 1
  }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runVectorStatus(argv, ctx) {
  const json = argv.includes('--json')
  try {
    const runtime = getVectorSearchRuntime()
    const statuses = await collectIndexStatus(runtime)
    if (json) {
      ctx.stdout.write(JSON.stringify(statuses, null, 2) + '\n')
      return 0
    }
    if (statuses.length === 0) {
      ctx.stdout.write('no vector indexes configured\n')
      return 0
    }
    for (const status of statuses) {
      ctx.stdout.write(`index: ${status.index}  (dataset=${status.dataset} column=${status.column} model=${status.model})\n`)
      if (status.shards.length === 0) {
        ctx.stdout.write('  (no cache partitions yet)\n')
        continue
      }
      for (const shard of status.shards) {
        const partition = partitionLabel(shard.partition)
        const extras = []
        if (shard.rows !== undefined) extras.push(`rows=${shard.rows}`)
        if (shard.dimension) extras.push(`dim=${shard.dimension}`)
        if (shard.model && shard.model !== status.model) extras.push(`model=${shard.model}`)
        if (shard.built_at) extras.push(`built=${shard.built_at}`)
        ctx.stdout.write(`  ${partition}  ${shard.state}${extras.length ? '  ' + extras.join('  ') : ''}\n`)
      }
    }
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp vector status: ${message}\n`)
    return 1
  }
}

/**
 * @param {string[]} argv
 * @returns {{ ok: true, query: string, index: string | undefined, dataset: string | undefined, topK: number, refresh: 'auto' | 'never', format: QueryFormat, maxCell: number, maxBytes: number } | { ok: false, error: string }}
 */
export function parseVectorSearchArgv(argv) {
  /** @type {string[]} */
  const positional = []
  /** @type {string | undefined} */
  let index
  /** @type {string | undefined} */
  let dataset
  let topK = 10
  /** @type {'auto' | 'never'} */
  let refresh = 'auto'
  /** @type {QueryFormat} */
  let format = 'table'
  let maxCell = DEFAULT_MAX_CELL
  let maxBytes = DEFAULT_MAX_BYTES

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--index' || token === '--dataset') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `hyp vector search: ${token} expects a name` }
      }
      if (token === '--index') index = value
      else dataset = value
      i += 1
    } else if (token === '--top-k' || token === '-k') {
      const value = argv[i + 1]
      const n = Number(value)
      if (value === undefined || !Number.isInteger(n) || n <= 0) {
        return { ok: false, error: `hyp vector search: --top-k expects a positive integer (got ${value ?? '<missing>'})` }
      }
      topK = n
      i += 1
    } else if (token === '--no-refresh') {
      refresh = 'never'
    } else if (token === '--format') {
      const value = argv[i + 1]
      if (value !== 'table' && value !== 'json' && value !== 'jsonl' && value !== 'markdown') {
        return { ok: false, error: `hyp vector search: --format expects one of table|json|jsonl|markdown (got ${value ?? '<missing>'})` }
      }
      format = value
      i += 1
    } else if (token === '--max-cell' || token === '--max-bytes') {
      const value = argv[i + 1]
      const n = Number(value)
      if (value === undefined || !Number.isInteger(n) || n < 0) {
        return { ok: false, error: `hyp vector search: ${token} expects a non-negative integer (got ${value ?? '<missing>'})` }
      }
      if (token === '--max-cell') maxCell = n
      else maxBytes = n
      i += 1
    } else {
      positional.push(token)
    }
  }

  if (positional.length === 0) {
    return { ok: false, error: SEARCH_USAGE }
  }
  return { ok: true, query: positional.join(' '), index, dataset, topK, refresh, format, maxCell, maxBytes }
}
