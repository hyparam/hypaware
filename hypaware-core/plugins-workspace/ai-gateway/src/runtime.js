// @ts-check

/**
 * Module-local runtime singleton for `@hypaware/ai-gateway`. Holds the
 * activation `ctx`, the gateway `state` that the capability facade and
 * source listener share, and a `started` flag the smoke / future
 * commands can consult before driving a source start vs. reload.
 *
 * The shape mirrors `@hypaware/gascity`'s runtime — same lifecycle hook
 * pattern, same "saved-ctx-as-source-of-truth" convention so reloads
 * read the latest config from `runtime.ctx.config`.
 */

/** @import { AiGatewayRuntime } from './types.d.ts' */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */
/** @typedef {import('./api.js').GatewayState} GatewayState */

/** @type {AiGatewayRuntime | null} */
let runtime = null

/** @param {AiGatewayRuntime} value */
export function setAiGatewayRuntime(value) {
  runtime = value
}

export function clearAiGatewayRuntime() {
  runtime = null
}

/**
 * Resolve the runtime or throw if the plugin has not been activated.
 * Used by the smoke harness and future commands to drive source.start
 * without rebuilding an activation context.
 *
 * @returns {AiGatewayRuntime}
 */
export function requireAiGatewayRuntime() {
  if (!runtime) {
    throw new Error('@hypaware/ai-gateway: not activated yet — runtime singleton is empty')
  }
  return runtime
}
