// @ts-check

// Guard: the context-graph content-column allowlist (CONTENT_COLUMNS, surfaced
// as each dataset registration's `localOnlyContentColumns`) is hand-maintained
// alongside NODE_COLUMNS / EDGE_COLUMNS, and it is the SOLE set suppressed for
// unprovenanced graph rows (LLP 0105). If a future content-bearing column is
// added to the schema but not classified, it would silently surface to
// synced/unknown callers. This test fails when a column is neither declared as
// content nor explicitly allowlisted here as structural, forcing whoever adds a
// column to classify it.
//
// @ref LLP 0105#graph-provenance [tests]: every graph column is classified content-or-structural; an unclassified new column fails CI

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NODE_COLUMNS,
  EDGE_COLUMNS,
  graphDatasetRegistration,
} from '../../hypaware-core/plugins-workspace/context-graph/src/datasets.js'

/**
 * The structural (non-content) columns per graph dataset: content-addressed
 * ids, node/edge types, timestamps, and the inline-provenance scaffolding that
 * names the source WITHOUT carrying session-derived text or paths. Maintained
 * HERE, independently of datasets.js, so that adding a column to the schema
 * without also classifying it (content in CONTENT_COLUMNS, or structural here)
 * leaves it in neither set and trips the "every column is classified" assertion.
 * `source_keys` is deliberately NOT here: it carries the originating row keys
 * and is classified as content.
 */
const STRUCTURAL_COLUMNS = {
  node: ['node_id', 'node_type', 'first_seen', 'source_dataset', 'projector', 'projector_version'],
  edge: ['edge_id', 'edge_type', 'src_id', 'dst_id', 'src_type', 'dst_type', 'first_seen', 'source_dataset', 'projector', 'projector_version'],
}

for (const dataset of /** @type {const} */ (['node', 'edge'])) {
  const columns = (dataset === 'node' ? NODE_COLUMNS : EDGE_COLUMNS).map((c) => c.name)
  const content = graphDatasetRegistration(dataset).localOnlyContentColumns ?? []
  const structural = STRUCTURAL_COLUMNS[dataset]

  test(`${dataset}: every declared content column is a real schema column`, () => {
    for (const c of content) {
      assert.ok(columns.includes(c), `content column ${c} is not in the ${dataset} schema`)
    }
  })

  test(`${dataset}: content and structural allowlists are disjoint`, () => {
    const overlap = content.filter((c) => structural.includes(c))
    assert.deepEqual(overlap, [], `columns classified as both content and structural: ${overlap.join(', ')}`)
  })

  test(`${dataset}: every schema column is classified as content or structural`, () => {
    const classified = new Set([...content, ...structural])
    const unclassified = columns.filter((c) => !classified.has(c))
    assert.deepEqual(
      unclassified,
      [],
      `unclassified ${dataset} column(s): ${unclassified.join(', ')} - add each to CONTENT_COLUMNS (if it can carry session-derived text/paths) or to STRUCTURAL_COLUMNS in this test`
    )
  })
}
