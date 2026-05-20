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
 * in this process; tests reset it across smoke flows via
 * `clearGascityRuntime`.
 */

/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginLogger} PluginLogger */
/** @typedef {import('../../../../src/core/registry/sources.js').ExtendedSourceRegistry} ExtendedSourceRegistry */

/**
 * @typedef {Object} GascityRuntime
 * @property {string[]} cities             Attached city names (in attach order).
 * @property {PluginActivationContext} ctx Activation context shared across attach/reload.
 * @property {ExtendedSourceRegistry} sources Kernel source registry.
 * @property {PluginLogger} log            Plugin logger pinned to `@hypaware/gascity`.
 * @property {boolean} started             Whether `sources.start('gascity', ...)` has run.
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

export function clearGascityRuntime() {
  runtime = null
}
