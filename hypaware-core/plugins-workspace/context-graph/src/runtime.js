// @ts-check

/**
 * Module-local runtime singleton for `@hypaware/context-graph`. Holds the
 * contract registry created at `activate()` so the `graph project` command,
 * which runs with a `CommandRunContext`, not the activation context, can read
 * the contracts source plugins contributed through the capability without
 * rebuilding an activation context. Mirrors `@hypaware/ai-gateway`'s
 * `runtime.js` (saved-state-as-source-of-truth) convention.
 *
 * @import { ContractRegistry } from './types.js'
 */

/** @type {{ registry: ContractRegistry } | null} */
let runtime = null

/** @param {{ registry: ContractRegistry }} value */
export function setGraphRuntime(value) {
  runtime = value
}

/**
 * Resolve the runtime or throw if the plugin has not been activated.
 * @returns {{ registry: ContractRegistry }}
 */
export function requireGraphRuntime() {
  if (!runtime) {
    throw new Error('@hypaware/context-graph: not activated yet - runtime singleton is empty')
  }
  return runtime
}
