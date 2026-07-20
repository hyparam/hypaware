// @ts-check

/**
 * Pure profile construction for the Claude Desktop managed
 * third-party-inference config.
 *
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { DesktopManagedProfile, ProfileInputs } from './types.js'
 */

/**
 * The gateway's fixed default listen. Deliberately duplicated from
 * `@hypaware/ai-gateway` (plugins do not value-import each other);
 * a parity test asserts the two never drift.
 *
 * @ref LLP 0115#stable-endpoint-prerequisite [constrained-by]: the profile targets the LLP 0114 fixed default unless the fleet configures an explicit listen
 */
export const STABLE_DEFAULT_LISTEN = '127.0.0.1:18521'

/** macOS bundle id the managed-preferences payload keys under. */
export const DEFAULT_BUNDLE_ID = 'com.anthropic.claudefordesktop'

/**
 * Models served through the gateway, listed manually in the profile so
 * Desktop never probes `GET /v1/models` (the probe 401s subscription
 * OAuth tokens and wedges setup).
 *
 * @ref LLP 0115#manual-model-list [implements]
 */
export const DEFAULT_MODELS = Object.freeze([
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-haiku-4-5-20251001',
  'claude-fable-5',
])

/**
 * Resolve the stable gateway base URL the profile points at.
 *
 * Priority: `claude_desktop.endpoint` override, then the fleet's
 * explicit ai-gateway `listen`, then the fixed default. An ephemeral
 * (`:0`) listen is refused: Desktop's managed config cannot chase a
 * moving port, so rendering against it would ship a profile that
 * breaks on the next daemon restart.
 *
 * @param {{ hypConfig: HypAwareV2Config, sectionConfig: Record<string, unknown> }} opts
 * @returns {string}
 */
export function resolveGatewayBaseUrl(opts) {
  const override = opts.sectionConfig.endpoint
  if (typeof override === 'string' && override.length > 0) {
    assertNotEphemeral(override, 'claude_desktop.endpoint')
    if (!/^https?:\/\//.test(override)) {
      throw new Error(`claude_desktop.endpoint must be an http(s) URL, got '${override}'`)
    }
    return override.replace(/\/$/, '')
  }
  const gatewayEntry = (opts.hypConfig.plugins ?? []).find((p) => p.name === '@hypaware/ai-gateway')
  const listen = gatewayEntry?.config?.listen
  if (typeof listen === 'string' && listen.length > 0) {
    assertNotEphemeral(listen, 'ai-gateway listen')
    return `http://${listen}`
  }
  return `http://${STABLE_DEFAULT_LISTEN}`
}

/**
 * @param {string} value
 * @param {string} label
 */
function assertNotEphemeral(value, label) {
  if (/:0(?:$|\/)/.test(value)) {
    throw new Error(
      `${label} is ephemeral ('${value}'): a Desktop profile needs a stable port. `
      + 'Move the fleet config to the fixed default or an explicit fixed listen first (LLP 0115).',
    )
  }
}

/**
 * Build the managed 3P-inference payload. Everything here is
 * shippable in the clear: the credential itself stays behind the
 * helper command.
 *
 * @ref LLP 0116#profile-carries-no-secret [implements]: the profile holds only the helper reference, never a token or key
 * @param {ProfileInputs} inputs
 * @returns {DesktopManagedProfile}
 */
export function buildManagedProfile(inputs) {
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: inputs.baseUrl,
    inferenceGatewayAuthScheme: inputs.authScheme,
    inferenceModels: [...inputs.models],
    inferenceCredentialKind: 'helper',
    inferenceCredentialHelperPath: inputs.helperPath,
    inferenceCredentialHelperArgs: [...inputs.helperArgs],
  }
}

/**
 * Render the payload as a macOS managed-preferences plist dict for the
 * app's bundle domain. An MDM wraps this in its own profile envelope;
 * HypAware does not fabricate the envelope.
 *
 * @param {DesktopManagedProfile} profile
 * @returns {string}
 */
export function renderManagedPreferencesPlist(profile) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
  ]
  for (const [key, value] of Object.entries(profile)) {
    lines.push(`\t<key>${escapeXml(key)}</key>`)
    if (Array.isArray(value)) {
      lines.push('\t<array>')
      for (const item of value) lines.push(`\t\t<string>${escapeXml(item)}</string>`)
      lines.push('\t</array>')
    } else {
      lines.push(`\t<string>${escapeXml(value)}</string>`)
    }
  }
  lines.push('</dict>', '</plist>', '')
  return lines.join('\n')
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
