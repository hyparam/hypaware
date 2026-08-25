// @ts-check

// @ref LLP 0022#shared-core-helpers: partition-spec derivation promoted out of
// the cache; consumed by the cache and the @hypaware/format-iceberg export
// alike, so it is core surface, not a cache internal (LLP 0003). [implements]

/**
 * @import { CachePartitioningDeclaration } from '../../../src/core/iceberg/types.js'
 * @import { Field, PartitionSpec, PartitionTransform, Schema } from 'icebird/src/types.js'
 */

const PARTITION_FIELD_ID_BASE = 1000

/**
 * Translate a dataset's `CachePartitioningDeclaration` into the Iceberg
 * `PartitionSpec` passed to `icebergCreateTable`. Partition field IDs
 * start at `PARTITION_FIELD_ID_BASE` (1000) to stay distinct from schema
 * field IDs, which start at 1.
 *
 * @param {CachePartitioningDeclaration} declaration
 * @param {Schema} schema
 * @returns {PartitionSpec}
 */
export function partitionSpecForDeclaration(declaration, schema) {
  /** @type {Map<string, Field>} */
  const fieldsByName = new Map()
  for (const f of schema.fields) {
    fieldsByName.set(f.name, f)
  }
  /** @type {PartitionSpec['fields']} */
  const fields = []
  let partitionFieldId = PARTITION_FIELD_ID_BASE
  for (const pf of declaration.iceberg.fields) {
    // @ref LLP 0311#declaration-split [implements]: a sortOnly field is a
    // lookup/sort column, declared for clustering but not partitioned on.
    if (pf.sortOnly) continue
    const sf = fieldsByName.get(pf.column)
    if (!sf) {
      if (pf.required) {
        throw new Error(
          `cache-iceberg: required partition field "${pf.column}" not found in schema`
        )
      }
      continue
    }
    fields.push({
      'source-id': sf.id,
      'field-id': partitionFieldId++,
      name: pf.column,
      transform: /** @type {PartitionTransform} */ (pf.transform),
    })
  }
  return { 'spec-id': 0, fields }
}

/**
 * Validate that a `CachePartitioningDeclaration` still describes the
 * existing `PartitionSpec`. Adding, removing, or changing a partition
 * field is partition-spec evolution and must be a deliberate migration,
 * not an accidental side effect.
 *
 * @param {CachePartitioningDeclaration} declaration
 * @param {PartitionSpec} existingSpec
 * @param {Schema} [schema]
 */
export function validatePartitionSpecStability(declaration, existingSpec, schema) {
  const expectedSpec = schema
    ? partitionSpecForDeclaration(declaration, schema)
    : {
        'spec-id': existingSpec['spec-id'],
        fields: declaration.iceberg.fields
          .filter(field => !field.sortOnly)
          .map((field, index) => ({
            'source-id': 0,
            'field-id': PARTITION_FIELD_ID_BASE + index,
            name: field.column,
            transform: /** @type {PartitionTransform} */ (field.transform),
          })),
      }
  const expectedNames = new Set(expectedSpec.fields.map(f => f.name))
  for (const expected of expectedSpec.fields) {
    const existing = existingSpec.fields.find(f => f.name === expected.name)
    if (!existing) {
      throw new Error(
        `cache-iceberg: partition field "${expected.name}" is new - adding a partition field is spec evolution and requires an explicit migration`
      )
    }
    if (existing.transform !== expected.transform) {
      throw new Error(
        `cache-iceberg: partition field "${expected.name}" changed transform from ${existing.transform} to ${expected.transform} - partition spec changes require an explicit migration`
      )
    }
  }
  for (const existing of existingSpec.fields) {
    if (!expectedNames.has(existing.name)) {
      // @ref LLP 0311#migration [implements]: a recorded partition field the
      // declaration now marks sortOnly is a pending re-partition, not drift.
      // Appends keep landing under the table's recorded spec; the maintenance
      // tick performs the generation-swap migration.
      if (declaredSortOnly(declaration, existing.name)) continue
      throw new Error(
        `cache-iceberg: partition field "${existing.name}" was removed - removing a partition field is spec evolution and requires an explicit migration`
      )
    }
  }
}

/**
 * @param {CachePartitioningDeclaration} declaration
 * @param {string} column
 * @returns {boolean}
 */
function declaredSortOnly(declaration, column) {
  return declaration.iceberg.fields.some(f => f.column === column && f.sortOnly === true)
}

/**
 * Does the table's recorded partition spec still partition on a column the
 * declaration has demoted to sortOnly? True means the table awaits the
 * one-time generation-swap re-partition; `validatePartitionSpecStability`
 * tolerates the mismatch in the meantime so appends keep landing under the
 * recorded spec.
 *
 * @ref LLP 0311#migration [implements]: the detection maintenance gates the
 *   migration rewrite on.
 * @param {CachePartitioningDeclaration} declaration
 * @param {PartitionSpec} existingSpec
 * @returns {boolean}
 */
export function partitionSpecMigrationDue(declaration, existingSpec) {
  return existingSpec.fields.some(f => declaredSortOnly(declaration, f.name))
}

/**
 * The declaration's lookup columns in declared order, as the sort-column
 * shape `appendRowsToTable` accepts. Every declared field participates,
 * partitioned or sortOnly: within a partition tuple the partitioned columns
 * are constant, so including them is harmless there and preserves one
 * clustering rule for every dataset.
 *
 * @ref LLP 0311#declaration-split [implements]: the fields stay the sort
 *   axis for the cache table itself, as they already are for the export.
 * @param {CachePartitioningDeclaration} declaration
 * @returns {{ column: string, direction: 'asc' }[]}
 */
export function sortColumnsForDeclaration(declaration) {
  return declaration.iceberg.fields.map(f => ({ column: f.column, direction: 'asc' }))
}
