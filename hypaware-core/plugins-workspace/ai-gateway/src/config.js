// @ts-check

/**
 * Validate and normalize the ai-gateway config slice. Returns the
 * compiled shape used by the source/listener. Validation is strict:
 * missing or malformed `upstreams` is rejected loudly because the
 * gateway has nothing useful to do without at least one upstream.
 *
 * @typedef {Object} UpstreamConfig
 * @property {string} name
 * @property {string} base_url
 * @property {string} path_prefix
 * @property {string} [provider]
 *
 * @typedef {Object} AiGatewayConfig
 * @property {string} listen           Address as "host:port" (defaults to 127.0.0.1:0).
 * @property {UpstreamConfig[]} upstreams
 * @property {string[]} redactHeaders  Extra headers to redact in stored rows.
 */

const DEFAULT_LISTEN = '127.0.0.1:0'

/**
 * @param {unknown} raw
 * @returns {AiGatewayConfig}
 */
export function compileConfig(raw) {
  const cfg = isObject(raw) ? raw : {}
  const listen = typeof cfg.listen === 'string' && cfg.listen.length > 0
    ? cfg.listen
    : DEFAULT_LISTEN
  const upstreams = compileUpstreams(cfg.upstreams)
  const redactHeaders = compileStringArray(cfg.redact_headers)
  return { listen, upstreams, redactHeaders }
}

/**
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
    const pathPrefix = stringField(entry.path_prefix) ?? '/'
    if (!name || !baseUrl) continue
    /** @type {UpstreamConfig} */
    const upstream = { name, base_url: baseUrl, path_prefix: pathPrefix }
    const provider = stringField(entry.provider)
    if (provider) upstream.provider = provider
    out.push(upstream)
  }
  return out
}

/**
 * Parse `host:port`. IPv6 literals may be wrapped in `[]`. Throws on a
 * malformed value — the gateway will surface that as an activation
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
