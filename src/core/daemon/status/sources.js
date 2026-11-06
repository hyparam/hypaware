// @ts-check

/**
 * Per-source facts for `hyp status`: the health a source reports, its
 * identity and details, and the sources a config implies.
 *
 * @import { SourceContribution, SourceStatus } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedSourceRegistry } from '../../../../src/core/registry/types.js'
 * @import { SourceHealth, SourceSnapshot } from '../../../../src/core/daemon/types.js'
 */

import { compareStrings } from '../../util/compare_strings.js'
import { sanitizeLabel } from '../../util/json_util.js'

/**
 * How much of a source-reported sentence the status file keeps. Nothing on
 * the way in bounds a plugin-authored string, and this file is rewritten
 * every tick and read back by a command that prints it. Wider than
 * `sanitizeLabel`'s default because these are sentences, not names.
 * @ref LLP 0164#gateway-tracks-what-core-cannot-name [constrained-by]: a plugin string bound for status.json is bounded where it is recorded
 */
const MAX_SOURCE_HEALTH_CHARS = 200

/** The health words `SourceStatus.state` is allowed to carry. */
const SOURCE_HEALTH_STATES = new Set(['starting', 'ready', 'degraded', 'stopped', 'error'])

/**
 * What a source said about itself, in the form the status file records it.
 *
 * Each field is validated on its own terms and dropped when it did not arrive
 * usable, because a plugin may return anything: the alternative is a status
 * file asserting `rowsWritten: NaN` or a state word no reader knows. The
 * daemon runs this on the way in and `hyp status` again on the way out, one
 * function rather than two because the file outlives the build that wrote it,
 * so what comes back out of it is no more trusted than what a plugin handed
 * in.
 *
 * @param {SourceStatus | SourceHealth | null | undefined} reported
 * @returns {SourceHealth | undefined}
 * @ref LLP 0394#health-rides-beside-state [implements]: the published fields are recorded under their published names, validated and bounded
 */
export function sourceHealth(reported) {
  if (!reported || typeof reported !== 'object') return undefined
  /** @type {SourceHealth} */
  const health = {}
  const state = reported.state
  if (typeof state === 'string' && SOURCE_HEALTH_STATES.has(state)) health.state = state
  const message = sanitizeLabel(reported.message, MAX_SOURCE_HEALTH_CHARS)
  if (message !== undefined) health.message = message
  if (typeof reported.rowsWritten === 'number' && Number.isFinite(reported.rowsWritten)) {
    health.rowsWritten = reported.rowsWritten
  }
  const lastError = sanitizeLabel(reported.lastError, MAX_SOURCE_HEALTH_CHARS)
  if (lastError !== undefined) health.lastError = lastError
  return Object.keys(health).length > 0 ? health : undefined
}

/**
 * The name and plugin a source contribution is listed and driven under, and
 * whether it is still answering with the name it registered under.
 *
 * `register` validated `name` and `plugin` once and stored the contribution by
 * reference, so what it validated is not what a later read returns: both are
 * free to be accessors. `sources.start(name, ctx)` resolves
 * `contributions.get(name)` and starts *that* contribution, so a `name`
 * answering with a neighbour's registered name starts the neighbour's source
 * under this plugin's activation context, its config slice and its capability
 * handles (issue #1535). `register` keys the Map by the string it validated, so
 * resolving the name back to this same object is what makes that key mean
 * anything here. It is the guard `readIdentity` already applies to a backfill
 * provider in `src/core/daemon/backfill_sweep.js`.
 *
 * `plugin` is read in the same guarded pass because the boot walk hoisted it
 * outside every try, and it picks the activation context beside the name, so it
 * is no more a bare label than the name is. It resolves back through
 * `ownerOf`, the plugin the kernel saw call `register`, rather than standing
 * as the contribution's own claim: a source started under a neighbour's
 * context gets that neighbour's config slice, paths, logger, capability
 * handles and permission context (issue #1541). The registry records an owner
 * only for a source registered through an activation context, so one
 * registered straight on the registry still resolves to what it declares, and
 * the resolution is gated on `registered` for the same reason the name is: an
 * `ownerOf` keyed by a name answering with a neighbour's would label this
 * contribution with the neighbour's plugin. A `plugin` that is no longer a
 * string degrades to the empty string, which every caller must treat as "no
 * plugin" rather than as a key to look up: it collapses the non-strings onto
 * one string, and a string is the shape an activation-context lookup takes.
 *
 * `registered` false is the refusal, and it covers both ways the read can end
 * badly: a name that resolves to another contribution or to none, and a read
 * that threw, including one that got the name and threw on the plugin. A
 * caller reporting the skip should say the identity would not read back rather
 * than name one of the two. The `name` beside the refusal is whatever the
 * contribution claimed before it (the empty string when it claimed nothing
 * readable), so that caller can name it without reading the plugin's object
 * again from inside its own handler.
 *
 * @param {ExtendedSourceRegistry | undefined} sources
 * @param {SourceContribution} contribution
 * @returns {{ name: string, plugin: string, registered: boolean }}
 * @ref LLP 0012#contribution-surface [constrained-by]: unique source names are the registry's keys, so a consumer resolves a contribution back through them before driving it by name
 */
export function readSourceIdentity(sources, contribution) {
  let name = ''
  let plugin = ''
  try {
    const claimed = contribution.name
    if (typeof claimed === 'string') name = claimed
    const declared = contribution.plugin
    if (typeof declared === 'string') plugin = declared
    // `register` refuses an empty name, so the empty string a contribution that
    // claimed nothing readable carries here resolves to nothing.
    const registered = sources?.get?.(name) === contribution
    const recorded = registered ? sources?.ownerOf?.(name) : undefined
    if (typeof recorded === 'string' && recorded.length > 0) plugin = recorded
    return { name, plugin, registered }
  } catch {
    // Reading the identity is what just failed. Whatever was read before the
    // throw still names the contribution better than nothing does.
    return { name, plugin, registered: false }
  }
}

/**
 * @param {SourceSnapshot | undefined} source
 * @returns {Record<string, unknown> | undefined}
 */
export function sourceDetails(source) {
  return source && typeof source.details === 'object' && source.details !== null
    ? /** @type {Record<string, unknown>} */ (source.details)
    : undefined
}

/**
 * Infer configured V1 source rows without activating plugins. `hyp
 * status` uses this path so rendering the report cannot bind the
 * user's gateway or OTLP ports.
 *
 * @param {string[]} activePlugins
 * @returns {SourceSnapshot[]}
 */
export function inferConfiguredSources(activePlugins) {
  const active = new Set(activePlugins)
  /** @type {SourceSnapshot[]} */
  const sources = []
  if (active.has('@hypaware/ai-gateway')) {
    sources.push({
      name: 'ai-gateway',
      plugin: '@hypaware/ai-gateway',
      state: 'stopped',
    })
  }
  if (active.has('@hypaware/otel')) {
    sources.push({
      name: 'otlp',
      plugin: '@hypaware/otel',
      state: 'stopped',
    })
  }
  return sources.sort((a, b) => compareStrings(a.name, b.name))
}
