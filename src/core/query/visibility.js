// @ts-check

import path from 'node:path'
import { readBatchColumn, selectBatch, selectedRowCount, valueAt } from 'squirreling'

import { CLASS_RANK, createUsagePolicyResolver } from '../usage-policy/matcher.js'
import { localOnlyListPath } from '../usage-policy/local_only.js'

/**
 * @import { AsyncBatch, AsyncRow, ColumnVector, PrepareScan, RelationSchema, RowSelection, SqlPrimitive } from 'squirreling'
 * @import { ScannableDataSource } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { UsageClass, UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 * @import { LocalOnlyVisibilityReport } from '../../../src/core/query/types.js'
 */

/** The top of the restrictiveness lattice: a caller this class sees every row. */
const MAX_CLASS_RANK = Math.max(...Object.values(CLASS_RANK))

/**
 * The column a derived dataset declares among its content columns to record
 * the folders that contributed to each row: a sorted JSON array of paths,
 * `[]` for folderless, or null for unknown (LLP 0616 #column).
 */
export const PROVENANCE_COLUMN = 'source_cwds'

/** Provenance verdicts: content passes, a folder outranks the caller, or no recorded provenance. */
const VISIBLE = 0
const HIDDEN = 1
const UNKNOWN = 2

/**
 * The most distinct `source_cwds` strings one query remembers a verdict for.
 * Most rows hold a single folder, so real graphs stay far below it; past it a
 * value is classified afresh each time (still through the per-folder memo).
 */
const PROVENANCE_MEMO_LIMIT = 65_536

/**
 * Decode a stored `source_cwds` value into its folders, or null when the
 * provenance is unknown: null, absent, or anything but a JSON array of
 * strings. Unreadable reads as unknown, so a damaged value fails closed.
 *
 * @param {unknown} value
 * @returns {string[] | null}
 */
