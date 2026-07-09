// @ts-check

/**
 * @import { Contract } from './types.js'
 * @import { PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
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
    // engine reads `kind`/`sql`/`columns`/`where`/`toRow` directly
    // (project.js) and routes by `kind`, so a connector typo would otherwise
    // surface as a confusing mid-projection failure (or silently route rows
    // into the wrong target map) far from the contract that caused it.
    // @ref LLP 0096#decision [implements]: exactly one read form per rule; `where` only rides `columns`; raw SQL must carry the rowFilter's columns itself
    if (contract.rowFilter !== undefined) {
      const filter = contract.rowFilter
      const at = `'${contract.name}' rowFilter`
      if (!filter || typeof filter !== 'object') {
        throw new TypeError(`registerContract: ${at} must be an object`)
      }
      if (!Array.isArray(filter.columns) || filter.columns.length === 0 || filter.columns.some((c) => typeof c !== 'string' || c.length === 0)) {
        throw new TypeError(`registerContract: ${at} columns must be non-empty strings`)
      }
      if (typeof filter.keep !== 'function') {
        throw new TypeError(`registerContract: ${at} keep must be a function`)
      }
    }
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
      const hasSql = typeof rule.sql === 'string' && rule.sql.length > 0
      const hasColumns = Array.isArray(rule.columns)
      if (hasSql === hasColumns) {
        throw new TypeError(`registerContract: ${at} must carry exactly one of sql or columns`)
      }
      if (hasColumns) {
        const cols = /** @type {unknown[]} */ (rule.columns)
        if (cols.length === 0 || cols.some((c) => typeof c !== 'string' || c.length === 0)) {
          throw new TypeError(`registerContract: ${at} columns must be non-empty strings`)
        }
        if (rule.where !== undefined) validatePredicate(rule.where, at)
      } else if (rule.where !== undefined) {
        throw new TypeError(`registerContract: ${at} where is only valid with columns`)
      }
      if (hasSql && contract.rowFilter) {
        for (const col of contract.rowFilter.columns) {
          if (!rule.sql?.includes(col)) {
            throw new TypeError(`registerContract: ${at} raw sql must select rowFilter column '${col}'`)
          }
        }
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
   * A `where` must be built from the three supported predicate shapes only,
   * with the value types the JS evaluator expects: anything else would
   * silently match nothing at projection time.
   *
   * @param {unknown} where
   * @param {string} at
   */
  function validatePredicate(where, at) {
    if (!where || typeof where !== 'object') {
      throw new TypeError(`registerContract: ${at} where must be an object`)
    }
    const w = /** @type {Record<string, unknown>} */ (where)
    for (const key of Object.keys(w)) {
      if (key !== 'eq' && key !== 'in' && key !== 'likePrefix') {
        throw new TypeError(`registerContract: ${at} where.${key} is not a supported predicate (eq, in, likePrefix)`)
      }
    }
    for (const shape of ['eq', 'likePrefix']) {
      const block = w[shape]
      if (block === undefined) continue
      if (!block || typeof block !== 'object') {
        throw new TypeError(`registerContract: ${at} where.${shape} must be an object`)
      }
      for (const [col, value] of Object.entries(block)) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new TypeError(`registerContract: ${at} where.${shape}.${col} must be a non-empty string`)
        }
      }
    }
    if (w.in !== undefined) {
      if (!w.in || typeof w.in !== 'object') {
        throw new TypeError(`registerContract: ${at} where.in must be an object`)
      }
      for (const [col, list] of Object.entries(w.in)) {
        if (!Array.isArray(list) || list.length === 0 || list.some((v) => typeof v !== 'string' || v.length === 0)) {
          throw new TypeError(`registerContract: ${at} where.in.${col} must be a non-empty array of strings`)
        }
      }
    }
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
