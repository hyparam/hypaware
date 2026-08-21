// @ts-check

import { isDeepStrictEqual } from 'node:util'

import { rowsToBatches } from 'squirreling'

import { normalizeScanColumn } from './scan-column.js'

/**
 * @import { ScannableDataSource } from '../../../hypaware-plugin-kernel-types.js'
 * @import { AsyncCells, AsyncRow, AsyncDataSource, ExprNode, PreparedScan, RelationSchema, ScanProperties, ScanRequest } from 'squirreling'
 */

/**
 * The cell a row gets for a column its partition does not physically carry.
 * `undefined` is outside `SqlPrimitive`, hence the cast: it is nonetheless
 * what the row path already reads for such a column (squirreling's `asyncRow`
 * builds a cell per REQUESTED key and resolves it off an object that has no
 * such key), so padding introduces no new value.
 */
const absentCell = /** @type {AsyncCells[string]} */ (/** @type {unknown} */ (() => Promise.resolve(undefined)))

/**
 * Re-key one scanned row onto the exact column list the scan advertises,
 * filling any column the row lacks with an absent cell.
 *
 * The SQL engine derives a query's output column names ONCE, from the scan's
 * advertised list (`options.columns ?? source.columns`), then walks each row's
 * own `columns` to fill them positionally. A row narrower than the advertised
 * list therefore slides every later output name onto the wrong value, so
 * `SELECT *, git_remote` can answer with `git_remote`'s value under the name
 * of whichever column happens to sit at the star's short width. Aligning here
 * costs nothing on the common path (a row that already matches is returned
 * untouched) and makes the row shape match the schema the engine already told
 * the caller it was returning.
 *
 * @ref LLP 0241#alignment [implements]: rows a scan yields carry the scan's advertised column list, not the partition's physical one
 * @param {AsyncRow} row
 * @param {string[]} columns
 * @returns {AsyncRow}
 */
export function alignRowColumns(row, columns) {
  if (row.columns === columns) return row
  if (row.columns.length === columns.length) {
    let same = true
    for (let i = 0; i < columns.length; i++) {
      if (row.columns[i] !== columns[i]) {
        same = false
        break
      }
    }
    if (same) return row
  }
  /** @type {AsyncCells} */
  const cells = {}
  for (const name of columns) cells[name] = row.cells[name] ?? absentCell
  // `resolved` is keyed by name and only ever read by name, so the original
  // object stays correct: a padded column is simply missing from it, which is
  // the same `undefined` the padded cell resolves to.
  return row.resolved ? { columns, cells, resolved: row.resolved } : { columns, cells }
}

/**
 * `alignRowColumns` over a whole row stream.
 *
 * A scan yields many rows sharing one `columns` array (icebird and
 * `parquetDataSource` both build it once per batch), so the already-aligned
 * verdict is memoized by array identity: the ordinary case, where every
 * partition holds every advertised column, then costs one reference compare
 * per row instead of a name-by-name walk.
 *
 * @param {AsyncIterable<AsyncRow>} rows
 * @param {string[]} columns
 * @returns {AsyncGenerator<AsyncRow>}
 */
export async function* alignRows(rows, columns) {
  /** @type {string[] | undefined} */
  let alignedColumns
  for await (const row of rows) {
    if (row.columns === alignedColumns) {
      yield row
      continue
    }
    const out = alignRowColumns(row, columns)
    if (out === row) alignedColumns = row.columns
    yield out
  }
}

