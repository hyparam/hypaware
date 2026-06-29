// @ts-check

/**
 * Module-local runtime singleton (same pattern as context-graph and
 * vector-search): `activate()` captures the resolved capabilities + config,
 * and the daemon sources / commands retrieve it. Keeps source `start`
 * functions free of constructor plumbing.
 */

/**
 * @import { CompletionCapability, EmbedderCapability, VectorSearchCapability } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { EnrichRuntime } from './types.js'
 */

/** @type {EnrichRuntime | null} */
let runtime = null

/** @param {EnrichRuntime} value */
export function setEnrichRuntime(value) {
  runtime = value
}

/** @returns {EnrichRuntime} */
export function requireEnrichRuntime() {
  if (!runtime) {
    throw new Error('@hypaware/context-graph-enrich: not activated yet - runtime singleton is empty')
  }
  return runtime
}

/**
 * Lazily resolve + cache the completion capability. Deferred to first use
 * because the provider may activate after this plugin (and is swappable).
 *
 * @param {EnrichRuntime} rt
 * @returns {CompletionCapability}
 */
export function getCompletion(rt) {
  if (!rt._completion) {
    rt._completion = /** @type {CompletionCapability} */ (rt.ctx.requireCapability('hypaware.completion', '^1.0.0'))
  }
  return rt._completion
}

/**
 * Lazily resolve + cache the vector-search capability.
 *
 * @param {EnrichRuntime} rt
 * @returns {VectorSearchCapability}
 */
export function getVector(rt) {
  if (!rt._vector) {
    rt._vector = /** @type {VectorSearchCapability} */ (rt.ctx.requireCapability('hypaware.vector-search', '^1.0.0'))
  }
  return rt._vector
}

/**
 * Lazily resolve + cache the embedder capability. Used only by the T2
 * cold-remainder clustering ([§curate-clustering](LLP 0028)): prospects that
 * recall nothing are clustered by their own embeddings. Resolved best-effort:
 * an embedder provider is already present transitively (vector-search requires
 * one), but if it isn't, the caller falls back to session grouping rather than
 * failing the tick. Throws (caught by the caller) when no provider is installed.
 *
 * @param {EnrichRuntime} rt
 * @returns {EmbedderCapability}
 */
export function getEmbedder(rt) {
  if (!rt._embedder) {
    rt._embedder = /** @type {EmbedderCapability} */ (rt.ctx.requireCapability('hypaware.embedder', '^1.0.0'))
  }
  return rt._embedder
}
