// @ts-check

/**
 * The label `runDaemon` stamps on the warning it persists when boot throws.
 * In a `degraded` snapshot it is the only thing separating a boot that never
 * reached service from a daemon that served with a failed source.
 *
 * It lives in a leaf module because it is a contract between one writer
 * (`daemon/runtime.js`) and two readers that can import neither it nor each
 * other: `hyp status`'s abnormal-exit message (`daemon/status.js`, which
 * `runtime.js` imports) and the self-updater's stuck-boot re-probe
 * (`update/self_update.js`, which stays import-light so a crash-looping
 * release can still jump forward).
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
