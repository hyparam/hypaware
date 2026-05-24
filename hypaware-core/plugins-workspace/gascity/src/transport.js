// @ts-check

/**
 * Transport injection for `@hypaware/gascity`.
 *
 * In production the source opens an HTTP/SSE connection per city
 * (`<api_url>/v0/city/<name>/events/stream`) and consumes lifecycle
 * frames. The HTTP path is not exercised by the V1 smoke suite —
 * `gascity_attach_writes_partition` boots an in-process fixture
 * supervisor and replaces the transport at the well-known global
 * key below.
 *
 * The key is a `Symbol.for(...)` so the smoke and the plugin can
 * agree on it across module realms (the smoke imports the plugin
 * through the kernel loader, not directly).
 */

export const TRANSPORT_SYMBOL = Symbol.for('hypaware-gascity:transport')

/** @import { GascityFrame, GascityCitySubscription, GascityTransport } from './types.d.ts' */

/**
 * Look up the active transport from the `globalThis` registry. The
 * default (HTTP/SSE) path is deliberately not implemented in V1 —
 * activation surfaces a no-op subscription if nothing is registered
 * so attach/detach still produce the spans the bead asks for.
 *
 * @returns {GascityTransport}
 */
export function getActiveTransport() {
  const slot = /** @type {Record<symbol, unknown>} */ (
    /** @type {unknown} */ (globalThis)
  )[TRANSPORT_SYMBOL]
  if (slot && typeof slot === 'object' && typeof (/** @type {GascityTransport} */ (slot)).subscribe === 'function') {
    return /** @type {GascityTransport} */ (slot)
  }
  return noopTransport
}

/** @type {GascityTransport} */
const noopTransport = {
  async subscribe() {
    return {
      async close() {},
    }
  },
}
