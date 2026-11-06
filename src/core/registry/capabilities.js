// @ts-check

import { Attr, getKernelInstruments, getLogger } from '../observability/index.js'
import { matchesSemverRange } from '../semver.js'

/**
 * @import { CapabilityRegistration } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CapabilityRegistryHandle, InternalRegistration } from '../../../src/core/registry/types.js'
 */

/**
 * Build a `CapabilityRegistry` that emits the Phase 1 instrumentation
 * contract: `cap.provide`, `cap.require_satisfied`, and
 * `cap.require_missing` logs, plus the `hyp_capabilities_provided`
 * UpDownCounter on each provide. Duplicate-provider arbitration is
 * intentionally not handled here; dep_graph inspects `list()` after
 * provides and emits the `cap_version_clash` rejection.
 *
 * @returns {CapabilityRegistryHandle}
 */
export function createCapabilityRegistry() {
  /** @type {InternalRegistration[]} */
  const registrations = []
  const log = getLogger('capabilities')
  const instruments = getKernelInstruments()

  /**
   * Record a capability under a name and version this registry checked.
   *
   * Both are plugin-written: `ctx.provideCapability` forwards a plugin's
   * arguments here untouched, and `list()` republishes them as the `string`
   * fields of `CapabilityRegistration`, so anything unchecked here reaches
   * every consumer of the listing under a field its type says it cannot be
   * (issue #1559). Checked here rather than filtered in any one consumer,
   * which would leave the registry holding the value for the next reader.
   *
   * Refused with a TypeError, which is what every sibling registry on the
   * activation context raises for a non-string key (`SourceRegistry.register`,
   * `SinkRegistry.register`, `BackfillRegistry.register`,
   * `CommandRegistry.register`). The loader catches a throw out of
   * `activate()` and marks that one plugin failed, so the refusal costs the
   * offender its activation and no one else theirs.
   *
   * `version` is held to non-empty string and no further: it feeds
   * `matchesSemverRange`, which already answers `false` for any string it
   * cannot parse, and the manifest validator admits any string under
   * `provides.capabilities`, which `dep_graph` provides from, so demanding
   * semver here would refuse manifests that validate.
   *
   * @template T
   * @param {string} provider
   * @param {string} name
   * @param {string} version
   * @param {T} value
   */
  function provide(provider, name, version, value) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('CapabilityRegistry.provide: name must be a non-empty string')
    }
    if (typeof version !== 'string' || version.length === 0) {
      throw new TypeError(`CapabilityRegistry.provide: '${name}' version must be a non-empty string`)
    }
    registrations.push({ provider, name, version, value })
    instruments.capabilitiesProvided.add(1, { [Attr.CAPABILITY]: name })
    log.info('cap.provide', {
      [Attr.PLUGIN]: provider,
      [Attr.CAPABILITY]: name,
      hyp_capability_version: version,
      provider,
    })
  }

  /**
   * @template T
   * @param {string} requester
   * @param {string} name
   * @param {string} [range]
   * @returns {T}
   * @ref LLP 0006#resolution-rules [implements]: the single sanctioned cross-plugin channel; missing capability fails early
   */
  function requireCapability(requester, name, range) {
    const matches = findMatches(registrations, name, range)
    if (matches.length === 0) {
      log.error('cap.require_missing', {
        [Attr.PLUGIN]: requester,
        [Attr.CAPABILITY]: name,
        hyp_capability_range: range ?? '*',
        [Attr.ERROR_KIND]: 'cap_missing',
      })
      throw new Error(
        `capability '${name}' (range '${range ?? '*'}') is not provided; required by '${requester}'`
      )
    }
    const chosen = matches[0]
    log.info('cap.require_satisfied', {
      [Attr.PLUGIN]: requester,
      [Attr.CAPABILITY]: name,
      hyp_capability_range: range ?? '*',
      hyp_capability_version: chosen.version,
      provider: chosen.provider,
    })
    return /** @type {T} */ (chosen.value)
  }

  /**
   * Resolve a capability from a specific provider plugin. Returns the
   * value if the named provider registered the capability within the
   * semver range, or `undefined` otherwise.
   *
   * @template T
   * @param {string} provider
   * @param {string} name
   * @param {string} [range]
   * @returns {T | undefined}
   */
  function fromProvider(provider, name, range) {
    const match = registrations.find(
      (r) => r.provider === provider && r.name === name && matchesSemverRange(r.version, range)
    )
    return match ? /** @type {T} */ (match.value) : undefined
  }

  /**
   * @param {string} name
   * @param {string} [range]
   */
  function has(name, range) {
    return findMatches(registrations, name, range).length > 0
  }

  /** @returns {CapabilityRegistration[]} */
  function list() {
    return registrations.map((r) => ({
      name: r.name,
      version: r.version,
      provider: r.provider,
    }))
  }

  return {
    provide,
    require: requireCapability,
    has,
    list,
    fromProvider,
  }
}


/**
 * @param {InternalRegistration[]} registrations
 * @param {string} name
 * @param {string} [range]
 * @ref LLP 0006#two-kinds-of-dependency [implements]: version range travels with the require, never baked into the capability name
 */
function findMatches(registrations, name, range) {
  return registrations.filter((r) => r.name === name && matchesSemverRange(r.version, range))
}
