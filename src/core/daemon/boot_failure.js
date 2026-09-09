// @ts-check

/**
 * How a daemon process reports a boot that did not come up whole: the label
 * for a boot that threw outright, and the record for one that came up without
 * a plugin. Both are written by the same two processes (`daemon/runtime.js`
 * and `daemon/gateway.js`) and read back off disk by callers that import
 * neither, which is why they live in a leaf module.
 *
 * @import { ActivationResult } from '../../../src/core/runtime/types.js'
 * @import { DaemonLogger, FailedPluginSnapshot } from '../../../src/core/daemon/types.js'
 */

/**
 * The label a daemon process stamps on the warning it persists when its boot
 * throws. In a `degraded` snapshot it is the only thing separating a boot that
 * never reached service from a daemon that served with a failed source.
 *
 * It lives in a leaf module because it is a contract between two writers
 * (`daemon/runtime.js` and `daemon/gateway.js`) and two readers that can
 * import neither them nor each other: `hyp status`'s abnormal-exit message
 * (`daemon/status.js`, which both writers import) and the self-updater's
 * stuck-boot re-probe (`update/self_update.js`, which stays import-light so a
 * crash-looping release can still jump forward).
 */
export const BOOT_FAILED_WARNING_PREFIX = 'boot_failed'

/**
 * Does a persisted snapshot's `warnings` carry that label? The caller decides
 * which `state` it accepts alongside; this reads the label alone, over
 * whatever the file held.
 *
 * @param {unknown} warnings
 * @returns {boolean}
 */
export function warningsRecordBootFailure(warnings) {
  return Array.isArray(warnings)
    && warnings.some((w) => String(w).startsWith(BOOT_FAILED_WARNING_PREFIX))
}

/**
 * Record the plugins a boot could not activate on the daemon's own file log,
 * and return them in the shape the status snapshot carries.
 *
 * The loader reports the throw too, but only through `getLogger`, which on a
 * shipped install has no exporter attached: no OTLP endpoint and no
 * `HYP_DEV_TELEMETRY`, so the record reached nothing the operator reads
 * (issue #1556). The file log is a store every install keeps, and one
 * `recent_error_count` counts in both processes
 * (LLP 0349#read-the-records-production-keeps).
 *
 * @param {object} args
 * @param {ActivationResult[]} args.activations `bootKernel`'s per-plugin results.
 * @param {DaemonLogger} args.log The process's own file log.
 * @returns {FailedPluginSnapshot[]} Empty when every plugin activated.
 */
export function recordFailedPlugins({ activations, log }) {
  /** @type {FailedPluginSnapshot[]} */
  const failed = []
  for (const result of activations) {
    if (result.ok) continue
    const { errorKind, message } = result
    const name = result.plugin.name
    failed.push({ name, errorKind, message })
    log.error('daemon.plugin_activate_failed', { plugin: name, error_kind: errorKind, message })
  }
  return failed
}
