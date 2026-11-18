// @ts-check

import { CLAUDE_DESKTOP_CONFIG_SECTION, validateClaudeDesktopConfig } from './config.js'

/**
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

export const PLUGIN_NAME = '@hypaware/claude-desktop'

/**
 * Side-effect-free config-section export so the kernel apply path can
 * validate this plugin's block before activation.
 *
 * @type {{ section: string, validate: typeof validateClaudeDesktopConfig }}
 */
export const configSection = {
  section: CLAUDE_DESKTOP_CONFIG_SECTION,
  validate: validateClaudeDesktopConfig,
}

/**
 * Activate `@hypaware/claude-desktop`.
 *
 * The plugin is transcript ownership and nothing else: its manifest declares
 * the `claude-desktop` client (skill and agent directories, the transcript
 * entrypoints it owns) and the picker row, and the Claude provider's scheduled
 * backfill attributes Desktop sessions through that declaration. It registers
 * no commands and no runtime `ctx.clients` adapter, and the client descriptor
 * carries no `attach_probe`, so attach, detach and the reconciler stay inert
 * for it.
 *
 * @ref LLP 0358#onboarding [implements]: activation and transcript ownership need no credential
 * @ref LLP 0612#decision [implements]: the managed-profile commands are gone; the plugin only declares ownership
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: CLAUDE_DESKTOP_CONFIG_SECTION,
    validate: validateClaudeDesktopConfig,
  })

  ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')

  ctx.log.info('claude-desktop activated', { capture_mode: 'scheduled_transcript' })
}
