// @ts-check

// The enrichment schemas and their content declarations are maintained in one
// production module. This independent structural allowlist makes every added
// column an explicit privacy decision: CI fails until it is classified as
// content in datasets.js or structural here.
//
// @ref LLP 0105#graph-provenance [tests]: every unprovenanced enrichment column is classified content-or-structural

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMMITTED_COLUMNS,
  COMMITTED_DATASET,
  PROSPECT_COLUMNS,
  PROSPECTS_DATASET,
  RESOLUTION_COLUMNS,
  RESOLUTIONS_DATASET,
  enrichDatasetRegistration,
} from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/datasets.js'

const DATASETS = {
  [PROSPECTS_DATASET]: {
    columns: PROSPECT_COLUMNS,
    timestamp: 'created_at',
    structural: [
      'prospect_id', 'prospect_type', 'confidence', 'anchor_type',
      'source_dataset', 'extractor', 'extractor_version', 'created_at',
    ],
  },
  [RESOLUTIONS_DATASET]: {
    columns: RESOLUTION_COLUMNS,
    timestamp: 'resolved_at',
    structural: [
      'prospect_id', 'decision', 'curator', 'curator_version', 'resolved_at',
    ],
  },
  [COMMITTED_DATASET]: {
    columns: COMMITTED_COLUMNS,
    timestamp: 'committed_at',
    structural: [
      'item_type', 'confidence', 'anchor_type', 'source_dataset', 'curator',
      'curator_version', 'committed_at',
    ],
  },
}

for (const [dataset, spec] of Object.entries(DATASETS)) {
  const columns = spec.columns.map((column) => column.name)
  const content = enrichDatasetRegistration(dataset, spec.timestamp).localOnlyContentColumns ?? []

  test(`${dataset}: every declared content column is in the schema`, () => {
    for (const column of content) {
      assert.ok(columns.includes(column), `content column ${column} is not in ${dataset}`)
    }
  })

  test(`${dataset}: content and structural classifications are disjoint`, () => {
    assert.deepEqual(
      content.filter((column) => spec.structural.includes(column)),
      []
    )
  })

  test(`${dataset}: every schema column has a privacy classification`, () => {
    const classified = new Set([...content, ...spec.structural])
    assert.deepEqual(
      columns.filter((column) => !classified.has(column)),
      [],
      `unclassified ${dataset} column; add it to CONTENT_COLUMNS or this test's structural list`
    )
  })
}
