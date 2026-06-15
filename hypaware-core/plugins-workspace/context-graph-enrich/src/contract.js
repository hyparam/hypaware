// @ts-check

import { COMMITTED_DATASET, PLUGIN_NAME } from './datasets.js'

/**
 * @import { ContractLike, GraphKit } from './types.d.ts'
 */

export const PROJECTOR = 'enrich.t2'
export const PROJECTOR_VERSION = 1

/** Edge type linking a T0 activity node to the enrichment node it produced. */
export const PRODUCED_EDGE = 'produced'

const SELECT_COMMITTED =
  `SELECT item_id, item_type, label, props, confidence, anchor_type, anchor_key, source_keys, committed_at FROM ${COMMITTED_DATASET}`

/**
 * Build the enrichment projection contract. Projects ONLY committed
 * knowledge (the graph contract never sees prospects), so a rejected
 * prospect — absent from `enrichment_committed` — never reaches the graph.
 *
 * One node rule emits a node of `item_type` per committed item (the
 * projector keys node-vs-edge off `rule.kind`, not `rule.type`, so a single
 * rule can mint Decision/Concept/Fact/… nodes). One edge rule links the
 * item's T0 anchor node to it via `produced`; `buildEdge` hashes the anchor
 * (type,key) with the shared id recipe, so the edge attaches to the existing
 * activity node rather than a duplicate.
 *
 * @param {GraphKit} kit
 * @returns {ContractLike}
 */
export function buildEnrichmentContract(kit) {
  const { buildNode, buildEdge } = kit.makeRowBuilders({
    sourceDataset: COMMITTED_DATASET,
    projector: PROJECTOR,
    projectorVersion: PROJECTOR_VERSION,
  })

  return {
    name: 'context-graph-enrich',
    plugin: PLUGIN_NAME,
    sourceDataset: COMMITTED_DATASET,
    projector: PROJECTOR,
    projectorVersion: PROJECTOR_VERSION,
    rules: [
      {
        kind: 'node',
        type: 'enrichment',
        sql: SELECT_COMMITTED,
        toRow(r) {
          const itemType = str(r.item_type)
          const itemId = str(r.item_id)
          if (!itemType || !itemId) return null
          const confidence = num(r.confidence)
          /** @type {Record<string, unknown>} */
          const props = { ...asObject(r.props) }
          if (confidence !== undefined) props.confidence = confidence
          return buildNode({
            type: itemType,
            key: itemId,
            label: str(r.label) || null,
            props,
            firstSeen: r.committed_at,
            sourceKeys: asObject(r.source_keys),
          })
        },
      },
      {
        kind: 'edge',
        type: PRODUCED_EDGE,
        sql: SELECT_COMMITTED,
        toRow(r) {
          const itemType = str(r.item_type)
          const itemId = str(r.item_id)
          const anchorType = str(r.anchor_type)
          const anchorKey = str(r.anchor_key)
          if (!itemType || !itemId || !anchorType || !anchorKey) return null
          return buildEdge({
            type: PRODUCED_EDGE,
            srcType: anchorType,
            srcKey: anchorKey,
            dstType: itemType,
            dstKey: itemId,
            firstSeen: r.committed_at,
            sourceKeys: asObject(r.source_keys),
          })
        },
      },
    ],
  }
}

/** @param {unknown} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** @param {unknown} v @returns {number | undefined} */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * A JSON column may arrive parsed (object) or as a string depending on the
 * query engine; normalize to a plain object.
 *
 * @param {unknown} v
 * @returns {Record<string, unknown>}
 */
function asObject(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return /** @type {Record<string, unknown>} */ (v)
  if (typeof v === 'string' && v.length > 0) {
    try {
      const parsed = JSON.parse(v)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // not JSON — ignore
    }
  }
  return {}
}
