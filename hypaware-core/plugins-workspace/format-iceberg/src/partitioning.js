// @ts-check

import { partitionSpecForDeclaration } from '../../../../src/core/iceberg/partition-spec.js'

import { icebergSchemaForColumns } from './schema.js'

/**
 * @import { ColumnSpec, DatasetRegistration } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration } from '../../../../src/core/iceberg/types.js'
 * @import { Schema, SortField, SortOrder } from 'icebird/src/types.js'
 * @import { DatasetPartitioning } from './types.js'
 */

// @ref LLP 0022#partition-derivation: the export partitions by a writer-owned
// day grain on the dataset's primaryTimestampColumn, derived independently of
// the cache's `cachePartitioning` (which would impose an unbounded
// per-conversation file count on an archive). [implements]
/**
 * Derive the export table's layout for a dataset: a `day(primaryTimestampColumn)`
 * partition plus a within-partition sort on the dataset's lookup columns.
 * Returns `null` when the dataset declares no `primaryTimestampColumn` present
 * in its schema: that dataset exports unpartitioned (V1 behavior unchanged).
 *
 * @param {DatasetRegistration | undefined} reg
 * @param {readonly ColumnSpec[]} columns
 * @returns {DatasetPartitioning | null}
 */
export function derivePartitioning(reg, columns) {
  if (!reg) return null
  const tsColumn = typeof reg.primaryTimestampColumn === 'string' ? reg.primaryTimestampColumn : ''
  if (!tsColumn) return null
  // A primaryTimestampColumn that isn't in the exported schema can't anchor a
  // day grain; fall back to unpartitioned rather than synthesize a bad spec.
  if (!columns.some((c) => c.name === tsColumn)) return null

  const schema = icebergSchemaForColumns(columns)
  /** @type {CachePartitioningDeclaration} */
  const declaration = {
    source: { columns: [tsColumn] },
    iceberg: { fields: [{ column: tsColumn, transform: 'day', required: true }] },
  }
  const partitionSpec = partitionSpecForDeclaration(declaration, schema)
  const sortOrder = sortOrderForLookup(reg, schema)
  return {
    declaration,
    partitionSpec,
    sortOrder,
    partitionSpecLabel: `day(${tsColumn})`,
    sortOrderLabel: sortOrder.fields.map((f) => nameForSourceId(schema, f)).join(','),
  }
}

// @ref LLP 0022#within-partition-sort: cluster each day partition by the
// dataset's declared identity (lookup) columns so a conversation lookup prunes
// row groups by min/max, without the file-count cost of partitioning on it.
// This is the one place the export reads `cachePartitioning`: sort axis only.
// [implements]
/**
 * Build a sort order from the dataset's declared identity columns
 * (`cachePartitioning.iceberg.fields`, transform `identity`), in declared order.
 * Returns an empty (unsorted) order when none apply: icebird treats that as a
 * no-op, so an undeclared dataset is day-partitioned but unsorted.
 *
 * @param {DatasetRegistration} reg
 * @param {Schema} schema
 * @returns {SortOrder}
 */
function sortOrderForLookup(reg, schema) {
  /** @type {Map<string, number>} */
  const idByName = new Map(schema.fields.map((f) => [f.name, f.id]))
  const declared = reg.cachePartitioning?.iceberg?.fields ?? []
  /** @type {SortField[]} */
  const fields = []
  for (const f of declared) {
    if (f.transform !== 'identity') continue
    const id = idByName.get(f.column)
    if (id === undefined) continue
    fields.push({
      'source-id': id,
      transform: 'identity',
      direction: 'asc',
      'null-order': 'nulls-last',
    })
  }
  // order-id 0 is conventionally "unsorted"; a real order uses 1.
  return fields.length > 0 ? { 'order-id': 1, fields } : { 'order-id': 0, fields: [] }
}

/**
 * @param {Schema} schema
 * @param {SortField} field
 * @returns {string}
 */
function nameForSourceId(schema, field) {
  const id = field['source-id']
  const match = schema.fields.find((f) => f.id === id)
  return match ? match.name : String(id)
}
