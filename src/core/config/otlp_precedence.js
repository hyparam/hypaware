// @ts-check

/**
 * The OTLP environment keys that OUTRANK the general endpoint an `otel` attach
 * writes, and the one rule for deciding whether one is in force.
 *
 * In the OTLP environment-variable contract a per-signal key beats the generic
 * one, so `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` decides where log records go no
 * matter what `OTEL_EXPORTER_OTLP_ENDPOINT` says. Attach manages exactly the
 * nine keys of LLP 0258 #env-keys and none of these, which leaves one shape
 * that has to be said out loud rather than discovered.
 *
 * This lives in core, not in the `claude` plugin that writes the endpoint,
 * because two callers apply the same precedence rule from two directions:
 * `hyp attach claude` at write time, and `hyp status` on every run. A second
 * copy of the list is a copy that drifts.
 *
 * @ref LLP 0271#the-key-list [implements]
 */

/**
 * The keys, in report order.
 *
 * Endpoint, protocol and headers for the two signals attach actually turns on,
 * plus the general headers key. The headers keys are here from the other side
 * of the same hazard: they carry a collector's credential, and it would now
 * ride requests aimed at a loopback listener that never asked for it.
 *
 * Traces are deliberately absent - attach enables the logs and metrics
 * exporters and nothing else, so a traces endpoint redirects nothing HypAware
 * captures, and a warning list with a false alarm in it is how the true ones
 * get ignored.
 *
 * @type {readonly string[]}
 */
export const OTLP_PER_SIGNAL_OVERRIDE_KEYS = Object.freeze([
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_HEADERS',
])

/**
 * Whether a value read off one of those keys is in force.
 *
 * The empty string counts as set, and that is the whole point rather than a
 * completeness flourish: an exported-but-empty per-signal endpoint still
 * outranks the general one, so it blackholes instead of redirecting, which is
 * the variant with no receiving collector and therefore no other trace of the
 * failure anywhere. A truthiness test is exactly what misses it. `undefined`
 * and a JSON `null` off a settings file still read as absent.
 *
 * @ref LLP 0271#empty-counts-as-set [implements]
 * @param {unknown} value
 * @returns {boolean}
 */
export function otlpOverrideIsSet(value) {
  return value !== undefined && value !== null
}

/**
 * The subset of {@link OTLP_PER_SIGNAL_OVERRIDE_KEYS} standing in `env`.
 *
 * @param {Record<string, unknown> | undefined} env
 * @returns {string[]}
 */
export function perSignalOtlpOverrides(env) {
  if (!env) return []
  return OTLP_PER_SIGNAL_OVERRIDE_KEYS.filter(
    (key) => Object.hasOwn(env, key) && otlpOverrideIsSet(env[key])
  )
}
