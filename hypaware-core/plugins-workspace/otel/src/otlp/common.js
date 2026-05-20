// @ts-check

/**
 * Shared helpers for flattening OTLP/JSON payloads into row records that
 * line up with the column schemas in `../datasets.js`. The functions here
 * mirror the contract of Collectivus's donor flatten code: lenient about
 * shape (missing fields land as `null` so nullable columns absorb the
 * default), strict about types (numbers stay numbers, attribute bags get
 * normalized to plain objects). Behavior is referenced from
 * `collectivus/src/collector.js` and `collectivus/src/otlp/common.js`;
 * the code here is a fresh re-implementation against the OTLP/JSON wire
 * shape only.
 */

const OTLP_NS_PER_MS = 1_000_000n
const MIN_DATE_MS = -8_640_000_000_000_000n
const MAX_DATE_MS = 8_640_000_000_000_000n

/**
 * Normalize an OTLP KeyValue[] (or any reasonable variant) into a plain
 * `{ key: value }` object. Returns `null` when there are no entries so
 * downstream code can use `??` defaults uniformly.
 *
 * @param {unknown} attrs
 * @returns {Record<string, unknown> | null}
 */
export function attrsToObject(attrs) {
  if (!Array.isArray(attrs)) return null
  /** @type {Record<string, unknown>} */
  const out = {}
  let count = 0
  for (const entry of attrs) {
    const pair = asObject(entry)
    if (!pair) continue
    const key = stringValue(pair.key)
    if (!key) continue
    out[key] = anyValue(pair.value)
    count += 1
  }
  return count === 0 ? null : out
}

/**
 * Decode an OTLP AnyValue wrapper into the underlying JS value. OTLP/JSON
 * encodes scalars as `{ stringValue: "x" }`, `{ intValue: "42" }`, etc.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function anyValue(value) {
  const obj = asObject(value)
  if (!obj) return value ?? null
  if ('stringValue' in obj) return typeof obj.stringValue === 'string' ? obj.stringValue : null
  if ('boolValue' in obj) return Boolean(obj.boolValue)
  if ('intValue' in obj) return intLike(obj.intValue)
  if ('doubleValue' in obj) return numberValue(obj.doubleValue)
  if ('bytesValue' in obj) return typeof obj.bytesValue === 'string' ? obj.bytesValue : null
  if ('arrayValue' in obj) {
    const arr = asObject(obj.arrayValue)
    const values = Array.isArray(arr?.values) ? arr.values : []
    return values.map(anyValue)
  }
  if ('kvlistValue' in obj) {
    return attrsToObject(asObject(obj.kvlistValue)?.values) ?? {}
  }
  return null
}

/**
 * Convert an OTLP `time_unix_nano` (string or number) into ISO 8601.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function otlpTimestampToIso(value) {
  if (value == null) return null
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return null
  }
  let asBig
  try {
    asBig = typeof value === 'bigint' ? value : BigInt(value)
  } catch {
    return null
  }
  const ms = asBig / OTLP_NS_PER_MS
  if (ms < MIN_DATE_MS || ms > MAX_DATE_MS) return null
  return new Date(Number(ms)).toISOString()
}

/**
 * Compute a span duration in milliseconds from two `time_unix_nano` values.
 *
 * @param {unknown} start
 * @param {unknown} end
 * @returns {number | null}
 */
export function otlpDurationMs(start, end) {
  if (start == null || end == null) return null
  if (typeof start !== 'string' && typeof start !== 'number' && typeof start !== 'bigint') return null
  if (typeof end !== 'string' && typeof end !== 'number' && typeof end !== 'bigint') return null
  try {
    const diff = BigInt(end) - BigInt(start)
    if (diff < 0n) return null
    return Number(diff) / Number(OTLP_NS_PER_MS)
  } catch {
    return null
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Coerce a finite number or `null`.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

/**
 * Coerce an int-like value (OTLP/JSON allows int64 as string) into a
 * BigInt-safe representation. Returns `null` when the value cannot
 * round-trip cleanly into a JS number.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function intLike(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return null
}

/**
 * Coerce a count-like value where INT64 precision matters (matches the
 * METRICS_COLUMNS INT64 columns: `count`, `valueInt`, `zeroCount`).
 *
 * @param {unknown} value
 * @returns {bigint | null}
 */
export function bigIntLike(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && value.length > 0) {
    try {
      return BigInt(value)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Normalize an OTLP InstrumentationScope into the trio of `scope_name`,
 * `scope_version`, `scope_attributes` that the column schemas surface.
 *
 * @param {unknown} scope
 * @returns {{ scope_name: string | null, scope_version: string | null, scope_attributes: Record<string, unknown> | null }}
 */
export function normalizeScope(scope) {
  const obj = asObject(scope) ?? {}
  return {
    scope_name: stringValue(obj.name),
    scope_version: stringValue(obj.version),
    scope_attributes: attrsToObject(obj.attributes),
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
export function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return /** @type {Record<string, unknown>} */ (value)
}
