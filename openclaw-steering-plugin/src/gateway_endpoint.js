// HypAware's fixed default AI gateway listen address (LLP 0114#decision).
// This package cannot import `src/core/config/gateway_endpoint.js` - it runs
// inside OpenClaw's process, never HypAware's, and is not a HypAware kernel
// plugin (LLP 0161#package-layout) - so the value is mirrored here rather
// than imported.
const DEFAULT_GATEWAY_ENDPOINT = 'http://127.0.0.1:18521'

/**
 * The environment variable carrying the local AI gateway's `localEndpoint()`
 * value (LLP 0161#steering-plugin). Nothing on the HypAware side sets it:
 * this package runs inside OpenClaw's process, so the operator puts it in
 * `~/.openclaw/openclaw.json`'s `env` block (docs/ACCEPTANCE.md
 * `## openclaw_capture` states the step). Resolved once at plugin load,
 * matching `gateway.localEndpoint()`'s own "ask the live gateway" contract
 * as closely as a process with no access to the HypAware kernel can.
 */
export const GATEWAY_ENDPOINT_ENV_VAR = 'HYP_GATEWAY_ENDPOINT'

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveGatewayEndpoint(env = process.env) {
  const configured = env[GATEWAY_ENDPOINT_ENV_VAR]?.trim()
  return configured || DEFAULT_GATEWAY_ENDPOINT
}

export { DEFAULT_GATEWAY_ENDPOINT }
