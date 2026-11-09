// @ts-check

import { createLinearClient } from './client.js'

/** @import { LinearRuntime } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */
/** @type {LinearRuntime | null} */
let runtime = null
/** @param {LinearRuntime} value */
export function setLinearRuntime(value) { runtime = value }
export function requireLinearRuntime() {
  if (!runtime) throw new Error('@hypaware/linear: plugin is not active')
  return runtime
}
/** @param {LinearRuntime} rt @param {AbortSignal} [signal] */
export function getLinearClient(rt, signal) {
  return rt.clientFactory ? rt.clientFactory(signal) : createLinearClient({ config: rt.config, stateDir: rt.stateDir, env: rt.env, signal })
}
