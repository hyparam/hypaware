// @ts-check

/**
 * Readers for values that come back off disk from the status snapshot or a
 * client's own files, where a field may be missing or the wrong type.
 */

/** @param {unknown} v @returns {string[]} */
export function stringList(v) {
  if (!Array.isArray(v)) return []
  return /** @type {string[]} */ (v.filter((s) => typeof s === 'string' && s.length > 0))
}

/** @param {unknown} v @returns {number | undefined} */
export function nonNegativeInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
}

/** @param {unknown} value @returns {number | undefined} */
export function parseIsoMs(value) {
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}
