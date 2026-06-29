// @ts-check

/**
 * Module-scoped runtime singleton for `@hypaware/gascity`.
 *
 * The plugin's `activate(ctx)` captures the kernel's source registry
 * and a shared activation context; `gascity attach|detach|list`
 * commands resolve through those captures so a fresh command
 * dispatch can drive the running source without needing the kernel
 * to surface a `sources` reference on `CommandRunContext`.
 *
 * The runtime is `null` when the plugin has not yet been activated
 * in this process.
 */

/**
 * @import { PluginActivationContext, PluginLogger } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedSourceRegistry } from '../../../../src/core/registry/types.d.ts'
 * @import { GascityRuntime } from './types.d.ts'
 */

/** @type {GascityRuntime | null} */
let runtime = null

/**
 * @param {GascityRuntime} value
 */
export function setGascityRuntime(value) {
  runtime = value
}

/**
 * @returns {GascityRuntime | null}
 */
export function getGascityRuntime() {
  return runtime
}

/**
 * @returns {GascityRuntime}
 */
export function requireGascityRuntime() {
  if (!runtime) {
    throw new Error('@hypaware/gascity: command invoked before plugin activation')
  }
  return runtime
}