export function parseSourceCwds(value) {
  if (typeof value !== 'string') return null
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || !parsed.every((folder) => typeof folder === 'string')) return null
  return parsed
}

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
 * The one row-level withholding rule: a row whose `cwd` resolves to a class
 * that outranks the caller's on the restrictiveness lattice is withheld.
 * `withLocalOnlyVisibility` below applies it on the SQL read path; the grep
 * service applies it per scanned row on its file walk (which cannot route
 * through an `AsyncDataSource` wrapper). One exported predicate rather than
 * two copies, so the two read surfaces cannot drift on what "local-only"
 * hides. A cwd-less value returns false: those rows are `full`-class by
 * construction on cwd-bearing datasets (see the wrapper's contract below).
 *
 * A corrupt machine-local list makes `resolve` throw
 * (LocalOnlyListUnreadableError); callers let it propagate so the read
 * fails loudly rather than silently resolving to "nothing withheld".
 *
 * @ref LLP 0105 [implements]: caller class >= row class on the lattice, the shared predicate form
 * @ref LLP 0302#visibility-predicate [implements]: the lattice is shared as a predicate because the grep walk has no data source to wrap
 * @param {UsagePolicyResolver} resolver
 * @param {number} callerRank
 * @param {unknown} cwd
 * @returns {boolean}
 */
export function cwdWithheldFromCaller(resolver, callerRank, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return false
  return CLASS_RANK[resolver.resolve(cwd).class] > callerRank
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
 * - in such a dataset that also declares the `source_cwds` provenance column
 *   among its content columns (the graph tables), the row's recorded folders
 *   decide instead: content passes when none outranks the caller, and is
 *   suppressed (and also counted in `report.unprovenancedRows` when the
 *   value is null or unreadable) otherwise;
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
 * - the top-k hint is not forwarded where rows are withheld: a source that
 *   prunes to the k best rows (or files) does so BEFORE this filter, so
 *   withheld rows that sort first take the slots of visible ones. Where
 *   content is suppressed instead, the hint is kept unless it orders by a
 *   content column (pruning on the TRUE values would reveal their order) or
 *   the WHERE is kept from the source (pruning before that WHERE would drop
 *   the rows it matches).
 * - when suppression can apply, the WHERE hint is also kept from the source
 *   (`appliedWhere: false`): a pushed-down predicate over a content column
 *   would match against the TRUE value and reveal, by a row's presence,
 *   content the suppression then hides. The engine re-evaluates the WHERE
 *   over the suppressed row, where SQL null semantics make it unmatchable.
 * - `cwd` is forced into every projected scan and stripped back off the
 *   yielded row, so a `columns` projection that omits it cannot blind the
 *   filter.
 * - schema-aligned sources with cwd and no content declaration also expose
 *   a prepared scan that filters batch selections before yielding. It keeps
 *   lazy output vectors, but never forwards exact counts or range hints.
 * - schema-aligned sources without cwd suppress content as constant null
 *   vectors. Content demands keep WHERE residual, evaluated after suppression;
 *   structural columns retain lazy native reads and existing selections.
 *   With `source_cwds` declared, content demands read it once per batch and
 *   mask only the suppressed rows (see `prepareProvenanceScan`).
 *
 * @ref LLP 0105 [implements]: the one shared filter at the query read path; caller class >= row class on the lattice, never per-command
 * @ref LLP 0105#graph-provenance [implements]: rows lacking per-row cwd provenance get their declared content-bearing columns suppressed, never surfaced
 * @param {ScannableDataSource} source
 * @param {{
 *   resolver: UsagePolicyResolver,
 *   callerRank: number,
 *   contentColumns: string[],
 *   report: LocalOnlyVisibilityReport,
 * }} opts
 * @returns {ScannableDataSource}
 */
export function withLocalOnlyVisibility(source, opts) {
  const { resolver, callerRank, report } = opts
  const hasCwd = source.columns.includes('cwd')
  // Rows repeat a few hundred cwds across millions of rows, and resolve()
  // normalizes the path before its own lookup. Memoize the verdict per
  // distinct cwd for this wrapper, which sql.js builds once per query.
  /** @type {Map<unknown, boolean>} */
  const withheldByCwd = new Map()
  /**
   * @param {unknown} cwd
   * @returns {boolean}
   */
  function withheld(cwd) {
    let verdict = withheldByCwd.get(cwd)
    if (verdict === undefined) {
      verdict = cwdWithheldFromCaller(resolver, callerRank, cwd)
      withheldByCwd.set(cwd, verdict)
    }
    return verdict
  }
  const declaredContent = opts.contentColumns.filter((c) => source.columns.includes(c))
  // A content-declaring dataset whose rows record their folders: content is
  // judged per row from those folders instead of suppressed outright.
  const hasProvenance = !hasCwd && declaredContent.includes(PROVENANCE_COLUMN)
  // Most rows hold one folder, so distinct values stay near the folder count.
  /** @type {Map<string, number>} */
  const verdictByProvenance = new Map()
  /**
   * @param {unknown} value a row's `source_cwds`
   * @returns {number} VISIBLE, HIDDEN or UNKNOWN
   * @ref LLP 0616#read [implements]: null suppresses; else the highest folder rank against the caller's, memoized per distinct string
   */
  function provenanceVerdict(value) {
    if (typeof value !== 'string') return UNKNOWN
    let verdict = verdictByProvenance.get(value)
    if (verdict === undefined) {
      const folders = parseSourceCwds(value)
      verdict = folders === null ? UNKNOWN : folders.some(withheld) ? HIDDEN : VISIBLE
      if (verdictByProvenance.size < PROVENANCE_MEMO_LIMIT) verdictByProvenance.set(value, verdict)
    }
    return verdict
  }

  /** @type {ScannableDataSource} */
  const guarded = {
    // numRows intentionally absent (see fast-path discipline above).
    columns: source.columns,
    scan(options) {
      const requested = options?.columns
      const scannedColumns = requested ?? source.columns
      const forceCwd = hasCwd && requested !== undefined && !requested.includes('cwd')
      const toSuppress = declaredContent.filter((c) => scannedColumns.includes(c))
      const suppression = toSuppress.length > 0
      // @ref LLP 0616#read [implements]: content demanded forces source_cwds into the scan, as cwd is forced; stripped when not asked for
      const forceProvenance = hasProvenance && suppression && requested !== undefined && !requested.includes(PROVENANCE_COLUMN)
      const inner = source.scan({
        ...(options ?? {}),
        columns: forceCwd ? [...requested, 'cwd'] : forceProvenance ? [...requested, PROVENANCE_COLUMN] : requested,
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
              if (withheld(cwd)) {
                report.withheldRows += 1
                continue
              }
              yield forceCwd ? withoutColumn(row, 'cwd') : row
              continue
            }
            const passed = forceCwd ? withoutColumn(row, 'cwd') : row
            if (!suppression) {
              yield passed
              continue
            }
            if (hasProvenance) {
              const verdict = provenanceVerdict(await readCell(row, PROVENANCE_COLUMN))
              const out = forceProvenance ? withoutColumn(row, PROVENANCE_COLUMN) : row
              if (verdict === VISIBLE) {
                yield out
                continue
              }
              report.suppressedRows += 1
              if (verdict === UNKNOWN) report.unprovenancedRows += 1
              yield suppressColumns(out, toSuppress)
              continue
            }
            report.suppressedRows += 1
            report.unprovenancedRows += 1
            yield suppressColumns(passed, toSuppress)
          }
        },
      }
    },
  }
  // @ref LLP 0388#batch-filter [implements]: withholding-only sources preserve native batches
  // @ref LLP 0431#native-suppression [implements]: cwd-less graph sources suppress content as null vectors, avoiding the row adapter's whole-file allocations
  const schema = source.schema
  if (schema && source.prepareScan &&
    schema.fields.length === source.columns.length &&
    schema.fields.every((field, index) => field.name === source.columns[index])) {
    if (hasCwd && declaredContent.length === 0) {
      guarded.schema = schema
      guarded.prepareScan = prepareVisibleScan(source.prepareScan.bind(source), schema, { withheld, report })
    } else if (!hasCwd && declaredContent.length > 0) {
      guarded.schema = { fields: schema.fields.map(field => declaredContent.includes(field.name) ? { ...field, nullable: true } : field) }
      guarded.prepareScan = hasProvenance
        ? prepareProvenanceScan(source.prepareScan.bind(source), guarded.schema, declaredContent, { provenanceVerdict, report })
        : prepareSuppressedScan(source.prepareScan.bind(source), guarded.schema, declaredContent, report)
    }
  }
  // A row-path wrapper keeps the column types (suppressed content may be
  // null) so squirreling can still type literals before pushdown.
  if (schema && !guarded.schema) {
    guarded.schema = { fields: schema.fields.map(field => declaredContent.includes(field.name) ? { ...field, nullable: true } : field) }
  }
  return guarded
}

