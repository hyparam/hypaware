// @ts-check

/**
 * @import { HypAwareV2Config } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Resolve the gateway endpoint from the active config's `@hypaware/ai-gateway`
 * `listen` directive, for callers that need the URL before the gateway source
 * is live in this process (`hyp attach`, the `init` walkthrough, and the
 * daemon's attach reconciler when `localEndpoint()` is not yet bindable). It is
 * the configured-`listen` fallback shared by all three so they can never derive
 * a different port from the same config.
 *
 * Returns `undefined` when the gateway plugin is absent, its config is not an
 * object, or `listen` is missing/malformed — the caller then falls back to a
 * placeholder or surfaces the gap.
 *
 * @param {HypAwareV2Config} config
 * @returns {string | undefined}
 */
export function configuredGatewayEndpoint(config) {
  const entry = config.plugins?.find((p) => p.name === '@hypaware/ai-gateway')
  const cfg = entry?.config
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return undefined
  const listen = /** @type {Record<string, unknown>} */ (cfg).listen
  if (typeof listen !== 'string') return undefined
  return endpointFromListen(listen)
}

/**
 * Turn a `host:port` listen directive into an `http://host:port` URL,
 * tolerating bracketed/bare IPv6 hosts. Returns `undefined` for a malformed
 * port or empty host.
 *
 * @param {string} listen
 * @returns {string | undefined}
 */
export function endpointFromListen(listen) {
  const idx = listen.lastIndexOf(':')
  if (idx === -1) return undefined
  const rawHost = listen.slice(0, idx)
  const rawPort = listen.slice(idx + 1)
  const port = Number.parseInt(rawPort, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort) {
    return undefined
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost
  if (host.length === 0) return undefined
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${formattedHost}:${port}`
}