/**
 * Concatenate several `AsyncDataSource`s into one logical source. Columns
 * are unioned, `numRows` summed, and rows yielded partition-by-partition.
 *
 * The union reports `appliedWhere: false` and `appliedLimitOffset: false`,
 * so the SQL engine re-applies both over the merged stream. `limit`/`offset`
 * are stripped from the sub-scans. They are not distributive across a
 * concatenation; a sub-source that honors limit/offset pushdown (e.g. an
 * Iceberg partition) would otherwise drop its first `offset` rows per
 * partition and the engine would skip the offset again on the joined stream,
 * silently losing rows from paginated multi-partition queries.
 *
 * `where` is forwarded to a sub-source as a pushdown optimization **only when
 * that source advertises every column the predicate references**. A
 * heterogeneous union (partitions with additive schema drift) can otherwise
 * push a filter on a column that a given partition physically lacks, and a
 * parquet-backed source throws `parquet filter columns not found` rather than
 * reading the column as null. When a partition can't satisfy the predicate we
 * drop `where` for it and let the engine filter the concatenated stream (it
 * already owns the filter via `appliedWhere: false`). `columns` is always
 * forwarded, which adds no failure the merged stream did not already have, and
 * an absent column reads as `undefined` rather than `null` or a throw: every
 * row is padded out to the scan's advertised column list by `alignRows` below,
 * so a column a partition physically lacks is still a real cell that resolves
 * to `undefined` (LLP 0241 §alignment). One consequence is worth stating,
 * because it is the thing a maintainer gets wrong: `undefined` is outside
 * `SqlPrimitive` and `JSON.stringify` drops it, so a padded column renders as
 * an absent key even though the row object owns it. `Object.keys(row).length`
 * over a star therefore counts the advertised columns, not the physical ones,
 * and is not a way to discover what a partition holds. What no longer varies is
 * which ROW path the caller took: reading `resolved`, invoking the cell, and
 * evaluating the column in a `WHERE`, `ORDER BY`, `GROUP BY`, `DISTINCT` or an
 * aggregate all agree, where a short row made the last group throw
 * `ColumnNotFoundError` on the first partition lacking the column. The
 * `scanColumn` hook below is a DIFFERENT path and padding does not touch it: it
 * forwards each partition's chunks unchanged, so an absent column's value there
 * is whatever the partition streams, and a wrapper above the union normalizes
 * those holes if it wants them uniform (ai-gateway's `withSchemaColumns` maps
 * them to `null`). LLP 0241 left that `null`/`undefined` split between the two
 * paths unsettled on purpose. `test/core/union-source.test.js` pins these.
 *
 * Because a sub-source now emits exactly the columns it is asked for (see
 * `parquet-source.js`), forwarding `columns` also determines what the engine
 * gets to re-filter on: it relies on squirreling folding the WHERE columns
 * into the projection it hands to `scan()`, so the predicate's columns are
 * already present even though `appliedWhere: false` never asks for them
 * explicitly.
 *
 * @param {ScannableDataSource[]} sources
 * @returns {ScannableDataSource}
 * @ref LLP 0015#multi-partition-union [constrained-by]: the union must not forward limit/offset or offsets apply twice, nor push a filter a partition can't satisfy
 */
