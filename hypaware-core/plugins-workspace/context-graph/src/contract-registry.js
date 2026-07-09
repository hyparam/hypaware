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
        const sql = /** @type {string} */ (rule.sql)
        for (const col of contract.rowFilter.columns) {
          if (!rawSqlProjectsColumn(sql, col)) {
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

/**
 * True when a raw rule's SQL provably projects `col` in its top-level
 * SELECT list, so the contract's rowFilter (which reads `row[col]`) has the
 * column to test. A loose `sql.includes(col)` accepts false positives (a
 * `WHERE attributes IS NOT NULL`, or a different column whose name merely
 * contains `col`), so match the projection list only: take the identifiers
 * between the first top-level SELECT and its FROM, accept `*` / `table.*`,
 * and reduce each item to its output name (the alias after AS, or the column
 * past a `table.` qualifier). Anything ambiguous (a computed expression with
 * no alias) is treated as not-a-match, so the guard stays conservative and
 * rejects registration when the column is not provably projected. This is a
 * focused projection check, not a general SQL parser.
 *
 * @param {string} sql
 * @param {string} col
 * @returns {boolean}
 */
function rawSqlProjectsColumn(sql, col) {
  const projection = selectProjection(sql)
  if (projection === undefined) return false
  for (const item of splitTopLevel(projection)) {
    const name = projectionOutputName(item)
    if (name === '*' || name === col) return true
  }
  return false
}

/**
 * The text between the first top-level `SELECT` and its matching `FROM`
 * (both matched as standalone, case-insensitive keywords at parenthesis
 * depth 0, so a subquery's SELECT/FROM never leaks in). Undefined when the
 * SQL has no top-level `SELECT ... FROM`.
 *
 * @param {string} sql
 * @returns {string | undefined}
 */
function selectProjection(sql) {
  const upper = sql.toUpperCase()
  let depth = 0
  let selectEnd = -1
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && selectEnd === -1 && matchKeyword(upper, i, 'SELECT')) {
      selectEnd = i + 'SELECT'.length
      i = selectEnd - 1
    } else if (depth === 0 && selectEnd !== -1 && matchKeyword(upper, i, 'FROM')) {
      return sql.slice(selectEnd, i)
    }
  }
  return undefined
}

/**
 * True when `kw` sits at index `i` of `upper` as a whole word (its
 * neighbours are not identifier characters), so `FROM` matches but
 * `FROMAGE` or a `from_x` column does not.
 *
 * @param {string} upper
 * @param {number} i
 * @param {string} kw
 * @returns {boolean}
 */
function matchKeyword(upper, i, kw) {
  if (!upper.startsWith(kw, i)) return false
  const boundary = (/** @type {string | undefined} */ c) => c === undefined || !/[A-Z0-9_]/.test(c)
  return boundary(upper[i - 1]) && boundary(upper[i + kw.length])
}

/**
 * Split on commas at parenthesis depth 0, so a `f(a, b)` projection item
 * stays whole.
 *
 * @param {string} s
 * @returns {string[]}
 */
function splitTopLevel(s) {
  /** @type {string[]} */
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts
}

/**
 * The output name a single projection item exposes on the result row: the
 * alias after `AS`, `*` for a wildcard (`*` or `table.*`), or the column
 * past a `table.` qualifier. A bare computed expression has no derivable
 * column name and returns its trimmed text, which will not match a plain
 * column name, keeping the guard conservative.
 *
 * @param {string} item
 * @returns {string}
 */
function projectionOutputName(item) {
  let s = item.trim()
  if (s.length === 0) return ''
  const asMatch = /\s+AS\s+("?[A-Za-z0-9_]+"?)\s*$/i.exec(s)
  if (asMatch) return stripQuotes(asMatch[1])
  if (s === '*' || s.endsWith('.*')) return '*'
  const dot = s.lastIndexOf('.')
  if (dot !== -1) s = s.slice(dot + 1)
  return stripQuotes(s)
}

/**
 * @param {string} s
 * @returns {string}
 */
function stripQuotes(s) {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s
}