/**
 * Without cwd, every demanded content cell is null. Keep filters residual
 * whenever content is demanded so no source predicate can reveal its value.
 * Source selections (including deletes) and lazy structural vectors survive.
 * @param {PrepareScan} prepareScan
 * @param {RelationSchema} schema
 * @param {string[]} contentColumns
 * @param {LocalOnlyVisibilityReport} report
 * @returns {PrepareScan}
 */
function prepareSuppressedScan(prepareScan, schema, contentColumns, report) {
  return request => {
    const demandedContent = request.columns.some(demand =>
      schema.fields.some(field => field.id === demand.field && contentColumns.includes(field.name)))
    const ordersByContent = request.topK?.orderBy.some(term =>
      schema.fields.some(field => field.id === term.field && contentColumns.includes(field.name)))
    const filterWithheld = demandedContent && request.filter !== undefined
    const inner = prepareScan({
      ...request,
      filter: demandedContent ? undefined : request.filter,
      limit: undefined,
      offset: undefined,
      topK: ordersByContent || filterWithheld ? undefined : request.topK,
    })
    const suppressed = inner.schema.fields.map(field => contentColumns.includes(field.name))
    return {
      schema: { fields: inner.schema.fields.map((field, index) => suppressed[index] ? { ...field, nullable: true } : field) },
      residual: { filter: demandedContent ? request.filter : inner.residual.filter, limit: request.limit, offset: request.offset },
      properties: inner.properties.maxRows === undefined ? {} : { maxRows: inner.properties.maxRows },
      async *batches({ signal } = {}) {
        for await (const batch of inner.batches({ signal })) {
          signal?.throwIfAborted()
          if (demandedContent) {
            const count = selectedRowCount(batch.selection)
            report.suppressedRows += count
            report.unprovenancedRows += count
          }
          yield {
            selection: batch.selection,
            columns: batch.columns.map((column, columnIndex) => {
              if (suppressed[columnIndex]) return { type: 'constant', value: null, length: batch.selection.length }
              if (!('read' in column)) return column
              return { read: ({ selection, signal }) => readBatchColumn({ batch, columnIndex, selection, signal }) }
            }),
          }
        }
      },
    }
  }
}

/**
 * Content suppression judged per row from the recorded folders. A scan that
 * demands no content column is the plain suppressed scan, which then
 * suppresses nothing. One that does reads `source_cwds` once per batch (forced
 * into the scan, stripped from the output when not requested) and builds a
 * mask over the batch's base rows: a batch with no suppressed row passes its
 * vectors through unchanged, a fully suppressed batch gets constant nulls, and
 * a mixed batch masks each content column lazily, reading only its visible
 * rows. Every other LLP 0431 rule holds: the WHERE stays residual, a top-k
 * over content or ahead of that WHERE is not forwarded, and range hints and
 * exact counts never cross.
 *
 * @param {PrepareScan} prepareScan
 * @param {RelationSchema} schema
 * @param {string[]} contentColumns
 * @param {{ provenanceVerdict: (value: unknown) => number, report: LocalOnlyVisibilityReport }} opts
 * @returns {PrepareScan}
 * @ref LLP 0616#read [implements]: the native batch path reads the provenance vector once per batch and masks only what it must
 */
