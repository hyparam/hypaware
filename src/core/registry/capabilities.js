// @ts-check

import { Attr, getKernelInstruments, getLogger } from '../observability/index.js'
import { matchesSemverRange } from '../semver.js'

/**
 * @import { CapabilityRegistration, CapabilityRegistry } from '../../../collectivus-plugin-kernel-types'
 * @import { InternalRegistration } from './types.d.ts'
 */

/**
 * Build a `CapabilityRegistry` that emits the Phase 1 instrumentation
 * contract: `cap.provide`, `cap.require_satisfied`, and
 * `cap.require_missing` logs, plus the `hyp_capabilities_provided`
 * UpDownCounter on each provide. Duplicate-provider arbitration is
 * intentionally not handled here — dep_graph inspects `list()` after
 * provides and emits the `cap_version_clash` rejection.
 *
 * @returns {CapabilityRegistry & { _registrations: () => InternalRegistration[] }}
 */
export function createCapabilityRegistry() {
  /** @type {InternalRegistration[]} */
  const registrations = []
  const log = getLogger('capabilities')
  const instruments = getKernelInstruments()

  /**
   * @template T
   * @param {string} provider
   * @param {string} name
   * @param {string} version
   * @param {T} value
   */
  function provide(provider, name, version, value) {
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

  function _registrations() {
    return registrations.slice()
  }

  return {
    provide,
    require: requireCapability,
    has,
    list,
    _registrations,
  }
}


/**
 * @param {InternalRegistration[]} registrations
 * @param {string} name
 * @param {string} [range]
 */
function findMatches(registrations, name, range) {
  return registrations.filter((r) => r.name === name && matchesSemverRange(r.version, range))
}