export function unionSources(sources) {
  /** @type {Set<string>} */
  const allColumns = new Set()
  let totalRows = 0
  let totalRowsKnown = true
  for (const s of sources) {
    for (const col of s.columns) allColumns.add(col)
    if (s.numRows === undefined) totalRowsKnown = false
    else totalRows += s.numRows
  }
  const columns = Array.from(allColumns)
  /** @type {ScannableDataSource} */
  const union = {
    columns,
    numRows: totalRowsKnown ? totalRows : undefined,
    scan(options) {
      // Defends against a runtime scan() with no options even though the
      // AsyncDataSource contract types it as required.
      const base = options ? { ...options, limit: undefined, offset: undefined } : options
      // Columns the predicate touches, computed once; null when `where` is
      // present but references a construct we can't safely push down (a
      // qualified identifier, subquery, or other non-local construct).
      const predicateColumns = base && base.where ? whereColumns(base.where) : undefined
      // What the engine will name this scan's output columns. A partition
      // that physically lacks some of them must still yield rows of this
      // shape, or the star expansion slides values onto neighbouring names.
      // @ref LLP 0241#alignment [implements]: the union's rows carry the union's column list, whatever each partition physically holds
      const scanColumns = base?.columns ?? union.columns
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const source of sources) {
            let subOptions = base
            if (base && base.where && !canPushWhere(source, predicateColumns)) {
              subOptions = { ...base, where: undefined }
            }
            const scan = source.scan(subOptions)
            yield* alignRows(scan.rows(), scanColumns)
          }
        },
      }
    },
  }
  const preparedSchema = commonPreparedSchema(sources, columns)
  if (preparedSchema) {
    union.schema = preparedSchema
    union.prepareScan = (request) => prepareUnionScan({ union, sources, schema: preparedSchema, request })
  }
  // The column-stream hook is offered only when EVERY partition can stream
  // the column; a mixed union stays row-based so the engine's fallback owns
  // correctness.
  //
  // With no `where`, the union fully owns limit/offset over the CONCATENATED
  // stream (they are not distributive across partitions, the same discipline
  // scan() applies); only the remaining-need upper bound is pushed per
  // partition, as an optimization that can never change the result.
  //
  // With a `where`, the predicate is forwarded per partition under the same
  // schema gate as scan() (a partition lacking a predicate column gets no
  // filter), the union's `appliedWhere` is the AND across partitions, and
  // limit/offset are neither forwarded nor applied: they are only meaningful
  // AFTER the filter, and a partition that ignores `where` but eagerly
  // slices would silently drop matching values. `appliedLimitOffset: false`
  // hands the post-filter slice back to the engine.
  // @ref LLP 0098#union-flags [implements]: merged appliedWhere is the AND across partitions; limit/offset never coexist with an unresolved where
  if (sources.every((s) => typeof s.scanColumn === 'function')) {
    union.scanColumn = ({ column, where, limit, offset, signal }) => {
      if (where) {
        const predicateColumns = whereColumns(where)
        // Probe every partition up front (starting a column scan does no IO
        // until its chunks are consumed) so the merged flags are known
        // before the engine decides whether to re-filter.
        const subs = sources.map((source) => {
          const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (source.scanColumn)
          const push = canPushWhere(source, predicateColumns)
          const options = push ? { column, where, signal } : { column, signal }
          const result = normalizeScanColumn(scanColumn(options), options)
          return { result, applied: push && result.appliedWhere }
        })
        return {
          appliedWhere: subs.every((s) => s.applied),
          appliedLimitOffset: false,
          async *chunks() {
            for (const sub of subs) {
              signal?.throwIfAborted()
              yield* sub.result.chunks()
            }
          },
        }
      }
      return {
        appliedWhere: true,
        appliedLimitOffset: true,
        async *chunks() {
          let remainingSkip = offset ?? 0
          let remaining = limit ?? Infinity
          for (const source of sources) {
            if (remaining <= 0) return
            signal?.throwIfAborted()
            // A known-empty or fully-skippable partition needs no stream.
            const numRows = source.numRows
            if (numRows !== undefined && numRows <= remainingSkip) {
              remainingSkip -= numRows
              continue
            }
            const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (source.scanColumn)
            const options = {
              column,
              // Per-partition upper bound: this partition can contribute at
              // most the values still owed, including any skip not yet spent.
              limit: remaining === Infinity ? undefined : remainingSkip + remaining,
              signal,
            }
            const sub = normalizeScanColumn(scanColumn(options), options)
            for await (const chunk of sub.chunks()) {
              signal?.throwIfAborted()
              let start = 0
              if (remainingSkip > 0) {
                if (remainingSkip >= chunk.length) {
                  remainingSkip -= chunk.length
                  continue
                }
                start = remainingSkip
                remainingSkip = 0
              }
              const end = remaining === Infinity
                ? chunk.length
                : Math.min(chunk.length, start + remaining)
              if (start === 0 && end === chunk.length) {
                yield chunk
                remaining -= chunk.length
              } else if (end > start) {
                const slice = []
                for (let i = start; i < end; i++) slice.push(chunk[i])
                yield slice
                remaining -= slice.length
              }
              if (remaining <= 0) break
            }
          }
        },
      }
    }
  }
  return union
}

/**
 * Find one logical schema the union can advertise without changing its
 * existing column order. Field ids may differ between independent Iceberg
 * tables, so compatibility is by ordered name, type, and nullability; each
 * prepared request is remapped to the child table's ids below.
 *
 * A drifted union deliberately returns undefined. Its row path owns absent
 * column padding, whose undefined/null semantics are not part of the native
 * batch contract (LLP 0261), so native batches must not guess a third answer.
 *
 * @param {ScannableDataSource[]} sources
 * @param {string[]} columns
 * @returns {RelationSchema | undefined}
 * @ref LLP 0294#partition-union [implements]: only aligned schemas expose one logical prepared union
 */
