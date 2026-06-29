// @ts-check

/**
 * @import { Contract } from './types.d.ts'
 * @import { PluginLogger } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Registry of projection contracts contributed by source plugins through the
 * `hypaware.context-graph` capability. The `graph project` command reads
 * `list()` and the engine runs every registered contract, so adding a source
 * is contributing a contract here, never editing the engine.
 *
 * Lives in the plugin (not the kernel): graph projection is a plugin concern,
 * not a core capture concern (hypaware LLP 0003 core-vs-plugin minimalism).
 *
 * @param {{ log?: PluginLogger }} [opts]
 * @ref LLP 0023#contract-contribution [implements]: one registry the engine iterates; sources contribute via the capability
 */
export function createContractRegistry(opts = {}) {
  const log = opts.log
  /** @type {Map<string, Contract>} */
  const contracts = new Map()

  /**
   * @param {Contract} contract
   */
  function register(contract) {
    if (!contract || typeof contract !== 'object') {
      throw new TypeError('registerContract: contract must be an object')
    }
    if (typeof contract.name !== 'string' || contract.name.length === 0) {
      throw new TypeError('registerContract: contract.name must be a non-empty string')
    }
    if (typeof contract.plugin !== 'string' || contract.plugin.length === 0) {
      throw new TypeError(`registerContract: '${contract.name}' missing plugin`)
    }
    if (typeof contract.sourceDataset !== 'string' || contract.sourceDataset.length === 0) {
      throw new TypeError(`registerContract: '${contract.name}' missing sourceDataset`)
    }
    if (typeof contract.projector !== 'string' || contract.projector.length === 0) {
      throw new TypeError(`registerContract: '${contract.name}' missing projector`)
    }
    if (!Number.isInteger(contract.projectorVersion)) {
      throw new TypeError(`registerContract: '${contract.name}' projectorVersion must be an integer`)
    }
    if (!Array.isArray(contract.rules) || contract.rules.length === 0) {
      throw new TypeError(`registerContract: '${contract.name}' rules must be a non-empty array`)
    }
    // Validate each rule's shape at registration, not at projection time: the
    // engine reads `kind`/`sql`/`toRow` directly (project.js) and routes by
    // `kind`, so a connector typo would otherwise surface as a confusing
    // mid-projection failure (or silently route rows into the wrong target
    // map) far from the contract that caused it.
    contract.rules.forEach((rule, i) => {
      const at = `'${contract.name}' rule ${i}`
      if (!rule || typeof rule !== 'object') {
        throw new TypeError(`registerContract: ${at} must be an object`)
      }
      if (rule.kind !== 'node' && rule.kind !== 'edge') {
        throw new TypeError(`registerContract: ${at} kind must be 'node' or 'edge'`)
      }
      if (typeof rule.type !== 'string' || rule.type.length === 0) {
        throw new TypeError(`registerContract: ${at} type must be a non-empty string`)
      }
      if (typeof rule.sql !== 'string' || rule.sql.length === 0) {
        throw new TypeError(`registerContract: ${at} sql must be a non-empty string`)
      }
      if (typeof rule.toRow !== 'function') {
        throw new TypeError(`registerContract: ${at} toRow must be a function`)
      }
    })

    const key = `${contract.plugin}\0${contract.name}`
    if (contracts.has(key)) {
      throw new Error(
        `registerContract: duplicate contract '${contract.name}' from plugin '${contract.plugin}'`
      )
    }
    contracts.set(key, contract)
    log?.info?.('graph.contract.register', {
      plugin: contract.plugin,
      contract: contract.name,
      source_dataset: contract.sourceDataset,
      rules: contract.rules.length,
    })
  }

  /**
   * All registered contracts, name-sorted so projection order is stable.
   * @returns {Contract[]}
   */
  function list() {
    return [...contracts.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  return { register, list }
}
