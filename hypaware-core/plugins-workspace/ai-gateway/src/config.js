// @ts-check

/**
 * @import { AiGatewayConfig, UpstreamConfig } from './types.js'
 */

// @ref LLP 0114#fixed-default-port [implements]: a stable well-known default (0x4859 = "HY") instead of an ephemeral bind
const DEFAULT_LISTEN = '127.0.0.1:18521'
const DEFAULT_GATEWAY_ID = 'hypaware-local'

/** The bind the default falls back to when its port is already taken. */
export const FALLBACK_LISTEN = '127.0.0.1:0'

/**
 * Validate and normalize the ai-gateway config slice. Returns the
 * compiled shape used by the source/listener. Missing or malformed
 * `upstreams` compiles to an empty list rather than an error: adapter
 * plugins contribute the rest of the routing table as presets after this
 * runs, and a config that wants the gateway plugin only for its dataset and
 * materializer (`@hypaware/hermes`) legitimately names no upstream at all.
 * The source decides what an empty table means, not this function.
 *
 * @param {unknown} raw
 * @returns {AiGatewayConfig}
 */
export function compileConfig(raw) {
  const cfg = isObject(raw) ? raw : {}
  const listenConfigured = typeof cfg.listen === 'string' && cfg.listen.length > 0
  const listen = listenConfigured ? /** @type {string} */ (cfg.listen) : DEFAULT_LISTEN
  const gatewayId = typeof cfg.gateway_id === 'string' && cfg.gateway_id.length > 0
    ? cfg.gateway_id
    : DEFAULT_GATEWAY_ID
  const upstreams = compileUpstreams(cfg.upstreams)
  const redactHeaders = compileStringArray(cfg.redact_headers)
  // @ref LLP 0114#explicit-listen-fails-loudly [constrained-by]: only a defaulted listen may fall back on EADDRINUSE
  return { listen, listenConfigured, gatewayId, upstreams, redactHeaders }
}

/**
 * Compile the configured upstream entries into routing-table rows, skipping
 * any entry that lacks a `name` or a `base_url`.
 *
 * The skip is silent by design at this layer: this function has no logger and
 * no way to tell a typo from a shape the caller meant to ignore. It is not
 * silent overall. The source compares this list's length against the raw entry
 * count and both logs the difference and publishes it as
 * `details.upstreams_dropped`, from which `hyp status` warns
 * (`gateway_upstreams_dropped`, or `gateway_idle_no_upstreams` when nothing
 * survived at all). Anything that starts calling this without making that
 * comparison reopens the blind spot.
 *
 * @param {unknown} raw
 * @returns {UpstreamConfig[]}
 */
export function compileUpstreams(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {UpstreamConfig[]} */
  const out = []
  for (const entry of raw) {
    if (!isObject(entry)) continue
    const name = stringField(entry.name)
    const baseUrl = stringField(entry.base_url)
    if (!name || !baseUrl) continue
    const pathPrefix = stringField(entry.path_prefix) ?? '/'
    /** @type {UpstreamConfig} */
    const upstream = { name, base_url: baseUrl, path_prefix: pathPrefix }
    const provider = stringField(entry.provider)
    if (provider) upstream.provider = provider
    const priority = numberField(entry.priority)
    if (priority !== undefined) upstream.priority = priority
    out.push(upstream)
  }
  return out
}

/**
 * Parse `host:port`. IPv6 literals may be wrapped in `[]`. Throws on a
 * malformed value: the gateway will surface that as an activation
 * failure rather than silently bind to a wrong address.
 *
 * @param {string} listen
 * @returns {{ host: string, port: number }}
 */
export function parseListen(listen) {
  if (typeof listen !== 'string' || listen.length === 0) {
    throw new Error(`ai-gateway: invalid listen address: ${listen}`)
  }
  const idx = listen.lastIndexOf(':')
  if (idx === -1) {
    throw new Error(`ai-gateway: invalid listen address (missing port): ${listen}`)
  }
  const rawHost = listen.slice(0, idx)
  const portStr = listen.slice(idx + 1)
  const port = Number.parseInt(portStr, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(port) !== portStr) {
    throw new Error(`ai-gateway: invalid port in listen address: ${listen}`)
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost
  if (host.length === 0) {
    throw new Error(`ai-gateway: invalid listen address (missing host): ${listen}`)
  }
  return { host, port }
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** @param {unknown} v */
function stringField(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** @param {unknown} v */
function numberField(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return undefined
}

/** @param {unknown} raw */
function compileStringArray(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {string[]} */
  const out = []
  for (const v of raw) {
    if (typeof v === 'string' && v.length > 0) out.push(v)
  }
  return out
}