function commonPreparedSchema(sources, columns) {
  if (sources.length === 0) return undefined
  const first = sources[0]
  if (!first.schema || !first.prepareScan) return undefined
  if (!schemaMatchesColumns(first.schema, columns)) return undefined
  for (let i = 1; i < sources.length; i++) {
    const source = sources[i]
    if (!source.schema || !source.prepareScan) return undefined
    if (!schemasAreCompatible(first.schema, source.schema)) return undefined
  }
  return first.schema
}

/**
 * @param {RelationSchema} schema
 * @param {string[]} columns
 * @returns {boolean}
 */
function schemaMatchesColumns(schema, columns) {
  if (schema.fields.length !== columns.length) return false
  return schema.fields.every((field, index) => field.name === columns[index])
}

/**
 * @param {RelationSchema} left
 * @param {RelationSchema} right
 * @returns {boolean}
 */
function schemasAreCompatible(left, right) {
  if (left.fields.length !== right.fields.length) return false
  return left.fields.every((field, index) => {
    const candidate = right.fields[index]
    return field.name === candidate.name &&
      field.nullable === candidate.nullable &&
      isDeepStrictEqual(field.dataType, candidate.dataType)
  })
}

/**
 * Prepare one native scan over a concatenation. Range hints are never sent to
 * children because LIMIT/OFFSET are not distributive over partitions. Filter
 * hints are sent for pruning; native batches are concatenated only when every
 * child reports the same residual contract. A mixed residual falls back to
 * the union's established row semantics and adapts those rows to batches.
 *
 * @param {object} options
 * @param {ScannableDataSource} options.union
 * @param {ScannableDataSource[]} options.sources
 * @param {RelationSchema} options.schema
 * @param {ScanRequest} options.request
 * @returns {PreparedScan}
 * @ref LLP 0294#partition-union [implements]: remap field ids per child and keep range hints on the concatenated stream
 */
function prepareUnionScan({ union, sources, schema, request }) {
  const fieldsById = new Map(schema.fields.map((field) => [field.id, field]))
  const requestedFields = request.columns.map((demand) => {
    const field = fieldsById.get(demand.field)
    if (!field) throw new Error(`Prepared union requested unknown field id ${demand.field}`)
    return field
  })
  const requestedNames = requestedFields.map((field) => field.name)
  const childScans = sources.map((source) => {
    const fieldsByName = new Map(/** @type {RelationSchema} */ (source.schema).fields.map((field) => [field.name, field]))
    const columns = request.columns.map((demand, index) => ({
      ...demand,
      field: /** @type {NonNullable<ReturnType<typeof fieldsByName.get>>} */ (fieldsByName.get(requestedNames[index])).id,
    }))
    return /** @type {NonNullable<AsyncDataSource['prepareScan']>} */ (source.prepareScan)({
      ...request,
      columns,
      limit: undefined,
      offset: undefined,
    })
  })
  const nativeCompatible = childScans.every((scan) => {
    if (scan.schema.fields.length !== requestedNames.length) return false
    return scan.schema.fields.every((field, index) => field.name === requestedNames[index])
  }) && childScans.every((scan) => scan.residual.filter === childScans[0].residual.filter) &&
    (childScans[0].residual.filter === undefined || childScans[0].residual.filter === request.filter)

  if (!nativeCompatible) {
    return rowFallbackPreparedScan({ union, schema: { fields: requestedFields }, request })
  }

  /** @type {ScanProperties} */
  const properties = {}
  const exactRows = sumPreparedProperty(childScans, 'exactRows')
  const maxRows = sumPreparedProperty(childScans, 'maxRows')
  if (exactRows !== undefined) properties.exactRows = exactRows
  if (maxRows !== undefined) properties.maxRows = maxRows
  return {
    schema: { fields: requestedFields },
    residual: {
      filter: childScans[0].residual.filter,
      limit: request.limit,
      offset: request.offset,
    },
    properties,
    async *batches(options = {}) {
      for (const scan of childScans) {
        options.signal?.throwIfAborted()
        yield* scan.batches(options)
      }
    },
  }
}

