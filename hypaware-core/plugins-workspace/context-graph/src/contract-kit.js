// @ts-check

import { nodeId, edgeId } from './ids.js'

export { nodeId, edgeId }

/**
 * @import { NodeSpec, EdgeSpec } from './types.js'
 */

/**
 * Build the provenance-stamping row builders for one source's contract.
 *
 * The id recipe (`ids.js`) and the provenance column shape live here, in the
 * graph plugin. A contract author receives `buildNode`/`buildEdge` through the
 * `hypaware.context-graph` capability and never reimplements either, so no
 * source can fork the id recipe (which would orphan every committed row, see
 * `ids.js`) or drift the provenance columns. The source supplies only the
 * per-row semantics (`type`, natural `key`, `props`, `sourceKeys`); the kit
 * stamps `node_id`/`edge_id` and `source_dataset`/`projector`/`projector_version`.
 *
 * @param {{ sourceDataset: string, projector: string, projectorVersion: number }} meta
 * @returns {{ buildNode: (spec: NodeSpec) => Record<string, unknown>, buildEdge: (spec: EdgeSpec) => Record<string, unknown> }}
 * @ref LLP 0023#contract-contribution [implements]: central id+provenance kit; sources own only their rules
 */
export function makeRowBuilders({ sourceDataset, projector, projectorVersion }) {
  /**
   * @param {NodeSpec} spec
   * @returns {Record<string, unknown>}
   */
  function buildNode(spec) {
    return {
      node_id: nodeId(spec.type, spec.key),
      node_type: spec.type,
      natural_key: spec.key,
      label: spec.label ?? null,
      props: spec.props && Object.keys(spec.props).length > 0 ? spec.props : null,
      first_seen: normalizeFirstSeen(spec.firstSeen),
      source_dataset: sourceDataset,
      source_keys: spec.sourceKeys,
      projector,
      projector_version: projectorVersion,
    }
  }

  /**
   * @param {EdgeSpec} spec
   * @returns {Record<string, unknown>}
   */
  function buildEdge(spec) {
    const src = nodeId(spec.srcType, spec.srcKey)
    const dst = nodeId(spec.dstType, spec.dstKey)
    return {
      edge_id: edgeId(src, spec.type, dst),
      edge_type: spec.type,
      src_id: src,
      dst_id: dst,
      src_type: spec.srcType,
      dst_type: spec.dstType,
      props: null,
      first_seen: normalizeFirstSeen(spec.firstSeen),
      source_dataset: sourceDataset,
      source_keys: spec.sourceKeys,
      projector,
      projector_version: projectorVersion,
    }
  }

  return { buildNode, buildEdge }
}

/**
 * Normalize a timestamp-ish value to an ISO string when possible. Projection
 * rows carry ISO strings; rows scanned back from Iceberg carry `Date`s.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeFirstSeen(value) {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return null
}
