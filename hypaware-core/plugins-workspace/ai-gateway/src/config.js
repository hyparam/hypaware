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
  // Off unless explicitly enabled. Proxy mode installs a machine-local CA and
  // decrypts traffic, which is a materially larger ask than repointing a base
  // URL, so it is never something a config silently acquires.
  // @ref LLP 0233#proxy-mode-is-explicit [implements]
  const proxyMode = cfg.proxy_mode === true
  const upstreamProxy = compileUpstreamProxy(cfg.upstream_proxy)
  // @ref LLP 0114#explicit-listen-fails-loudly [constrained-by]: only a defaulted listen may fall back on EADDRINUSE
  return {
    listen,
    listenConfigured,
    gatewayId,
    upstreams,
    redactHeaders,
    proxyMode,
    ...(upstreamProxy ? { upstreamProxy } : {}),
  }
}

/**
 * Compile the optional corporate-proxy setting.
 *
 * Accepts a URL string (`http://proxy.corp:8080`, optionally with credentials)
 * because that is the form customers already have in `HTTPS_PROXY`, so the
 * value can be copied across rather than retyped into fields.
 *
 * A malformed value compiles to `undefined` rather than throwing: the source
 * reports it, and refusing to boot the gateway over a mistyped proxy would take
 * capture down entirely rather than degrading to a direct connection.
 *
 * @param {unknown} raw
 * @returns {import('./types.js').UpstreamProxy | undefined}
 */
export function compileUpstreamProxy(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  /** @type {URL} */
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  if (!url.hostname) return undefined

  /** @type {import('./types.js').UpstreamProxy} */
  const proxy = { host: url.hostname, port }
  if (url.username) {
    /** @type {string} */
    let userinfo
    try {
      // `URL` leaves an invalid escape (`p%zz`) in the credential untouched,
      // and `decodeURIComponent` throws a `URIError` on it. Unguarded, one
      // mistyped character in `upstream_proxy` propagated out of
      // `compileConfig` and took the whole gateway source down at start,
      // which is the outcome this function's contract exists to prevent.
      userinfo = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
    } catch {
      return undefined
    }
    proxy.authorization = `Basic ${Buffer.from(userinfo).toString('base64')}`
  }
  return proxy
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
