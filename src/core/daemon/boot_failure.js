// @ts-check

/**
 * How a daemon process reports a boot that did not come up whole: the label
 * for a boot that threw outright, and the record for one that came up without
 * a plugin. Both are written by the same two processes (`daemon/runtime.js`
 * and `daemon/gateway.js`) and read back off disk by callers that import
 * neither, which is why they live in a leaf module.
 *
 * @import { ActivationResult } from '../../../src/core/runtime/types.js'
 * @import { UnsatisfiedRequirement } from '../../../src/core/types.js'
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
 * The `errorKind` a snapshot entry carries when the plugin's `activate()` was
 * never called, because the dependency resolver eliminated it for an
 * unsatisfied `requires` (issue #1580).
 *
 * One value, not the resolver's own four: `hyp status` branches on it to pick
 * a message and a repair, and a kind added to the resolver later would then
 * arrive at that branch as a throw that never happened. The resolver's kind is
 * kept in front of its detail in `message`, which nothing matches on.
 */
export const REQUIRES_UNSATISFIED_ERROR_KIND = 'requires_unsatisfied'

/**
 * The one `DepGraphErrorKind` that eliminates nothing. `resolveDependencies`
 * pushes it straight onto `unsatisfied` for *every* provider of a clashing
 * capability, without the `recordReject` that adds a plugin to the eliminated
 * set, so it is never the reason a plugin is absent - not even when the same
 * plugin is eliminated by a later entry.
 */
const CAP_VERSION_CLASH = 'cap_version_clash'

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
 * Both doors that name a plugin are recorded, kept apart: the operator loses
 * the same capture through either, but a plugin the resolver eliminated never
 * ran a line of its own code, so the reason and the repair are not a throw's
 * (issue #1580).
 *
 * The other two doors into `unavailablePlugins` are deliberately not here. A
 * manifest that would not load is named by its directory rather than by a
 * plugin name, and what to render for it is open as issue #1576. A plugin the
 * boot profile withheld is not a shortfall in either writer: the processing
 * daemon boots the `config` profile, which withholds nothing the config
 * enabled, and the gateway profile withholds every non-routing plugin by
 * design, so persisting that door would report a hole on every healthy install.
 *
 * @param {object} args
 * @param {ActivationResult[]} args.activations `bootKernel`'s per-plugin results.
 * @param {UnsatisfiedRequirement[]} [args.unsatisfied] `bootKernel`'s
 *   `unsatisfiedRequirements`: what the dependency resolver rejected.
 * @param {DaemonLogger} args.log The process's own file log.
 * @returns {FailedPluginSnapshot[]} Empty when every plugin activated.
 */
export function recordFailedPlugins({ activations, unsatisfied = [], log }) {
  /** @type {FailedPluginSnapshot[]} */
  const failed = []
  /** @type {Set<string>} */
  const activated = new Set()
  /** @type {Set<string>} */
  const recorded = new Set()
  for (const result of activations) {
    if (result.ok) {
      activated.add(result.plugin.name)
      continue
    }
    const { errorKind, message } = result
    const name = result.plugin.name
    recorded.add(name)
    failed.push({
      name,
      errorKind,
      message: sanitizeLabel(message, MAX_ACTIVATION_MESSAGE_CHARS) ?? 'no message recorded',
    })
    log.error('daemon.plugin_activate_failed', { plugin: name, error_kind: errorKind, message })
  }
  for (const entry of unsatisfied) {
    const name = entry.plugin
    // Skipped by kind, not only by whether the plugin came up: a clash names
    // every provider, and a provider can *also* be eliminated by a later entry,
    // in which case taking the first leaves `hyp status` reporting the clash as
    // the reason a plugin is missing, the require that actually eliminated it
    // named nowhere, and the repair pointing at the wrong config line. A plugin
    // whose only entry is a clash needs no skip of its own: it stays in
    // `resolution.order`, so it always carries an activation record below.
    if (entry.errorKind === CAP_VERSION_CLASH) continue
    // One broken plugin per name, whatever the resolver's kind: a plugin can
    // miss several requires at once, and a kind added to the resolver later
    // must not be read as a second failure or as a throw.
    if (activated.has(name) || recorded.has(name)) continue
    recorded.add(name)
    const message = entry.detail ? `${entry.errorKind}: ${entry.detail}` : entry.errorKind
    failed.push({
      name,
      errorKind: REQUIRES_UNSATISFIED_ERROR_KIND,
      message: sanitizeLabel(message, MAX_ACTIVATION_MESSAGE_CHARS) ?? 'no message recorded',
    })
    log.error('daemon.plugin_requires_unsatisfied', { plugin: name, error_kind: entry.errorKind, message })
  }
  return failed
}