function prepareProvenanceScan(prepareScan, schema, contentColumns, { provenanceVerdict, report }) {
  const suppressedScan = prepareSuppressedScan(prepareScan, schema, contentColumns, report)
  const provenanceField = /** @type {NonNullable<ReturnType<typeof schema.fields.find>>} */ (schema.fields.find((field) => field.name === PROVENANCE_COLUMN))
  /** @param {number} id */
  const isContent = (id) => schema.fields.some((field) => field.id === id && contentColumns.includes(field.name))
  return (request) => {
    if (!request.columns.some((demand) => isContent(demand.field))) return suppressedScan(request)
    const ordersByContent = request.topK?.orderBy.some((term) => isContent(term.field))
    const columns = request.columns.map((demand) => demand.field === provenanceField.id
      ? { ...demand, mode: /** @type {const} */ ('required'), phase: 0 }
      : demand)
    if (!columns.some((demand) => demand.field === provenanceField.id)) {
      columns.push({ field: provenanceField.id, phase: 0, purpose: 'filter', mode: 'required' })
    }
    const inner = prepareScan({
      ...request,
      columns,
      filter: undefined,
      limit: undefined,
      offset: undefined,
      topK: ordersByContent || request.filter !== undefined ? undefined : request.topK,
    })
    const requestedFields = request.columns.map((demand) => {
      const field = schema.fields.find((field) => field.id === demand.field)
      if (!field) throw new Error(`Visibility scan requested unknown field id ${demand.field}`)
      return field
    })
    const indexOf = (/** @type {string} */ name) => {
      const index = inner.schema.fields.findIndex((field) => field.name === name)
      if (index < 0) throw new Error(`Visibility scan missing field ${name}`)
      return index
    }
    const provenanceIndex = indexOf(PROVENANCE_COLUMN)
    const outputIndices = requestedFields.map((field) => indexOf(field.name))
    const suppressed = requestedFields.map((field) => contentColumns.includes(field.name))
    return {
      schema: { fields: requestedFields },
      residual: { filter: request.filter, limit: request.limit, offset: request.offset },
      properties: inner.properties.maxRows === undefined ? {} : { maxRows: inner.properties.maxRows },
      async *batches({ signal } = {}) {
        for await (const batch of inner.batches({ signal })) {
          signal?.throwIfAborted()
          const provenance = await readBatchColumn({ batch, columnIndex: provenanceIndex, signal })
          const count = selectedRowCount(batch.selection)
          let hidden = 0
          let unknown = 0
          /** @type {Uint8Array | undefined} */
          let masked
          for (let i = 0; i < count; i++) {
            if (i % 4096 === 0) signal?.throwIfAborted()
            const verdict = provenanceVerdict(valueAt(provenance, i))
            if (verdict === VISIBLE) continue
            hidden++
            if (verdict === UNKNOWN) unknown++
            masked ??= new Uint8Array(batch.selection.length)
            masked[baseRowAt(batch.selection, i)] = 1
          }
          report.suppressedRows += hidden
          report.unprovenancedRows += unknown
          const mask = masked
          yield {
            selection: batch.selection,
            columns: outputIndices.map((columnIndex, output) => {
              if (suppressed[output] && hidden > 0) {
                if (hidden === count || !mask) return { type: 'constant', value: null, length: batch.selection.length }
                return { read: ({ selection, signal }) => readMasked(batch, columnIndex, selection, mask, signal) }
              }
              const column = batch.columns[columnIndex]
              if (!('read' in column)) return column
              // Keep the original batch and its read cache: deferred readers
              // may address sibling columns or physical row ordinals.
              return { read: ({ selection, signal }) => readBatchColumn({ batch, columnIndex, selection, signal }) }
            }),
          }
        }
      },
    }
  }
}

/**
 * Read one content column through a row mask: masked rows read null and are
 * never decoded; only the visible rows of `selection` are read.
 *
 * @param {AsyncBatch} batch
 * @param {number} columnIndex
 * @param {RowSelection} selection over the batch's base rows
 * @param {Uint8Array} masked 1 at each suppressed base row
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<ColumnVector>}
 */
