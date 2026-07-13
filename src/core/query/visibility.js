// @ts-check

import path from 'node:path'

import { CLASS_RANK, createUsagePolicyResolver } from '../usage-policy/matcher.js'
import { localOnlyListPath } from '../usage-policy/local_only.js'

/**
 * @import { AsyncDataSource, AsyncRow } from 'squirreling'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { UsageClass, UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 * @import { LocalOnlyVisibilityReport } from '../../../src/core/query/types.js'
 */

/** The top of the restrictiveness lattice: a caller this class sees every row. */
const MAX_CLASS_RANK = Math.max(...Object.values(CLASS_RANK))

/**
 * Build the resolver the query seam consults when the caller supplied none:
 * the same two-source resolver every kernel boot wires into the export seam
 * (`.hypignore` walk + the machine-local list beside the cache root), so the
 * two seams can never disagree about a directory's class. When the storage
 * handle carries no `cacheRoot` (bare test doubles), the resolver degrades to
 * the dotfile walk alone rather than failing construction.
 *
 * @param {Pick<ExtendedQueryStorageService, 'cacheRoot'>} storage
 * @returns {UsagePolicyResolver}
 */
export function defaultQueryVisibilityResolver(storage) {
  const cacheRoot = storage?.cacheRoot
  return createUsagePolicyResolver(
    typeof cacheRoot === 'string' && cacheRoot.length > 0
      ? { localOnlyListPath: localOnlyListPath(path.dirname(cacheRoot)) }
      : {}
  )
}

/**
 * Resolve the querying context's usage class. `null`/`undefined` means the
 * caller's `cwd` was not derivable (an MCP request that carries none): that
 * resolves to the bottom of the lattice, so anything above `full` is
 * withheld. Fail-closed on purpose: the opposite polarity would let the one
 * leak LLP 0105 exists to prevent happen silently.
 *
 * @ref LLP 0105#unknown [implements]: no derivable caller cwd excludes local-only rows, the mechanical backstop
 * @param {UsagePolicyResolver} resolver
 * @param {string | null | undefined} callerCwd
 * @returns {{ callerClass: UsageClass | 'unknown', callerRank: number }}
 */
export function resolveCallerClass(resolver, callerCwd) {
  if (typeof callerCwd !== 'string' || callerCwd.length === 0) {
    return { callerClass: 'unknown', callerRank: CLASS_RANK.full }
  }
  const callerClass = resolver.resolve(callerCwd).class
  return { callerClass, callerRank: CLASS_RANK[callerClass] }
}

/**
 * True when a caller of this rank can skip the visibility wrapper entirely:
 * nothing on the lattice outranks it, so every row (and every
 * unknown-provenance row) is visible and the scan fast paths
 * (`scanColumn`, `numRows`, limit/offset pushdown) stay lit.
 *
 * @param {number} callerRank
 * @returns {boolean}
 */
export function callerSeesEverything(callerRank) {
  return callerRank >= MAX_CLASS_RANK
}

/**
 * Decorate one dataset's data source so every row the engine pulls honors
 * LLP 0105's invariant: content may only surface in a context at least as
 * non-exported as the content itself.
 *
 * Two per-row mechanisms, keyed by what provenance the row carries:
 *
 * - rows with a `cwd` value are resolved through the shared usage-policy
 *   resolver and WITHHELD (dropped from the stream, counted in
 *   `report.withheldRows`) when the row's class outranks the caller's on the
 *   restrictiveness lattice;
 * - rows WITHOUT a `cwd` value in a dataset that declared
 *   `localOnlyContentColumns` (derived tables such as the context-graph
 *   projection, whose rows aggregate across sessions and may lack per-row
 *   provenance) keep their structural columns but have those content-bearing
 *   columns SUPPRESSED to null (counted in `report.suppressedRows`), because
 *   an unprovenanced row cannot prove it is safe for this caller;
 * - rows without a `cwd` value in a plain `cwd`-bearing dataset pass through
 *   whole: the export seam forwards exactly those rows, so they are already
 *   `full`-class by construction and hiding them here would claim a privacy
 *   the export path does not deliver.
 *
 * Fast-path discipline (what this wrapper refuses to forward):
 *
 * - `scanColumn` is dropped: a single-column stream cannot carry the row's
 *   `cwd`, so forwarding it would let any projection bypass the filter (the
 *   export seam learned the same lesson, storage.js `readRowsSince`).
 * - `numRows` is dropped: the engine answers `COUNT(*)` from it without
 *   scanning, which would count withheld rows.
 * - limit/offset hints are not forwarded (and `appliedLimitOffset` is
 *   reported false): the source would slice by physical position BEFORE this
 *   filter removes rows, under-returning visible rows.
 * - when suppression can apply, the WHERE hint is also kept from the source
 *   (`appliedWhere: false`): a pushed-down predicate over a content column
 *   would match against the TRUE value and reveal, by a row's presence,
 *   content the suppression then hides. The engine re-evaluates the WHERE
 *   over the suppressed row, where SQL null semantics make it unmatchable.
 * - `cwd` is forced into every projected scan and stripped back off the
 *   yielded row, so a `columns` projection that omits it cannot blind the
 *   filter.
 *
 * @ref LLP 0105 [implements]: the one shared filter at the query read path; caller class >= row class on the lattice, never per-command
 * @ref LLP 0105#graph-provenance [implements]: rows lacking per-row cwd provenance get their declared content-bearing columns suppressed, never surfaced
 * @param {AsyncDataSource} source
 * @param {{
 *   resolver: UsagePolicyResolver,
 *   callerRank: number,
 *   contentColumns: string[],
 *   report: LocalOnlyVisibilityReport,
 * }} opts
 * @returns {AsyncDataSource}
 */
