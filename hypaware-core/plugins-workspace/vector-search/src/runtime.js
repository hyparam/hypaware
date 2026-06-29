// @ts-check

/**
 * Module-local activation state, mirroring the `@hypaware/gascity`
 * pattern: `activate()` captures what command bodies and the refresh
 * source need (paths, validated config, the resolved embedder), and
 * they read it back here. `CommandRunContext` deliberately does not
 * carry per-plugin paths.
 */

/**
 * @import { VectorSearchRuntime } from './types.js'
 */

/** @type {VectorSearchRuntime | null} */
let runtime = null

/** @param {VectorSearchRuntime} value */
export function setVectorSearchRuntime(value) {
  runtime = value
}

/**
 * @returns {VectorSearchRuntime}
 */
export function getVectorSearchRuntime() {
  if (!runtime) {
    throw new Error('@hypaware/vector-search: runtime not initialized - plugin is not activated')
  }
  return runtime
}
