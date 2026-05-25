// @ts-check

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/
const MAX_VALUE_LENGTH = 512
const MAX_ATTRS = 64

/**
 * Allowed status values. Other values are coerced to `failed` to keep
 * the attribute set queryable.
 */
const STATUS_VALUES = new Set(['ok', 'failed', 'skipped', 'degraded', 'cancelled'])

/**
 * Sanitize a single attribute key. Snake_case keys are passed through
 * unchanged; other keys are best-effort normalized.
 * @param {string} key
 * @returns {string}
 */
export function normalizeKey(key) {
  if (typeof key !== 'string' || key.length === 0) return 'unknown_key'
  if (SNAKE_CASE.test(key)) return key
  return key
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .replace(/_+/g, '_') || 'unknown_key'
}

/**
 * Bound a single attribute value into the shape OTel exporters expect.
 * Strings are truncated, objects are stringified.
 * @param {unknown} value
 * @returns {string|number|boolean|undefined}
 */
function normalizeValue(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) : value
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'boolean') return value
  try {
    const str = JSON.stringify(value)
    return str.length > MAX_VALUE_LENGTH ? str.slice(0, MAX_VALUE_LENGTH) : str
  } catch {
    return String(value).slice(0, MAX_VALUE_LENGTH)
  }
}

/**
 * Build an attribute bag for kernel/plugin emissions. All keys are
 * normalized to snake_case, `status` is constrained to the allowed
 * vocabulary, and cardinality is bounded by `MAX_ATTRS`.
 *
 * @param {Record<string, unknown>} [input]
 * @returns {Record<string, string|number|boolean>}
 */
export function buildAttrs(input) {
  if (!input || typeof input !== 'object') return {}
  /** @type {Record<string, string|number|boolean>} */
  const out = {}
  let count = 0
  for (const rawKey of Object.keys(input)) {
    if (count >= MAX_ATTRS) break
    const key = normalizeKey(rawKey)
    let value = normalizeValue(input[rawKey])
    if (value === undefined) continue
    if (key === 'status' && typeof value === 'string' && !STATUS_VALUES.has(value)) {
      value = 'failed'
    }
    out[key] = value
    count += 1
  }
  return out
}

/**
 * Convenience helpers for the most common attribute keys defined in
 * the self-instrumentation contract.
 */
export const Attr = Object.freeze({
  COMPONENT: 'hyp_component',
  PLUGIN: 'hyp_plugin',
  CAPABILITY: 'hyp_capability',
  OPERATION: 'hyp_operation',
  DATASET: 'hyp_dataset',
  SINK_INSTANCE: 'hyp_sink_instance',
  STATUS: 'status',
  ERROR_KIND: 'error_kind',
  SMOKE_NAME: 'smoke_name',
  SMOKE_STEP: 'smoke_step',
  DEV_RUN_ID: 'dev_run_id',
})