async function readMasked(batch, columnIndex, selection, masked, signal) {
  const count = selectedRowCount(selection)
  const visible = new Uint32Array(count)
  let kept = 0
  for (let i = 0; i < count; i++) {
    const base = baseRowAt(selection, i)
    if (!masked[base]) visible[kept++] = base
  }
  /** @type {SqlPrimitive[]} */
  const values = new Array(count).fill(null)
  if (kept > 0) {
    const vector = await readBatchColumn({
      batch, columnIndex, signal,
      selection: { type: 'indices', indices: visible.subarray(0, kept), length: selection.length },
    })
    for (let i = 0, j = 0; i < count; i++) {
      if (!masked[baseRowAt(selection, i)]) values[i] = valueAt(vector, j++)
    }
  }
  return { type: 'values', values, length: count }
}

/**
 * The base-domain row a selection's `index`th selected row addresses.
 *
 * @param {RowSelection} selection
 * @param {number} index
 * @returns {number}
 */
function baseRowAt(selection, index) {
  if (selection.type === 'all') return index
  if (selection.type === 'range') return selection.start + index
  return selection.indices[index]
}

/**
 * Read provenance before exposing a batch, preserving the source's base row
 * domain and lazy output reads. Range hints and exact counts cannot cross
 * withholding: the engine applies them to the visible stream instead.
 *
 * @param {PrepareScan} prepareScan
 * @param {RelationSchema} schema
 * @param {{ withheld: (cwd: unknown) => boolean, report: LocalOnlyVisibilityReport }} opts
 * @returns {PrepareScan}
 */
function prepareVisibleScan(prepareScan, schema, { withheld, report }) {
  const cwdField = /** @type {NonNullable<ReturnType<typeof schema.fields.find>>} */ (schema.fields.find((field) => field.name === 'cwd'))
  return (request) => {
    const columns = request.columns.map((demand) => demand.field === cwdField.id
      ? { ...demand, mode: /** @type {const} */ ('required'), phase: 0 }
      : demand)
    if (!columns.some((demand) => demand.field === cwdField.id)) {
      columns.push({ field: cwdField.id, phase: 0, purpose: 'filter', mode: 'required' })
    }
    const inner = prepareScan({ ...request, columns, limit: undefined, offset: undefined, topK: undefined })
    const requestedFields = request.columns.map((demand) => {
      const field = schema.fields.find((field) => field.id === demand.field)
      if (!field) throw new Error(`Visibility scan requested unknown field id ${demand.field}`)
      return field
    })
    const indexOf = (/** @type {string} */ name) => {
      const index = inner.schema.fields.findIndex((field) => field.name === name)
      if (index < 0) throw new Error(`Visibility scan missing field ${name}`)
      return index
    }
    const cwdIndex = indexOf('cwd')
    const outputIndices = requestedFields.map((field) => indexOf(field.name))
    return {
      schema: { fields: requestedFields },
      residual: { filter: inner.residual.filter, limit: request.limit, offset: request.offset },
      properties: inner.properties.maxRows === undefined ? {} : { maxRows: inner.properties.maxRows },
      async *batches({ signal } = {}) {
        for await (const batch of inner.batches({ signal })) {
          signal?.throwIfAborted()
          const cwd = await readBatchColumn({ batch, columnIndex: cwdIndex, signal })
          const count = selectedRowCount(batch.selection)
          /** @type {Uint32Array | undefined} */
          let indices
          let kept = 0
          for (let i = 0; i < count; i++) {
            if (i % 4096 === 0) signal?.throwIfAborted()
            if (withheld(valueAt(cwd, i))) {
              report.withheldRows++
              if (!indices) {
                indices = new Uint32Array(count)
                for (let j = 0; j < kept; j++) indices[j] = j
              }
            } else {
              if (indices) indices[kept] = i
              kept++
            }
          }
          if (kept === 0) continue
          const visible = indices
            ? selectBatch(batch, { type: 'indices', indices: indices.subarray(0, kept), length: count })
            : batch
          yield {
            selection: visible.selection,
            columns: outputIndices.map((columnIndex) => {
              const column = batch.columns[columnIndex]
              if (!('read' in column)) return column
              // Keep the original batch and its read cache: deferred readers
              // may address sibling columns or physical row ordinals.
              return { read: ({ selection, signal }) => readBatchColumn({ batch, columnIndex, selection, signal }) }
            }),
          }
        }
      },
    }
  }
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