/**
 * @param {PreparedScan[]} scans
 * @param {'exactRows' | 'maxRows'} property
 * @returns {number | undefined}
 */
function sumPreparedProperty(scans, property) {
  let total = 0
  for (const scan of scans) {
    const value = scan.properties[property]
    if (value === undefined) return undefined
    total += value
  }
  return total
}

/**
 * Preserve correctness when otherwise-compatible prepared children disagree
 * about residual work. The engine still gets a PreparedScan, but its batches
 * come from the union's established row implementation and the whole request
 * remains residual.
 *
 * @param {object} options
 * @param {ScannableDataSource} options.union
 * @param {RelationSchema} options.schema
 * @param {ScanRequest} options.request
 * @returns {PreparedScan}
 */
function rowFallbackPreparedScan({ union, schema, request }) {
  const names = schema.fields.map((field) => field.name)
  return {
    schema,
    residual: {
      filter: request.filter,
      limit: request.limit,
      offset: request.offset,
    },
    properties: {
      ...(request.filter === undefined && union.numRows !== undefined ? { exactRows: union.numRows } : {}),
      ...(union.numRows !== undefined ? { maxRows: union.numRows } : {}),
    },
    async *batches({ signal } = {}) {
      const scan = /** @type {NonNullable<AsyncDataSource['scan']>} */ (union.scan)({
        columns: names,
        where: request.filter,
        signal,
      })
      yield* rowsToBatches(scan.rows(), names, { signal })
    },
  }
}

/**
 * Whether `where` can be pushed to `source`: only when the predicate's column
 * set is fully enumerable and every column it names is present on the source.
 *
 * @param {AsyncDataSource} source
 * @param {Set<string> | null | undefined} predicateColumns
 * @returns {boolean}
 */
export function canPushWhere(source, predicateColumns) {
  if (!predicateColumns) return false
  const have = new Set(source.columns)
  for (const col of predicateColumns) {
    if (!have.has(col)) return false
  }
  return true
}

/**
 * Collect the column names a `where` predicate references. Returns null when
 * the predicate contains a construct whose column set can't be safely
 * enumerated locally (a qualified identifier, subquery, or correlated
 * reference). The caller then declines to push the predicate, which is always
 * safe because the engine re-applies it.
 *
 * @param {ExprNode | undefined} where
 * @returns {Set<string> | null}
 */
export function whereColumns(where) {
  /** @type {Set<string>} */
  const names = new Set()
  let enumerable = true

  /** @param {ExprNode | undefined} node */
  const walk = (node) => {
    if (!node || !enumerable) return
    switch (node.type) {
      case 'identifier':
        if (node.prefix) {
          enumerable = false
          return
        }
        names.add(node.name)
        return
      case 'literal':
      case 'interval':
      case 'star':
        return
      case 'unary':
        walk(node.argument)
        return
      case 'binary':
        walk(node.left)
        walk(node.right)
        return
      case 'cast':
        walk(node.expr)
        return
      case 'in valuelist':
        walk(node.expr)
        node.values.forEach(walk)
        return
      case 'function':
        node.args.forEach(walk)
        walk(node.filter)
        return
      case 'window':
        node.args.forEach(walk)
        node.partitionBy.forEach(walk)
        node.orderBy.forEach((o) => walk(o.expr))
        return
      case 'case':
        walk(node.caseExpr)
        for (const clause of node.whenClauses) {
          walk(clause.condition)
          walk(clause.result)
        }
        walk(node.elseResult)
        return
      default:
        // subquery / in / exists / not exists / anything new: bail.
        enumerable = false
    }
  }

  walk(where)
  return enumerable ? names : null
}

/**
 * A zero-row `AsyncDataSource` that still advertises a dataset's declared
 * columns, so a SELECT naming any of them validates and reads as empty
 * rather than throwing `ColumnNotFoundError`.
 *
 * @param {string[]} columns
 * @returns {ScannableDataSource}
 */
export function emptySource(columns) {
  return {
    columns,
    numRows: 0,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {},
      }
    },
  }
}
