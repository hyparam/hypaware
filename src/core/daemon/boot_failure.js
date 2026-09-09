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

import { sanitizeLabel } from '../util/json_util.js'

/**
 * How much of a failed `activate()`'s message the status snapshot keeps, and
 * so how much of it `hyp status` can quote. Wider than `sanitizeLabel`'s
 * default because this is a sentence, not a name, and the commonest one by far
 * is a module-resolution error whose operative half is the second path it
 * names ("... imported from <file>"), which the 120-character default cuts
 * off. The same width, for the same reason, as `MAX_SOURCE_HEALTH_CHARS` in
 * `status.js`, and applied in the same place: a plugin-authored string bound
 * for `status.json` is bounded where it is recorded, because nothing on the
 * way in bounds it and that file is rewritten for the life of the daemon. The
 * `daemon.log` record keeps the message whole - it is written once per boot,
 * and it is what the diagnostic's repair sends the operator to read.
 * @ref LLP 0164#gateway-tracks-what-core-cannot-name [constrained-by]: a plugin string bound for status.json is bounded where it is recorded
 */
export const MAX_ACTIVATION_MESSAGE_CHARS = 200

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
    failed.push({
      name,
      errorKind,
      message: sanitizeLabel(message, MAX_ACTIVATION_MESSAGE_CHARS) ?? 'no message recorded',
    })
    log.error('daemon.plugin_activate_failed', { plugin: name, error_kind: errorKind, message })
  }
  return failed
}