export function withLocalOnlyVisibility(source, opts) {
  const { resolver, callerRank, report } = opts
  const hasCwd = source.columns.includes('cwd')
  const declaredContent = opts.contentColumns.filter((c) => source.columns.includes(c))

  /** @type {AsyncDataSource} */
  const guarded = {
    // numRows intentionally absent (see fast-path discipline above).
    columns: source.columns,
    scan(options) {
      const requested = options?.columns
      const scannedColumns = requested ?? source.columns
      const forceCwd = hasCwd && requested !== undefined && !requested.includes('cwd')
      const toSuppress = declaredContent.filter((c) => scannedColumns.includes(c))
      const suppression = toSuppress.length > 0
      const inner = source.scan({
        ...(options ?? {}),
        columns: forceCwd ? [...requested, 'cwd'] : requested,
        limit: undefined,
        offset: undefined,
        ...(suppression ? { where: undefined } : {}),
      })
      return {
        appliedWhere: suppression ? false : inner.appliedWhere,
        appliedLimitOffset: false,
        async *rows() {
          for await (const row of inner.rows()) {
            const cwd = hasCwd ? await readCell(row, 'cwd') : undefined
            if (typeof cwd === 'string' && cwd !== '') {
              // A corrupt machine-local list makes resolve() throw
              // (LocalOnlyListUnreadableError); let it propagate so the query
              // fails loudly rather than silently resolving to "nothing
              // withheld", matching the export seam's fail-safe polarity.
              if (CLASS_RANK[resolver.resolve(cwd).class] > callerRank) {
                report.withheldRows += 1
                continue
              }
              yield forceCwd ? withoutColumn(row, 'cwd') : row
              continue
            }
            const passed = forceCwd ? withoutColumn(row, 'cwd') : row
            if (suppression) {
              report.suppressedRows += 1
              yield suppressColumns(passed, toSuppress)
            } else {
              yield passed
            }
          }
        },
      }
    },
  }
  return guarded
}

/**
 * Read one cell off an AsyncRow, preferring the pre-materialized value.
 *
 * @param {AsyncRow} row
 * @param {string} column
 * @returns {Promise<unknown>}
 */
async function readCell(row, column) {
  if (row.resolved && column in row.resolved) return row.resolved[column]
  const cell = row.cells[column]
  return cell ? await cell() : undefined
}

/**
 * A copy of `row` with `column` removed (used to strip a force-scanned `cwd`
 * the caller's projection never asked for, so it cannot leak into results).
 *
 * @param {AsyncRow} row
 * @param {string} column
 * @returns {AsyncRow}
 */
function withoutColumn(row, column) {
  const { [column]: _cell, ...cells } = row.cells
  /** @type {AsyncRow} */
  const out = { columns: row.columns.filter((c) => c !== column), cells }
  if (row.resolved) {
    const { [column]: _value, ...resolved } = row.resolved
    out.resolved = resolved
  }
  return out
}

/** @type {() => Promise<null>} */
const NULL_CELL = () => Promise.resolve(null)

/**
 * A copy of `row` with every listed column's value replaced by null.
 *
 * @param {AsyncRow} row
 * @param {string[]} columns
 * @returns {AsyncRow}
 */
function suppressColumns(row, columns) {
  /** @type {AsyncRow} */
  const out = { columns: row.columns, cells: { ...row.cells } }
  for (const c of columns) out.cells[c] = NULL_CELL
  if (row.resolved) {
    out.resolved = { ...row.resolved }
    for (const c of columns) out.resolved[c] = null
  }
  return out
}
