// @ts-check

/**
 * @import { HypAwareV2Config } from '../../../hypaware-plugin-kernel-types.d.ts'
 */

/**
 * Resolve the gateway endpoint from the active config's `@hypaware/ai-gateway`
 * `listen` directive, for **manual** callers that need the URL before the
 * gateway source is live in this process (`hyp attach` and the `init`
 * walkthrough). It is the configured-`listen` fallback shared by both so they
 * can never derive a different port from the same config. The daemon's
 * auto-attach path deliberately does *not* use this fallback — involuntary
 * attach requires a proven-bound `localEndpoint()` so it never records a URL for
 * a port nothing bound (see `resolveClientActionSeam` in `daemon/runtime.js`).
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

/**
 * Extract the port (as a string) from an `http://host:port` endpoint URL, or
 * `undefined` when it is unparseable or carries no explicit port. The string
 * form matches `probeClientAttachFromDescriptor`'s recorded `port`, so the two
 * can be compared directly when validating a client's attach against the live
 * gateway (issue #277 / LLP 0086).
 *
 * @param {string | undefined} endpoint
 * @returns {string | undefined}
 */
export function portFromEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return undefined
  try {
    const port = new URL(endpoint).port
    return port.length > 0 ? port : undefined
  } catch {
    return undefined
  }
}
